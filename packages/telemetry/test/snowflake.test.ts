import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConfig, parseEnv, type AppConfig } from '@shuttle-lite/config';
import {
  JsonlTelemetrySink,
  SnowflakeTelemetrySink,
  type TelemetryRecord,
} from '@shuttle-lite/telemetry';
import type { SnowflakeTransport } from '../src/snowflake';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const record: TelemetryRecord = {
  eventId: 'event-1',
  jobId: 'job-1',
  payload: { eventId: 'event-1', jobId: 'job-1', phase: 'SCAN', status: 'STARTED' },
};
const success = { status: 200, body: { sqlState: '00000', code: '090001' } };

describe('Snowflake SQL API telemetry', () => {
  let folder: string;
  let config: AppConfig;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'shuttle-snowflake-'));
    const keyPath = join(folder, 'test-only.pem');
    writeFileSync(
      keyPath,
      keys.privateKey.export({
        type: 'pkcs8',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase: 'test-only',
      }),
    );
    config = buildConfig(
      parseEnv({
        BOX_MODE: 'fake',
        TELEMETRY_SINK: 'snowflake',
        SNOWFLAKE_ACCOUNT: 'org-account',
        SNOWFLAKE_USERNAME: 'logger',
        SNOWFLAKE_DATABASE: 'DB',
        SNOWFLAKE_SCHEMA: 'PUBLIC',
        SNOWFLAKE_WAREHOUSE: 'WH',
        SNOWFLAKE_PRIVATE_KEY_PATH: keyPath,
        SNOWFLAKE_PRIVATE_KEY_PASSPHRASE: 'test-only',
      } as NodeJS.ProcessEnv),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(folder, { recursive: true, force: true });
  });

  it('signs a verifiable short-lived JWT and submits bound JSON with MERGE', async () => {
    const transport = vi.fn<SnowflakeTransport>().mockResolvedValue(success);
    await new SnowflakeTelemetrySink(config, transport).deliver([record]);
    const [path, method, headers, body] = transport.mock.calls[0]!;
    expect(path).toMatch(/requestId=[0-9a-f-]{36}&retry=true/);
    expect(method).toBe('POST');
    const [head, payload, signature] = headers.Authorization!.slice(7).split('.');
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${head}.${payload}`),
        keys.publicKey,
        Buffer.from(signature!, 'base64url'),
      ),
    ).toBe(true);
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    expect(claims.sub).toBe('ORG-ACCOUNT.LOGGER');
    expect(claims.exp - claims.iat).toBe(300);
    expect(claims.iss).toMatch(/^ORG-ACCOUNT.LOGGER.SHA256:/);
    const sql = JSON.parse(body!);
    expect(sql.statement).toContain('MERGE INTO SHUTTLE_LITE_EVENTS');
    expect(sql.statement).not.toContain(record.eventId);
    expect(sql.bindings['3']).toEqual({ type: 'TEXT', value: JSON.stringify(record.payload) });
    expect(body).not.toContain('test-only');
  });

  it('polls accepted statements before treating a record as delivered', async () => {
    const transport = vi
      .fn<SnowflakeTransport>()
      .mockResolvedValueOnce({ status: 202, body: { statementHandle: 'abc-123' } })
      .mockResolvedValueOnce(success);
    await new SnowflakeTelemetrySink(config, transport).deliver([record]);
    expect(transport.mock.calls[1]!.slice(0, 2)).toEqual(['/api/v2/statements/abc-123', 'GET']);
  });

  it('reuses a stable request ID across crashes, retries and changed batch boundaries', async () => {
    const transport = vi.fn<SnowflakeTransport>().mockResolvedValue(success);
    const second = {
      ...record,
      eventId: 'event-2',
      payload: { ...record.payload, eventId: 'event-2' },
    };
    const first = new SnowflakeTelemetrySink(config, transport);
    await first.deliver([record, second]);
    await new SnowflakeTelemetrySink(config, transport).deliver([second]);
    expect(transport.mock.calls[1]![0]).toBe(transport.mock.calls[2]![0]);
    expect(transport.mock.calls[0]![0]).not.toBe(transport.mock.calls[1]![0]);
  });

  it.each([401, 403, 422, 429, 500])(
    'does not acknowledge HTTP %s or leak the server body',
    async (status) => {
      const transport = vi
        .fn<SnowflakeTransport>()
        .mockResolvedValue({ status, body: { message: 'sensitive response', sqlState: '42000' } });
      await expect(new SnowflakeTelemetrySink(config, transport).deliver([record])).rejects.toThrow(
        `HTTP ${status}`,
      );
      await expect(
        new SnowflakeTelemetrySink(config, transport).deliver([record]),
      ).rejects.not.toThrow('sensitive response');
    },
  );

  it('leaves uncompleted async SQL retryable and never follows a server-provided foreign URL', async () => {
    const transport = vi
      .fn<SnowflakeTransport>()
      .mockResolvedValue({
        status: 202,
        body: { statementHandle: 'abc', statementStatusUrl: 'https://outside.example/steal' },
      });
    await expect(new SnowflakeTelemetrySink(config, transport).deliver([record])).rejects.toThrow(
      'HTTP 202',
    );
    expect(transport.mock.calls).toHaveLength(6);
    expect(transport.mock.calls.every(([path]) => path.startsWith('/api/v2/statements'))).toBe(
      true,
    );
  });

  it('does not deliver forbidden fields or allow SQL identifiers from unvalidated input', async () => {
    const transport = vi.fn<SnowflakeTransport>().mockResolvedValue(success);
    await expect(
      new SnowflakeTelemetrySink(config, transport).deliver([
        { ...record, payload: { accessToken: 'secret' } },
      ]),
    ).rejects.toThrow();
    const invalid = {
      ...config,
      telemetry: {
        ...config.telemetry,
        snowflake: { ...config.telemetry.snowflake, table: 'EVENTS; DROP TABLE X' },
      },
    };
    await expect(new SnowflakeTelemetrySink(invalid, transport).deliver([record])).rejects.toThrow(
      'テーブル名',
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it('retries local append errors and deduplicates after a new sink is created', async () => {
    const path = join(folder, 'events.jsonl');
    const sink = new JsonlTelemetrySink(path);
    mkdirSync(path); // represent a failed append without requiring root permission behavior
    await expect(sink.deliver([record])).rejects.toThrow();
    rmSync(path, { recursive: true });
    await sink.deliver([record]);
    await new JsonlTelemetrySink(path).deliver([record]);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});
