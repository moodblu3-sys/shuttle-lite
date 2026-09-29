import { hostname } from 'node:os';
import {
  BoxOAuth,
  createBoxGateway,
  ensureBoxLayout,
  loadCachedLayout,
  type BoxLayout,
} from '@shuttle-lite/box';
import {
  applyRuntimeSettings,
  EMPTY_DESTINATION_CATALOG,
  loadConfig,
  loadDestinationCatalog,
} from '@shuttle-lite/config';
import {
  createLogger,
  randomId,
  Semaphore,
  ShuttleError,
  toShuttleError,
} from '@shuttle-lite/core';
import { AuthStore, migrate, openDatabase, ShuttleStore } from '@shuttle-lite/db';
import {
  buildTelemetryPayload,
  ConfiguredTelemetrySink,
  OutboxSender,
} from '@shuttle-lite/telemetry';
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
  const oauth =
    config.env.BOX_AUTH_MODE === 'oauth'
      ? new BoxOAuth(config, new AuthStore(db, config.env.SHUTTLE_AUTH_KEY!))
      : null;
  // No process-wide Box identity in OAuth mode, even before a user has logged in.
  const gateway = createBoxGateway(
    oauth
      ? {
          ...config,
          box: {
            ...config.box,
            accessToken: undefined,
            tokenProvider: async () => {
              throw new ShuttleError('BOX_AUTH', '移行の実行ユーザーが未指定です。');
            },
          },
        }
      : config,
    logger,
  );

  if (!oauth) {
    const identity = await gateway.whoAmI();
    logger.info('Box identity', { login: identity.login, mode: gateway.kind });
  }

  const layout: BoxLayout = oauth
    ? {
        rootFolderId: '',
        stagingRootFolderId: '',
        needsReviewFolderId: '',
        reportsFolderId: '',
        destinations: {},
        resolvedAt: '',
        mode: 'real',
      }
    : (loadCachedLayout(config) ?? (await ensureBoxLayout(gateway, config, catalog)));
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
    ...(oauth
      ? {
          resolveJobContext: async (jobId: string) => {
            const userId = store.jobOwner(jobId);
            if (!userId)
              throw new ShuttleError(
                'BOX_AUTH',
                'この移行には認証済みの実行者が記録されていません。新しい移行を作成してください。',
              );
            const userConfig = applyRuntimeSettings(
              oauth.userConfig(userId),
              store.getRuntimeSettings().settings,
            );
            await oauth.accessToken(userId);
            const userGateway = oauth.gateway(userId);
            const userLayout =
              loadCachedLayout(userConfig) ??
              (await ensureBoxLayout(userGateway, userConfig, catalog));
            return { config: userConfig, gateway: userGateway, layout: userLayout };
          },
        }
      : {}),
  };

  const sink = new ConfiguredTelemetrySink(() =>
    applyRuntimeSettings(config, store.getRuntimeSettings().settings),
  );
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
  await oauth?.close();
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
