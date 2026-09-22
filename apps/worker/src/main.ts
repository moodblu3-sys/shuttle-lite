import { hostname } from 'node:os';
import { createBoxGateway, ensureBoxLayout, loadCachedLayout } from '@shuttle-lite/box';
import {
  EMPTY_DESTINATION_CATALOG,
  loadConfig,
  loadDestinationCatalog,
} from '@shuttle-lite/config';
import { createLogger, randomId, Semaphore, toShuttleError } from '@shuttle-lite/core';
import { migrate, openDatabase, ShuttleStore } from '@shuttle-lite/db';
import { buildTelemetryPayload, createTelemetrySink, OutboxSender } from '@shuttle-lite/telemetry';
import type { WorkerContext } from './context';
import { WorkerRuntime } from './runtime';

async function main(): Promise<void> {
  const config = loadConfig();
  const workerId = `${hostname()}-${process.pid}-${randomId('w', 3)}`;
  const logger = createLogger(config.logLevel, { worker: workerId });

  logger.info('worker起動', {
    boxMode: config.box.mode,
    proxyMode: config.proxy.mode,
    telemetrySink: config.telemetry.sink,
    sqlite: config.sqlitePath,
  });

  const db = openDatabase({ path: config.sqlitePath });
  migrate(db);
  const store = new ShuttleStore(db, { telemetryPayload: buildTelemetryPayload });

  const catalog = config.box.mode === 'fake' ? loadDestinationCatalog() : EMPTY_DESTINATION_CATALOG;
  const gateway = createBoxGateway(config, logger);

  const identity = await gateway.whoAmI();
  logger.info('Box identity', { login: identity.login, mode: gateway.kind });

  const layout = loadCachedLayout(config) ?? (await ensureBoxLayout(gateway, config, catalog));
  logger.info('Box layout解決済み', {
    root: layout.rootFolderId,
    staging: layout.stagingRootFolderId,
    destinations: Object.keys(layout.destinations).length,
  });

  const ctx: WorkerContext = {
    config,
    store,
    gateway,
    catalog,
    layout,
    logger,
    fileGate: new Semaphore(config.limits.fileConcurrency),
    chunkGate: new Semaphore(config.limits.chunkConcurrency),
    workerId,
  };

  const sink = createTelemetrySink(config);
  const sender = new OutboxSender({
    store,
    sink,
    batchSize: config.telemetry.batchSize,
    logger,
  });
  const runtime = new WorkerRuntime(ctx);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdownを開始します', { signal });
    runtime.requestStop();
    sender.stop();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Telemetry delivery runs alongside the migration. A Snowflake outage only
  // grows the outbox backlog; it never stops the transfer.
  const senderLoop = sender.start().catch((error: unknown) => {
    logger.error('outbox senderが停止しました', { message: (error as Error).message });
  });

  await runtime.run();
  sender.stop();
  await senderLoop;
  await sender.close();
  await gateway.close();
  db.close();
  logger.info('worker停止');
}

main().catch((error: unknown) => {
  const shuttleError = toShuttleError(error);
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      msg: 'worker起動に失敗しました',
      category: shuttleError.category,
      message: shuttleError.message,
      operatorAction: shuttleError.operatorAction,
    })}\n`,
  );
  process.exitCode = 1;
});
