import type { AppConfig, DestinationCatalogConfig } from '@shuttle-lite/config';
import type { BoxGateway, BoxLayout } from '@shuttle-lite/box';
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
