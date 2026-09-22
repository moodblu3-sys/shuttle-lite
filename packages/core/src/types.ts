import type { ErrorCategory } from './errors';
import type { ItemState, Phase } from './state';

/**
 * What to do when the destination already holds a file with that name.
 * Box Shuttle never overwrites: it appends a unique suffix, or skips the file
 * so a later delta sync can pick it up. Shuttle Lite follows the same two
 * answers, chosen per job (docs/decisions.md D-017).
 */
export const CONFLICT_POLICIES = ['RENAME', 'SKIP'] as const;

export type ConflictPolicy = (typeof CONFLICT_POLICIES)[number];

export interface MigrationProfile {
  readonly id: string;
  readonly name: string;
  readonly sourceRootPath: string;
  readonly targetStagingFolderId: string;
  readonly destinationCatalogId: string;
  readonly proxyProfileName: string;
  readonly metadataTemplateKey: string;
  readonly fileConcurrency: number;
  readonly chunkConcurrency: number;
  readonly aiRoutingEnabled: boolean;
  readonly snowflakeLoggingEnabled: boolean;
  readonly conflictPolicy: ConflictPolicy;
  readonly createdAt: string;
}

export type JobState = 'QUEUED' | 'SCANNING' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'FAILED';

export interface MigrationJob {
  readonly id: string;
  readonly name: string | null;
  readonly profileId: string;
  readonly state: JobState;
  readonly operatorLabel: string;
  readonly testMode: boolean;
  readonly cleanupState: 'NONE' | 'REQUESTED' | 'RUNNING' | 'DONE' | 'FAILED';
  readonly cleanupMessage: string | null;
  readonly stagingFolderId: string | null;
  readonly pauseRequested: boolean;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly totalItems: number;
  readonly totalBytes: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastError: string | null;
  readonly lastErrorCategory: ErrorCategory | null;
}

export type UploadStrategy = 'DIRECT' | 'CHUNKED';

export interface MigrationItem {
  readonly id: string;
  readonly jobId: string;
  readonly sourceRelativePath: string;
  readonly sourceAbsolutePath: string;
  readonly sourceFileName: string;
  readonly sourceSize: number;
  readonly sourceModifiedAt: string;
  readonly sourceInode: string | null;
  readonly fileType: string;
  readonly sourceSha1: string | null;
  readonly scannedAt: string;
  readonly state: ItemState;
  readonly resumeState: ItemState | null;
  readonly stagingName: string | null;
  readonly uploadStrategy: UploadStrategy | null;
  readonly boxFileId: string | null;
  readonly boxFileVersionId: string | null;
  readonly boxSize: number | null;
  readonly boxSha1: string | null;
  readonly bytesTransferred: number;
  readonly transferVerifiedAt: string | null;
  readonly provenanceAppliedAt: string | null;
  readonly finalFolderId: string | null;
  readonly finalName: string | null;
  readonly completedAt: string | null;
  readonly attempts: number;
  readonly retryCount: number;
  readonly nextAttemptAt: string | null;
  readonly lastErrorCategory: ErrorCategory | null;
  readonly lastError: string | null;
  readonly updatedAt: string;
}

export interface UploadSessionRecord {
  readonly id: string;
  readonly itemId: string;
  readonly boxSessionId: string;
  readonly partSize: number;
  readonly totalParts: number;
  readonly expiresAt: string | null;
  readonly state: 'OPEN' | 'COMMITTING' | 'COMMITTED' | 'EXPIRED' | 'ABORTED';
  readonly commitAttempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UploadPartRecord {
  readonly sessionId: string;
  readonly partIndex: number;
  readonly offset: number;
  readonly size: number;
  readonly sha1: string | null;
  readonly boxPartId: string | null;
  readonly state: 'PENDING' | 'UPLOADED' | 'FAILED';
  readonly attempts: number;
  readonly updatedAt: string;
}

export interface ExtractionResultRecord {
  readonly id: string;
  readonly itemId: string;
  readonly attempt: number;
  readonly provider: string;
  readonly rawFields: Record<string, unknown>;
  readonly documentType: string | null;
  readonly businessDomain: string | null;
  readonly businessIdentifier: string | null;
  readonly effectiveDate: string | null;
  readonly suggestedDestinationKey: string | null;
  readonly suggestedTags: readonly string[];
  readonly reason: string | null;
  readonly confidence: number | null;
  readonly references: readonly string[];
  readonly createdAt: string;
}

export type RoutingDecisionState = 'SUGGESTED' | 'NEEDS_INPUT' | 'APPROVED' | 'SKIPPED' | 'STALE';

export interface RoutingDecisionRecord {
  readonly id: string;
  readonly itemId: string;
  readonly state: RoutingDecisionState;
  readonly suggestedDestinationKey: string | null;
  readonly suggestionSource: 'AI' | 'MANUAL' | 'FALLBACK';
  readonly suggestionReason: string | null;
  readonly approvedDestinationKey: string | null;
  readonly approvedMetadata: Record<string, unknown> | null;
  readonly approvedBoxFileId: string | null;
  readonly approvedBoxVersionId: string | null;
  readonly approvedSha1: string | null;
  readonly humanOverride: boolean;
  readonly operatorLabel: string | null;
  readonly approvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const COMMAND_TYPES = [
  'START_JOB',
  'PAUSE_JOB',
  'RESUME_JOB',
  'RESCAN_JOB',
  'RETRY_FAILED',
  'RETRY_ITEM',
  'APPROVE_ITEM',
  'SKIP_ITEM',
  'SEND_TO_REVIEW',
  'GENERATE_REPORT',
  'END_TEST',
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

export interface JobCommandRecord {
  readonly id: string;
  readonly jobId: string;
  readonly type: CommandType;
  readonly payload: Record<string, unknown>;
  readonly state: 'PENDING' | 'CLAIMED' | 'DONE' | 'REJECTED';
  readonly rejectionReason: string | null;
  readonly createdAt: string;
  readonly claimedAt: string | null;
  readonly completedAt: string | null;
}

export type EventStatus = 'STARTED' | 'PROGRESS' | 'SUCCEEDED' | 'RETRYING' | 'FAILED' | 'SKIPPED';

export interface MigrationEventRecord {
  readonly id: string;
  readonly jobId: string;
  readonly itemId: string | null;
  readonly phase: Phase;
  readonly status: EventStatus;
  readonly sizeBytes: number | null;
  readonly durationMs: number | null;
  readonly retryCount: number;
  readonly errorCategory: ErrorCategory | null;
  readonly boxFileId: string | null;
  readonly destinationKey: string | null;
  readonly aiUsed: boolean;
  readonly humanOverride: boolean;
  readonly message: string | null;
  readonly createdAt: string;
}

export interface OutboxRecord {
  readonly eventId: string;
  readonly jobId: string;
  readonly payload: Record<string, unknown>;
  readonly state: 'PENDING' | 'CLAIMED' | 'DELIVERED' | 'FAILED';
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
}

export interface DestinationEntry {
  readonly key: string;
  readonly label: string;
  readonly boxPath: string;
  readonly boxFolderId: string | null;
  readonly description?: string;
}

export interface DestinationCatalog {
  readonly id: string;
  readonly needsReviewKey: string;
  readonly entries: readonly DestinationEntry[];
}
