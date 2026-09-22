import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { ShuttleError } from '@shuttle-lite/core';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations';

export type SqliteDatabase = Database.Database;

export interface OpenOptions {
  readonly path: string;
  readonly readonly?: boolean;
  /** Milliseconds a statement waits for a write lock before failing. */
  readonly busyTimeoutMs?: number;
}

/**
 * SQLite is the operational source of truth (docs/decisions.md D-004), so WAL
 * plus a busy timeout is what lets the web process read while the worker
 * writes. WAL files must stay on local disk; a network share corrupts them.
 */
export function openDatabase(options: OpenOptions): SqliteDatabase {
  const path = options.path === ':memory:' ? options.path : resolve(options.path);
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { readonly: options.readonly ?? false });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
  return db;
}

export function schemaVersion(db: SqliteDatabase): number {
  const row = db.pragma('user_version', { simple: true });
  return typeof row === 'number' ? row : 0;
}

export function migrate(db: SqliteDatabase): number {
  const current = schemaVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version,
  );
  for (const migration of pending) {
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    });
    apply();
  }
  return schemaVersion(db);
}

export function assertSchemaCurrent(db: SqliteDatabase): void {
  const version = schemaVersion(db);
  if (version !== LATEST_SCHEMA_VERSION) {
    throw new ShuttleError(
      'CONFIG_INVALID',
      `SQLite schemaが古いです (current=${version}, expected=${LATEST_SCHEMA_VERSION})。npm run db:migrate を実行してください。`,
    );
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function toBool(value: number | null | undefined): boolean {
  return value === 1;
}

export function fromBool(value: boolean): number {
  return value ? 1 : 0;
}

export function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
