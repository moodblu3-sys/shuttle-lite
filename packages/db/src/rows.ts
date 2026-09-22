import type {
  ErrorCategory,
  EventStatus,
  ExtractionResultRecord,
  ItemState,
  JobCommandRecord,
  JobState,
  MigrationEventRecord,
  MigrationItem,
  MigrationJob,
  MigrationProfile,
  OutboxRecord,
  Phase,
  RoutingDecisionRecord,
  UploadPartRecord,
  UploadSessionRecord,
} from '@shuttle-lite/core';
import { parseJson, toBool } from './sqlite';

export interface ProfileRow {
  id: string;
  name: string;
  source_root_path: string;
  target_staging_folder_id: string;
  destination_catalog_id: string;
  proxy_profile_name: string;
  metadata_template_key: string;
  file_concurrency: number;
  chunk_concurrency: number;
  ai_routing_enabled: number;
  snowflake_logging_enabled: number;
  conflict_policy: string;
  created_at: string;
}

export function mapProfile(row: ProfileRow): MigrationProfile {
  return {
    id: row.id,
    name: row.name,
    sourceRootPath: row.source_root_path,
    targetStagingFolderId: row.target_staging_folder_id,
    destinationCatalogId: row.destination_catalog_id,
    proxyProfileName: row.proxy_profile_name,
    metadataTemplateKey: row.metadata_template_key,
    fileConcurrency: row.file_concurrency,
    chunkConcurrency: row.chunk_concurrency,
    aiRoutingEnabled: toBool(row.ai_routing_enabled),
    snowflakeLoggingEnabled: toBool(row.snowflake_logging_enabled),
    conflictPolicy: row.conflict_policy === 'SKIP' ? 'SKIP' : 'RENAME',
    createdAt: row.created_at,
  };
}

export interface JobRow {
  id: string;
  name: string | null;
  profile_id: string;
  state: string;
  operator_label: string;
  staging_folder_id: string | null;
  pause_requested: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  total_items: number;
  total_bytes: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  last_error: string | null;
  last_error_category: string | null;
}

export function mapJob(row: JobRow): MigrationJob {
  return {
    id: row.id,
    name: row.name,
    profileId: row.profile_id,
    state: row.state as JobState,
    operatorLabel: row.operator_label,
    stagingFolderId: row.staging_folder_id,
    pauseRequested: toBool(row.pause_requested),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    totalItems: row.total_items,
    totalBytes: row.total_bytes,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
    lastErrorCategory: row.last_error_category as ErrorCategory | null,
  };
}

export interface ItemRow {
  id: string;
  job_id: string;
  source_relative_path: string;
  source_absolute_path: string;
  source_file_name: string;
  source_size: number;
  source_modified_at: string;
  source_inode: string | null;
  file_type: string;
  source_sha1: string | null;
  scanned_at: string;
  state: string;
  resume_state: string | null;
  staging_name: string | null;
  upload_strategy: string | null;
  box_file_id: string | null;
  box_file_version_id: string | null;
  box_size: number | null;
  box_sha1: string | null;
  bytes_transferred: number;
  transfer_verified_at: string | null;
  provenance_applied_at: string | null;
  final_folder_id: string | null;
  final_name: string | null;
  completed_at: string | null;
  attempts: number;
  retry_count: number;
  next_attempt_at: string | null;
  last_error_category: string | null;
  last_error: string | null;
  updated_at: string;
}

