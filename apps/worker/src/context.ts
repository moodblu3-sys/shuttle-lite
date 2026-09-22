import type { AppConfig, DestinationCatalogConfig } from '@shuttle-lite/config';
import { catalogFromDestinations, type BoxGateway, type BoxLayout } from '@shuttle-lite/box';
import { ShuttleError } from '@shuttle-lite/core';
import type { Logger, MigrationJob, MigrationProfile, Semaphore } from '@shuttle-lite/core';
import type { ShuttleStore } from '@shuttle-lite/db';
import type { SourceAdapter } from './source/adapter';

export interface WorkerContext {
  readonly config: AppConfig;
  readonly store: ShuttleStore;
  readonly gateway: BoxGateway;
  readonly catalog: DestinationCatalogConfig;
  readonly layout: BoxLayout;
  readonly logger: Logger;
  /** Shared by file level and part level work, as one global budget. */
  readonly fileGate: Semaphore;
  readonly chunkGate: Semaphore;
  readonly workerId: string;
}

export interface JobContext extends WorkerContext {
  readonly job: MigrationJob;
  readonly profile: MigrationProfile;
  /** Where the bytes come from. Local today, Box for Box-to-Box migration. */
  readonly source: SourceAdapter;
  readonly stagingFolderId: string;
  /** Whether transitions for this job should also enqueue telemetry. */
  readonly telemetry: boolean;
  readonly aiEnabled: boolean;
}

export function destinationKeys(ctx: WorkerContext): string[] {
  return ctx.catalog.entries.map((entry) => entry.key);
}

/** Old real jobs have no explicit destination selection; never fall back to samples. */
export function destinationsForJob(
  ctx: WorkerContext,
  jobId: string,
): Pick<WorkerContext, 'catalog' | 'layout'> {
  const snapshot = ctx.store.getJobDestinations(jobId);
  if (!snapshot) {
    if (ctx.config.box.mode === 'fake') return { catalog: ctx.catalog, layout: ctx.layout };
    throw new ShuttleError(
      'CONFIG_INVALID',
      'この移行にはBoxの移行先が設定されていません。「新しい移行」で移行先を選択してください。既存のファイルと履歴は残っています。',
    );
  }
  if (snapshot.mode !== ctx.config.box.mode)
    throw new ShuttleError('CONFIG_INVALID', '移行作成時とBoxの接続モードが異なります。');
  return {
    catalog: catalogFromDestinations(snapshot),
    layout: {
      ...ctx.layout,
      destinations: Object.fromEntries(
        snapshot.entries.map((entry) => [entry.key, entry.folderId]),
      ),
    },
  };
}
