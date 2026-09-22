import {
  loadConfig,
  loadDestinationCatalog,
  type AppConfig,
  type DestinationCatalogConfig,
} from '@shuttle-lite/config';
import { migrate, openDatabase, ShuttleStore } from '@shuttle-lite/db';
import { buildTelemetryPayload } from '@shuttle-lite/telemetry';

interface WebRuntime {
  config: AppConfig;
  store: ShuttleStore;
  catalog: DestinationCatalogConfig;
}

declare global {
  var __shuttleLiteWeb: WebRuntime | undefined;
}

/**
 * The web process opens the same SQLite file as the worker. WAL mode makes
 * concurrent reads safe. This process only reads and appends commands; it
 * never performs migration work (docs/decisions.md D-003).
 */
export function getRuntime(): WebRuntime {
  if (globalThis.__shuttleLiteWeb) return globalThis.__shuttleLiteWeb;
  const config = loadConfig();
  const db = openDatabase({ path: config.sqlitePath });
  migrate(db);
  const runtime: WebRuntime = {
    config,
    store: new ShuttleStore(db, { telemetryPayload: buildTelemetryPayload }),
    catalog: loadDestinationCatalog(),
  };
  globalThis.__shuttleLiteWeb = runtime;
  return runtime;
}

export function getStore(): ShuttleStore {
  return getRuntime().store;
}

export function getConfig(): AppConfig {
  return getRuntime().config;
}

export function getCatalog(): DestinationCatalogConfig {
  return getRuntime().catalog;
}