export function mapItem(row: ItemRow): MigrationItem {
  return {
    id: row.id,
    jobId: row.job_id,
    sourceRelativePath: row.source_relative_path,
    sourceAbsolutePath: row.source_absolute_path,
    sourceFileName: row.source_file_name,
    sourceSize: row.source_size,
    sourceModifiedAt: row.source_modified_at,
    sourceInode: row.source_inode,
    fileType: row.file_type,
    sourceSha1: row.source_sha1,
    scannedAt: row.scanned_at,
    state: row.state as ItemState,
    resumeState: row.resume_state as ItemState | null,
    stagingName: row.staging_name,
    uploadStrategy: row.upload_strategy as MigrationItem['uploadStrategy'],
    boxFileId: row.box_file_id,
    boxFileVersionId: row.box_file_version_id,
    boxSize: row.box_size,
    boxSha1: row.box_sha1,
    bytesTransferred: row.bytes_transferred,
    transferVerifiedAt: row.transfer_verified_at,
    provenanceAppliedAt: row.provenance_applied_at,
    finalFolderId: row.final_folder_id,
    finalName: row.final_name,
    completedAt: row.completed_at,
    attempts: row.attempts,
    retryCount: row.retry_count,
    nextAttemptAt: row.next_attempt_at,
    lastErrorCategory: row.last_error_category as ErrorCategory | null,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

export interface SessionRow {
  id: string;
  item_id: string;
  box_session_id: string;
  part_size: number;
  total_parts: number;
  expires_at: string | null;
  state: string;
  commit_attempts: number;
  created_at: string;
  updated_at: string;
}

export function mapSession(row: SessionRow): UploadSessionRecord {
  return {
    id: row.id,
    itemId: row.item_id,
    boxSessionId: row.box_session_id,
    partSize: row.part_size,
    totalParts: row.total_parts,
    expiresAt: row.expires_at,
    state: row.state as UploadSessionRecord['state'],
    commitAttempts: row.commit_attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface PartRow {
  session_id: string;
  part_index: number;
  part_offset: number;
  size: number;
  sha1: string | null;
  box_part_json: string | null;
  state: string;
  attempts: number;
  updated_at: string;
}

export function mapPart(row: PartRow): UploadPartRecord {
  return {
    sessionId: row.session_id,
    partIndex: row.part_index,
    offset: row.part_offset,
    size: row.size,
    sha1: row.sha1,
    boxPartId: row.box_part_json,
    state: row.state as UploadPartRecord['state'],
    attempts: row.attempts,
    updatedAt: row.updated_at,
  };
}

export interface ExtractionRow {
  id: string;
  item_id: string;
  attempt: number;
  provider: string;
  raw_fields: string;
  document_type: string | null;
  business_domain: string | null;
  business_identifier: string | null;
  effective_date: string | null;
  suggested_destination_key: string | null;
  suggested_tags: string;
  reason: string | null;
  confidence: number | null;
  refs: string;
  created_at: string;
}

export function mapExtraction(row: ExtractionRow): ExtractionResultRecord {
  return {
    id: row.id,
    itemId: row.item_id,
    attempt: row.attempt,
    provider: row.provider,
    rawFields: parseJson<Record<string, unknown>>(row.raw_fields, {}),
    documentType: row.document_type,
    businessDomain: row.business_domain,
    businessIdentifier: row.business_identifier,
    effectiveDate: row.effective_date,
    suggestedDestinationKey: row.suggested_destination_key,
    suggestedTags: parseJson<string[]>(row.suggested_tags, []),
    reason: row.reason,
    confidence: row.confidence,
    references: parseJson<string[]>(row.refs, []),
    createdAt: row.created_at,
  };
}

export interface RoutingRow {
  id: string;
  item_id: string;
  state: string;
  suggested_destination_key: string | null;
  suggestion_source: string;
  suggestion_reason: string | null;
  approved_destination_key: string | null;
  approved_metadata: string | null;
  approved_box_file_id: string | null;
  approved_box_version_id: string | null;
  approved_sha1: string | null;
  human_override: number;
  operator_label: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export function mapRouting(row: RoutingRow): RoutingDecisionRecord {
  return {
    id: row.id,
    itemId: row.item_id,
    state: row.state as RoutingDecisionRecord['state'],
    suggestedDestinationKey: row.suggested_destination_key,
    suggestionSource: row.suggestion_source as RoutingDecisionRecord['suggestionSource'],
    suggestionReason: row.suggestion_reason,
    approvedDestinationKey: row.approved_destination_key,
    approvedMetadata: row.approved_metadata
      ? parseJson<Record<string, unknown>>(row.approved_metadata, {})
      : null,
    approvedBoxFileId: row.approved_box_file_id,
    approvedBoxVersionId: row.approved_box_version_id,
    approvedSha1: row.approved_sha1,
    humanOverride: toBool(row.human_override),
    operatorLabel: row.operator_label,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CommandRow {
  id: string;
  job_id: string;
  type: string;
  payload: string;
  state: string;
  rejection_reason: string | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
}

export function mapCommand(row: CommandRow): JobCommandRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    type: row.type as JobCommandRecord['type'],
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    state: row.state as JobCommandRecord['state'],
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
  };
}

export interface EventRow {
  id: string;
  job_id: string;
  item_id: string | null;
  phase: string;
  status: string;
  size_bytes: number | null;
  duration_ms: number | null;
  retry_count: number;
  error_category: string | null;
  box_file_id: string | null;
  destination_key: string | null;
  ai_used: number;
  human_override: number;
  message: string | null;
  created_at: string;
}

export function mapEvent(row: EventRow): MigrationEventRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    itemId: row.item_id,
    phase: row.phase as Phase,
    status: row.status as EventStatus,
    sizeBytes: row.size_bytes,
    durationMs: row.duration_ms,
    retryCount: row.retry_count,
    errorCategory: row.error_category as ErrorCategory | null,
    boxFileId: row.box_file_id,
    destinationKey: row.destination_key,
    aiUsed: toBool(row.ai_used),
    humanOverride: toBool(row.human_override),
    message: row.message,
    createdAt: row.created_at,
  };
}

export interface OutboxRow {
  event_id: string;
  job_id: string;
  payload: string;
  state: string;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

export function mapOutbox(row: OutboxRow): OutboxRecord {
  return {
    eventId: row.event_id,
    jobId: row.job_id,
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    state: row.state as OutboxRecord['state'],
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}
