import { dirname, isAbsolute, join } from 'node:path';
import { ShuttleError } from '@shuttle-lite/core';
import type { AppConfig } from './env';
import { RuntimeSettingsSchema, type RuntimeSettings } from './settings-schema';

export function settingsFromConfig(config: AppConfig): RuntimeSettings {
  const snow = config.telemetry.snowflake;
  return {
    aiEnabled: config.ai.enabled,
    fileConcurrency: config.limits.fileConcurrency,
    chunkConcurrency: config.limits.chunkConcurrency,
    logSink: config.telemetry.sink,
    logFolder: dirname(config.telemetry.jsonlPath),
    snowflake: {
      account: snow.account ?? '',
      username: snow.username ?? '',
      warehouse: snow.warehouse ?? '',
      database: snow.database ?? '',
      schema: snow.schema ?? '',
      role: snow.role ?? '',
      table: snow.table ?? 'SHUTTLE_LITE_EVENTS',
    },
  };
}

export function parseRuntimeSettings(input: unknown): RuntimeSettings {
  const parsed = RuntimeSettingsSchema.safeParse(input);
  if (!parsed.success || !isAbsolute(parsed.data.logFolder)) {
    throw new ShuttleError(
      'CONFIG_INVALID',
      '設定値を確認してください。並列数はファイル1〜5、分割転送1〜4です。',
    );
  }
  return parsed.data;
}

export function applyRuntimeSettings(base: AppConfig, input: unknown): AppConfig {
  if (input === null || input === undefined) return base;
  const value = parseRuntimeSettings(input);
  return {
    ...base,
    ai: { ...base.ai, enabled: value.aiEnabled },
    limits: {
      ...base.limits,
      fileConcurrency: value.fileConcurrency,
      chunkConcurrency: value.chunkConcurrency,
    },
    telemetry: {
      ...base.telemetry,
      sink: value.logSink,
      jsonlPath: join(value.logFolder, 'events.jsonl'),
      snowflake: { ...base.telemetry.snowflake, ...value.snowflake },
    },
  };
}

export function assertSnowflakeConfigured(config: AppConfig): void {
  const snow = config.telemetry.snowflake;
  if (!snow.account || !snow.username || !snow.warehouse || !snow.database || !snow.schema) {
    throw new ShuttleError(
      'CONFIG_INVALID',
      'Snowflakeのアカウント・ユーザー・ウェアハウス・データベース・スキーマを入力してください。',
    );
  }
  if (!snow.privateKeyPath) {
    throw new ShuttleError(
      'CONFIG_INVALID',
      'Snowflakeの秘密鍵が未設定です。Macの.envにSNOWFLAKE_PRIVATE_KEY_PATHを設定して再起動してください。',
    );
  }
}
