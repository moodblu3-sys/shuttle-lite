import {
  applyRuntimeSettings,
  EMPTY_DESTINATION_CATALOG,
  loadConfig,
  loadDestinationCatalog,
  type AppConfig,
  type DestinationCatalogConfig,
} from '@shuttle-lite/config';
import { catalogFromDestinations, createBoxGateway, type BoxGateway } from '@shuttle-lite/box';
import { migrate, openDatabase, ShuttleStore } from '@shuttle-lite/db';
import { buildTelemetryPayload } from '@shuttle-lite/telemetry';

interface WebRuntime {
  config: AppConfig;
  store: ShuttleStore;
  catalog: DestinationCatalogConfig;
  gateway?: BoxGateway;
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
    catalog: config.box.mode === 'fake' ? loadDestinationCatalog() : EMPTY_DESTINATION_CATALOG,
  };
  globalThis.__shuttleLiteWeb = runtime;
  return runtime;
}

export function getStore(): ShuttleStore {
  return getRuntime().store;
}

export function getConfig(): AppConfig {
  const runtime = getRuntime();
  return applyRuntimeSettings(runtime.config, runtime.store.getRuntimeSettings().settings);
}

export function getCatalog(jobId?: string): DestinationCatalogConfig {
  const runtime = getRuntime();
  const snapshot = jobId ? runtime.store.getJobDestinations(jobId) : null;
  if (snapshot)
    return snapshot.mode === runtime.config.box.mode
      ? catalogFromDestinations(snapshot)
      : EMPTY_DESTINATION_CATALOG;
  return runtime.catalog;
}

/** Read-only Box browsing uses the same local credentials/proxy as the worker. */
export function getBoxGateway(): BoxGateway {
  const runtime = getRuntime();
  return (runtime.gateway ??= createBoxGateway(runtime.config));
}
