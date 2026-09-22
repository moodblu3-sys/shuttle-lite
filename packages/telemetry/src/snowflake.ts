import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assertSnowflakeConfigured, createDispatcher, type AppConfig } from '@shuttle-lite/config';
import { ShuttleError, sleep } from '@shuttle-lite/core';
import { assertPayloadAllowlisted } from './payload';
import type { TelemetryRecord, TelemetrySink } from './sink';

interface SqlResponse {
  status: number;
  body: Record<string, unknown>;
}
export type SnowflakeTransport = (
  path: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body?: string,
) => Promise<SqlResponse>;

function failure(message: string): ShuttleError {
  return new ShuttleError('TELEMETRY_DELIVERY', message);
}

export function snowflakeJwt(config: AppConfig): string {
  assertSnowflakeConfigured(config);
  const snow = config.telemetry.snowflake;
  try {
    const key = createPrivateKey({
      key: readFileSync(snow.privateKeyPath!),
      passphrase: snow.privateKeyPassphrase,
    });
    if (key.asymmetricKeyType !== 'rsa') throw new Error('RSA required');
    const publicDer = createPublicKey(key).export({ type: 'spki', format: 'der' });
    const fingerprint = createHash('sha256').update(publicDer).digest('base64');
    // Locator.region.cloud addresses use the locator in JWT; org-account identifiers remain intact.
    const account = snow.account!.split('.')[0]!.toUpperCase();
    const subject = `${account}.${snow.username!.toUpperCase()}`;
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: `${subject}.SHA256:${fingerprint}`,
      sub: subject,
      iat: now,
      exp: now + 300,
    })}`;
    return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
  } catch {
    throw failure(
      'Snowflakeの秘密鍵を読み込めません。鍵の形式・権限・パスフレーズを確認してください。',
    );
  }
}

function tableName(config: AppConfig): string {
  const value = config.telemetry.snowflake.table ?? 'SHUTTLE_LITE_EVENTS';
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) throw failure('Snowflakeのテーブル名が不正です。');
  return value.toUpperCase();
}

/** SQL API with event IDs, bound JSON and MERGE; no account objects are created here. */
export class SnowflakeTelemetrySink implements TelemetrySink {
  readonly name = 'snowflake';
  readonly #config: AppConfig;
  readonly #transport?: SnowflakeTransport;
  #bundle?: ReturnType<typeof createDispatcher>;

  constructor(config: AppConfig, transport?: SnowflakeTransport) {
    this.#config = config;
    this.#transport = transport;
  }

  async #request(path: string, method: 'GET' | 'POST', body?: string): Promise<SqlResponse> {
    const headers = {
      Authorization: `Bearer ${snowflakeJwt(this.#config)}`,
      'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'ShuttleLite/0.1',
    };
    try {
      if (this.#transport) return await this.#transport(path, method, headers, body);
      const account = this.#config.telemetry.snowflake.account!;
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(account)) throw new Error('Invalid account');
      const origin = `https://${account.toLowerCase()}.snowflakecomputing.com`;
      this.#bundle ??= createDispatcher(this.#config.proxy, origin);
      const response = await this.#bundle.dispatcher.request({
        origin,
        path,
        method,
        headers,
        body,
        headersTimeout: 60_000,
        bodyTimeout: 60_000,
        signal: AbortSignal.timeout(65_000),
      });
      return {
        status: response.statusCode,
        body: (await response.body.json()) as Record<string, unknown>,
      };
    } catch {
      // Transport/server messages can echo SQL bindings, headers or proxy credentials.
      throw failure('Snowflakeに通信できません。認証情報・ネットワーク設定を確認してください。');
    }
  }

  async deliver(records: readonly TelemetryRecord[]): Promise<void> {
    assertSnowflakeConfigured(this.#config);
    const snow = this.#config.telemetry.snowflake;
    const table = tableName(this.#config);
    for (const record of records) {
      assertPayloadAllowlisted(record.payload);
      const statement = `MERGE INTO ${table} t USING (SELECT ? AS EVENT_ID, ? AS JOB_ID, PARSE_JSON(?) AS PAYLOAD) s ON t.EVENT_ID = s.EVENT_ID WHEN NOT MATCHED THEN INSERT (EVENT_ID, JOB_ID, PAYLOAD) VALUES (s.EVENT_ID, s.JOB_ID, s.PAYLOAD)`;
      const body = JSON.stringify({
        statement,
        timeout: 60,
        warehouse: snow.warehouse,
        database: snow.database,
        schema: snow.schema,
        ...(snow.role ? { role: snow.role } : {}),
        bindings: {
          '1': { type: 'TEXT', value: record.eventId },
          '2': { type: 'TEXT', value: record.jobId },
          '3': { type: 'TEXT', value: JSON.stringify(record.payload) },
        },
      });
      // Stable across restarts/partial batches. MERGE is also safe after request-history expiry.
      const bytes = createHash('sha256').update(`${snow.account}:${body}`).digest().subarray(0, 16);
      bytes[6] = (bytes[6]! & 15) | 80;
      bytes[8] = (bytes[8]! & 63) | 128;
      const hex = bytes.toString('hex');
      const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      let result = await this.#request(
        `/api/v2/statements?requestId=${requestId}&retry=true`,
        'POST',
        body,
      );
      for (let polls = 0; result.status === 202 && polls < 5; polls += 1) {
        const handle = result.body.statementHandle;
        if (typeof handle !== 'string' || !/^[a-zA-Z0-9-]+$/.test(handle)) {
          throw failure('Snowflakeの実行状態を取得できません。ログは再送待ちです。');
        }
        await sleep(200);
        result = await this.#request(`/api/v2/statements/${handle}`, 'GET');
      }
      if (result.status !== 200 || result.body.sqlState !== '00000') {
        throw failure(
          `Snowflakeへのログ送信が完了していません（HTTP ${result.status}）。認証・テーブル・権限を確認してください。`,
        );
      }
    }
  }

  async close(): Promise<void> {
    await this.#bundle?.dispatcher.close();
  }
}
