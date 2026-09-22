import { existsSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { ShuttleError, unsafeStatePathReason, type LogLevel } from '@shuttle-lite/core';
import { fromRepoRoot, resolvePath } from './paths';

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()),
  );

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim()));

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

export const EnvSchema = z.object({
  BOX_MODE: z.enum(['fake', 'real']).default('fake'),
  SHUTTLE_DATA_DIR: z.string().default('.shuttle-lite'),
  SQLITE_PATH: z.string().default('.shuttle-lite/shuttle-lite.db'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  BOX_CLIENT_ID: optionalString,
  BOX_CLIENT_SECRET: optionalString,
  BOX_ENTERPRISE_ID: optionalString,
  BOX_ACCESS_TOKEN: optionalString.refine(
    (value) => value === undefined || !/\s/.test(value),
    'BOX_ACCESS_TOKEN は Bearer を付けず、トークン本体だけを指定してください',
  ),
  BOX_API_BASE_URL: z.string().url().default('https://api.box.com/2.0'),
  BOX_UPLOAD_BASE_URL: z.string().url().default('https://upload.box.com/api/2.0'),
  BOX_AUTH_BASE_URL: z.string().url().default('https://api.box.com/oauth2'),
  BOX_METADATA_TEMPLATE_KEY: z.string().default('shuttleLiteMigration'),
  BOX_METADATA_SCOPE: z.string().default('enterprise'),
  BOX_ROOT_FOLDER_ID: optionalString,
  BOX_STAGING_FOLDER_ID: optionalString,
  BOX_NEEDS_REVIEW_FOLDER_ID: optionalString,
  BOX_REPORTS_FOLDER_ID: optionalString,

  PROXY_MODE: z.enum(['off', 'preferred', 'required']).default('off'),
  PROXY_URL: optionalString,
  PROXY_AUTH_MODE: z.enum(['none', 'basic']).default('none'),
  PROXY_USERNAME: optionalString,
  PROXY_PASSWORD: optionalString,
  PROXY_CA_BUNDLE_PATH: optionalString,
  NO_PROXY: z.string().default('localhost,127.0.0.1'),

  FILE_CONCURRENCY: positiveInt(3),
  CHUNK_CONCURRENCY: positiveInt(3),
  DIRECT_UPLOAD_MAX_BYTES: positiveInt(50 * 1024 * 1024),
  MAX_FILE_BYTES: positiveInt(15 * 1024 * 1024 * 1024),
  MAX_ATTEMPTS: positiveInt(5),

  AI_ROUTING_ENABLED: boolish.default(true),
  AI_MAX_ATTEMPTS: positiveInt(4),

  TELEMETRY_SINK: z.enum(['jsonl', 'snowflake']).default('jsonl'),
  TELEMETRY_BATCH_SIZE: positiveInt(50),
  SNOWFLAKE_ACCOUNT: optionalString,
  SNOWFLAKE_USERNAME: optionalString,
  SNOWFLAKE_ROLE: optionalString,
  SNOWFLAKE_WAREHOUSE: optionalString,
  SNOWFLAKE_DATABASE: optionalString,
  SNOWFLAKE_SCHEMA: optionalString,
  SNOWFLAKE_PRIVATE_KEY_PATH: optionalString,

  // Escape hatch for a deliberate, understood exception to the WAL placement
  // rule. Off by default: a corrupted WAL loses operational state.
  ALLOW_UNSAFE_STATE_PATH: boolish.default(false),

  FAKE_BOX_AI_PENDING_FIRST_CALL: boolish.default(false),
  FAKE_BOX_RATE_LIMIT_EVERY: z.coerce.number().int().min(0).default(0),
  FAKE_BOX_LATENCY_MS: z.coerce.number().int().min(0).default(0),
});

export type Env = z.infer<typeof EnvSchema>;

export interface BoxConfig {
  readonly mode: 'fake' | 'real';
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly enterpriseId?: string;
  /** Explicit token takes precedence over CCG; it is never refreshed automatically. */
  readonly accessToken?: string;
  readonly apiBaseUrl: string;
  readonly uploadBaseUrl: string;
  readonly authBaseUrl: string;
  readonly metadataTemplateKey: string;
  readonly metadataScope: string;
  readonly rootFolderId?: string;
  readonly stagingFolderId?: string;
  readonly needsReviewFolderId?: string;
  readonly reportsFolderId?: string;
}

export interface ProxyProfile {
  readonly name: string;
  readonly mode: 'off' | 'preferred' | 'required';
  readonly url?: string;
  readonly authMode: 'none' | 'basic';
  /**
   * Held in memory only. Never written to a profile row, an event payload or
   * a log line (docs/requirements.md section 4.1).
   */
  readonly username?: string;
  readonly password?: string;
  readonly caBundlePath?: string;
  readonly noProxy: readonly string[];
}

export interface LimitsConfig {
  readonly fileConcurrency: number;
  readonly chunkConcurrency: number;
  readonly directUploadMaxBytes: number;
  readonly maxFileBytes: number;
  readonly maxAttempts: number;
}

export interface TelemetryConfig {
  readonly sink: 'jsonl' | 'snowflake';
  readonly batchSize: number;
  readonly jsonlPath: string;
  readonly snowflake: {
    readonly account?: string;
    readonly username?: string;
    readonly role?: string;
    readonly warehouse?: string;
    readonly database?: string;
    readonly schema?: string;
    readonly privateKeyPath?: string;
  };
}

export interface FakeBoxConfig {
  readonly rootDir: string;
  readonly aiPendingFirstCall: boolean;
  readonly rateLimitEvery: number;
  readonly latencyMs: number;
}

export interface AppConfig {
  readonly env: Env;
  readonly dataDir: string;
  readonly sqlitePath: string;
  readonly logLevel: LogLevel;
  readonly box: BoxConfig;
  readonly proxy: ProxyProfile;
  readonly limits: LimitsConfig;
  readonly ai: { readonly enabled: boolean; readonly maxAttempts: number };
  readonly telemetry: TelemetryConfig;
  readonly fakeBox: FakeBoxConfig;
  readonly reportsDir: string;
}

function crossFieldChecks(env: Env): string[] {
  const problems: string[] = [];
  if (env.BOX_MODE === 'real' && !env.BOX_ACCESS_TOKEN) {
    if (!env.BOX_CLIENT_ID) problems.push('BOX_MODE=real には BOX_CLIENT_ID が必要です');
    if (!env.BOX_CLIENT_SECRET) problems.push('BOX_MODE=real には BOX_CLIENT_SECRET が必要です');
    if (!env.BOX_ENTERPRISE_ID) problems.push('BOX_MODE=real には BOX_ENTERPRISE_ID が必要です');
    // BOX_ROOT_FOLDER_ID は必須にしない。未設定のときは Service Account の root へ
    // `/Shuttle Lite` を作る。必須にすると、その folder を作るための bootstrap を
    // 実行できなくなる。
  }
  if (env.PROXY_MODE === 'required' && !env.PROXY_URL) {
    problems.push('PROXY_MODE=required には PROXY_URL が必要です');
  }
  if (env.PROXY_AUTH_MODE === 'basic' && (!env.PROXY_USERNAME || !env.PROXY_PASSWORD)) {
    problems.push('PROXY_AUTH_MODE=basic には PROXY_USERNAME と PROXY_PASSWORD が必要です');
  }
  if (env.PROXY_CA_BUNDLE_PATH && !existsSync(resolvePath(env.PROXY_CA_BUNDLE_PATH))) {
    problems.push(`PROXY_CA_BUNDLE_PATH のfileが見つかりません: ${env.PROXY_CA_BUNDLE_PATH}`);
  }
  if (!env.ALLOW_UNSAFE_STATE_PATH) {
    // Check the raw value too: a Windows UNC path is not "absolute" to a
    // POSIX resolver, so resolving first would hide it.
    const reason =
      unsafeStatePathReason(env.SQLITE_PATH) ?? unsafeStatePathReason(resolvePath(env.SQLITE_PATH));
    if (reason) {
      problems.push(
        `SQLITE_PATH を local disk へ置いてください。${reason}。WAL fileが壊れる恐れがあります。意図的な場合は ALLOW_UNSAFE_STATE_PATH=true を設定してください。`,
      );
    }
  }
  if (env.TELEMETRY_SINK === 'snowflake') {
    for (const key of [
      'SNOWFLAKE_ACCOUNT',
      'SNOWFLAKE_USERNAME',
      'SNOWFLAKE_DATABASE',
      'SNOWFLAKE_SCHEMA',
    ] as const) {
      if (!env[key]) problems.push(`TELEMETRY_SINK=snowflake には ${key} が必要です`);
    }
  }
  return problems;
}

export function buildConfig(env: Env): AppConfig {
  const dataDir = resolvePath(env.SHUTTLE_DATA_DIR);
  return {
    env,
    dataDir,
    sqlitePath: resolvePath(env.SQLITE_PATH),
    logLevel: env.LOG_LEVEL,
    box: {
      mode: env.BOX_MODE,
      clientId: env.BOX_CLIENT_ID,
      clientSecret: env.BOX_CLIENT_SECRET,
      enterpriseId: env.BOX_ENTERPRISE_ID,
      accessToken: env.BOX_ACCESS_TOKEN,
      apiBaseUrl: env.BOX_API_BASE_URL.replace(/\/$/, ''),
      uploadBaseUrl: env.BOX_UPLOAD_BASE_URL.replace(/\/$/, ''),
      authBaseUrl: env.BOX_AUTH_BASE_URL.replace(/\/$/, ''),
      metadataTemplateKey: env.BOX_METADATA_TEMPLATE_KEY,
      metadataScope: env.BOX_METADATA_SCOPE,
      rootFolderId: env.BOX_ROOT_FOLDER_ID,
      stagingFolderId: env.BOX_STAGING_FOLDER_ID,
      needsReviewFolderId: env.BOX_NEEDS_REVIEW_FOLDER_ID,
      reportsFolderId: env.BOX_REPORTS_FOLDER_ID,
    },
    proxy: {
      name: env.PROXY_MODE === 'off' ? 'none' : (env.PROXY_URL ?? 'unset'),
      mode: env.PROXY_MODE,
      url: env.PROXY_URL,
      authMode: env.PROXY_AUTH_MODE,
      username: env.PROXY_USERNAME,
      password: env.PROXY_PASSWORD,
      caBundlePath: env.PROXY_CA_BUNDLE_PATH ? resolvePath(env.PROXY_CA_BUNDLE_PATH) : undefined,
      noProxy: env.NO_PROXY.split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    },
    limits: {
      fileConcurrency: env.FILE_CONCURRENCY,
      chunkConcurrency: env.CHUNK_CONCURRENCY,
      directUploadMaxBytes: env.DIRECT_UPLOAD_MAX_BYTES,
      maxFileBytes: env.MAX_FILE_BYTES,
      maxAttempts: env.MAX_ATTEMPTS,
    },
    ai: { enabled: env.AI_ROUTING_ENABLED, maxAttempts: env.AI_MAX_ATTEMPTS },
    telemetry: {
      sink: env.TELEMETRY_SINK,
      batchSize: env.TELEMETRY_BATCH_SIZE,
      jsonlPath: `${dataDir}/telemetry/events.jsonl`,
      snowflake: {
        account: env.SNOWFLAKE_ACCOUNT,
        username: env.SNOWFLAKE_USERNAME,
        role: env.SNOWFLAKE_ROLE,
        warehouse: env.SNOWFLAKE_WAREHOUSE,
        database: env.SNOWFLAKE_DATABASE,
        schema: env.SNOWFLAKE_SCHEMA,
        privateKeyPath: env.SNOWFLAKE_PRIVATE_KEY_PATH,
      },
    },
    fakeBox: {
      rootDir: `${dataDir}/fake-box`,
      aiPendingFirstCall: env.FAKE_BOX_AI_PENDING_FIRST_CALL,
      rateLimitEvery: env.FAKE_BOX_RATE_LIMIT_EVERY,
      latencyMs: env.FAKE_BOX_LATENCY_MS,
    },
    reportsDir: `${dataDir}/reports`,
  };
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ShuttleError('CONFIG_INVALID', `環境変数の検証に失敗しました\n${details}`);
  }
  const problems = crossFieldChecks(parsed.data);
  if (problems.length > 0) {
    throw new ShuttleError('CONFIG_INVALID', `設定の組み合わせが不正です\n${problems.join('\n')}`);
  }
  return parsed.data;
}

let cached: AppConfig | null = null;

/**
 * Loads `.env` from the repository root once per process. Credentials stay in
 * the environment and are never persisted to SQLite.
 */
export function loadConfig(options: { reload?: boolean } = {}): AppConfig {
  if (cached && !options.reload) return cached;
  loadDotenv({ path: fromRepoRoot('.env'), quiet: true });
  cached = buildConfig(parseEnv());
  return cached;
}
