export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY_PATTERN =
  /(secret|password|token|authorization|credential|privatekey|private_key|apikey|api_key)/i;

/** Never let a credential reach a log line or an event payload. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redact(entry, depth + 1);
  }
  return out;
}

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(
  level: LogLevel = 'info',
  base: Record<string, unknown> = {},
  sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const write = (entryLevel: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (LEVEL_WEIGHT[entryLevel] < LEVEL_WEIGHT[level]) return;
    const payload = {
      t: new Date().toISOString(),
      level: entryLevel,
      msg: message,
      ...(redact(base) as Record<string, unknown>),
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    sink(JSON.stringify(payload));
  };
  return {
    level,
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (fields) => createLogger(level, { ...base, ...fields }, sink),
  };
}
