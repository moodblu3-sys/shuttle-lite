import {
  canTransition,
  type CommandType,
  type ConflictPolicy,
  type ErrorCategory,
  type EventStatus,
  type ExtractionResultRecord,
  type ItemState,
  type JobCommandRecord,
  type JobState,
  type MigrationEventRecord,
  type MigrationItem,
  type MigrationJob,
  type MigrationProfile,
  newCommandId,
  newEventId,
  newJobId,
  newProfileId,
  type OutboxRecord,
  type Phase,
  phaseForState,
  randomId,
  type RoutingDecisionRecord,
  ShuttleError,
  type UploadPartRecord,
  type UploadSessionRecord,
} from '@shuttle-lite/core';
import {
  type CommandRow,
  type EventRow,
  type ExtractionRow,
  type ItemRow,
  type JobRow,
  mapCommand,
  mapEvent,
  mapExtraction,
  mapItem,
  mapJob,
  mapOutbox,
  mapPart,
  mapProfile,
  mapRouting,
  mapSession,
  type OutboxRow,
  type PartRow,
  type ProfileRow,
  type RoutingRow,
  type SessionRow,
} from './rows';
import { fromBool, nowIso, type SqliteDatabase } from './sqlite';

export interface CreateProfileInput {
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
}

export interface ScannedItemInput {
  readonly id: string;
  readonly jobId: string;
  readonly sourceRelativePath: string;
  readonly sourceAbsolutePath: string;
  readonly sourceFileName: string;
  readonly sourceSize: number;
  readonly sourceModifiedAt: string;
  readonly sourceInode: string | null;
  readonly fileType: string;
}

/** Only these item fields may be patched, keyed by domain name. */
const ITEM_COLUMNS: Record<string, string> = {
  sourceSize: 'source_size',
  sourceModifiedAt: 'source_modified_at',
  sourceSha1: 'source_sha1',
  scannedAt: 'scanned_at',
  state: 'state',
  resumeState: 'resume_state',
  stagingName: 'staging_name',
  uploadStrategy: 'upload_strategy',
  boxFileId: 'box_file_id',
  boxFileVersionId: 'box_file_version_id',
  boxSize: 'box_size',
  boxSha1: 'box_sha1',
  bytesTransferred: 'bytes_transferred',
  transferVerifiedAt: 'transfer_verified_at',
  provenanceAppliedAt: 'provenance_applied_at',
  finalFolderId: 'final_folder_id',
  finalName: 'final_name',
  completedAt: 'completed_at',
  attempts: 'attempts',
  retryCount: 'retry_count',
  nextAttemptAt: 'next_attempt_at',
  lastErrorCategory: 'last_error_category',
  lastError: 'last_error',
};

export type ItemPatch = Partial<{
  sourceSize: number;
  sourceModifiedAt: string;
  sourceSha1: string | null;
  scannedAt: string;
  state: ItemState;
  resumeState: ItemState | null;
  stagingName: string | null;
  uploadStrategy: 'DIRECT' | 'CHUNKED' | null;
  boxFileId: string | null;
  boxFileVersionId: string | null;
  boxSize: number | null;
  boxSha1: string | null;
  bytesTransferred: number;
  transferVerifiedAt: string | null;
  provenanceAppliedAt: string | null;
  finalFolderId: string | null;
  finalName: string | null;
  completedAt: string | null;
  attempts: number;
  retryCount: number;
  nextAttemptAt: string | null;
  lastErrorCategory: ErrorCategory | null;
  lastError: string | null;
}>;

export interface EventInput {
  readonly jobId: string;
  readonly itemId?: string | null;
  readonly phase: Phase;
  readonly status: EventStatus;
  readonly sizeBytes?: number | null;
  readonly durationMs?: number | null;
  readonly retryCount?: number;
  readonly errorCategory?: ErrorCategory | null;
  readonly boxFileId?: string | null;
  readonly destinationKey?: string | null;
  readonly aiUsed?: boolean;
  readonly humanOverride?: boolean;
  readonly message?: string | null;
}

export interface TransitionInput {
  readonly itemId: string;
  readonly to: ItemState;
  /** Guard against a concurrent writer: the update only applies from this state. */
  readonly expectedFrom?: ItemState;
  readonly patch?: ItemPatch;
  readonly event?: Omit<EventInput, 'jobId' | 'itemId' | 'phase'> & { phase?: Phase };
  /** Emit a telemetry outbox row alongside the event. */
  readonly telemetry?: boolean;
  readonly telemetryPayload?: (event: MigrationEventRecord) => Record<string, unknown>;
}

/**
 * All SQLite access goes through this store. It keeps state updates, event
 * rows and outbox rows inside one transaction so a Snowflake outage can never
 * lose telemetry that the operational state already reflects
 * (docs/architecture.md section 11).
 */
export type TelemetryPayloadBuilder = (event: MigrationEventRecord) => Record<string, unknown>;

export class ShuttleStore {
  readonly db: SqliteDatabase;
  /**
   * Supplied by the telemetry package so that the allowlisted payload is built
   * and persisted inside the same transaction as the state change.
   */
  readonly #telemetryPayload: TelemetryPayloadBuilder | null;

  constructor(db: SqliteDatabase, options: { telemetryPayload?: TelemetryPayloadBuilder } = {}) {
    this.db = db;
    this.#telemetryPayload = options.telemetryPayload ?? null;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // -------------------------------------------------------------------------
  // Profiles
  // -------------------------------------------------------------------------

  createProfile(input: CreateProfileInput): MigrationProfile {
    const id = newProfileId();
    this.db
      .prepare(
        `INSERT INTO migration_profiles (
           id, name, source_root_path, target_staging_folder_id, destination_catalog_id,
           proxy_profile_name, metadata_template_key, file_concurrency, chunk_concurrency,
           ai_routing_enabled, snowflake_logging_enabled, conflict_policy, created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.name,
        input.sourceRootPath,
        input.targetStagingFolderId,
        input.destinationCatalogId,
        input.proxyProfileName,
        input.metadataTemplateKey,
        input.fileConcurrency,
        input.chunkConcurrency,
        fromBool(input.aiRoutingEnabled),
        fromBool(input.snowflakeLoggingEnabled),
        input.conflictPolicy,
        nowIso(),
      );
    const profile = this.getProfile(id);
    if (!profile) throw new ShuttleError('UNKNOWN', 'profileの作成直後に読み出せませんでした');
    return profile;
  }

  getProfile(id: string): MigrationProfile | null {
    const row = this.db.prepare('SELECT * FROM migration_profiles WHERE id = ?').get(id) as
      ProfileRow | undefined;
    return row ? mapProfile(row) : null;
  }

  getProfileByName(name: string): MigrationProfile | null {
    const row = this.db.prepare('SELECT * FROM migration_profiles WHERE name = ?').get(name) as
      ProfileRow | undefined;
    return row ? mapProfile(row) : null;
  }

  listProfiles(): MigrationProfile[] {
    const rows = this.db
      .prepare('SELECT * FROM migration_profiles ORDER BY created_at DESC')
      .all() as ProfileRow[];
    return rows.map(mapProfile);
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  createJob(input: { profileId: string; operatorLabel: string }): MigrationJob {
    const id = newJobId();
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO migration_jobs (id, profile_id, state, operator_label, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(id, input.profileId, 'QUEUED', input.operatorLabel, at, at);
    const job = this.getJob(id);
    if (!job) throw new ShuttleError('UNKNOWN', 'jobの作成直後に読み出せませんでした');
    return job;
  }

  getJob(id: string): MigrationJob | null {
    const row = this.db.prepare('SELECT * FROM migration_jobs WHERE id = ?').get(id) as
      JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  listJobs(limit = 50): MigrationJob[] {
    const rows = this.db
      .prepare('SELECT * FROM migration_jobs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as JobRow[];
    return rows.map(mapJob);
  }

  /**
   * Worker lease. Only one worker may own a job at a time, and an expired
   * lease is reclaimable so a crashed worker does not block the job forever.
   *
   * Only jobs with something to do are claimable. Without that filter a job
   * sitting in the review queue would starve every job created after it,
   * because claims are handed out in creation order.
   */
  claimJob(owner: string, ttlMs: number): MigrationJob | null {
    return this.transaction(() => {
      const now = nowIso();
      const row = this.db
        .prepare(
          `SELECT j.* FROM migration_jobs j
            WHERE j.state IN ('SCANNING','RUNNING')
              AND (j.lease_owner IS NULL OR j.lease_expires_at IS NULL OR j.lease_expires_at < ?)
              AND (
                j.state = 'SCANNING'
                OR EXISTS (
                  SELECT 1 FROM job_commands c WHERE c.job_id = j.id AND c.state = 'PENDING'
                )
                OR EXISTS (
                  SELECT 1 FROM migration_items i
                   WHERE i.job_id = j.id
                     AND i.state NOT IN (
                       'COMPLETED','SKIPPED','FAILED','REVIEW_REQUIRED','NEEDS_REVIEW','PAUSED'
                     )
                     AND (i.next_attempt_at IS NULL OR i.next_attempt_at <= ?)
                )
                OR NOT EXISTS (
                  SELECT 1 FROM migration_items i2
                   WHERE i2.job_id = j.id
                     AND i2.state NOT IN ('COMPLETED','SKIPPED','FAILED')
                )
              )
            ORDER BY j.created_at
            LIMIT 1`,
        )
        .get(now, now) as JobRow | undefined;
      if (!row) return null;
      const expires = new Date(Date.now() + ttlMs).toISOString();
      this.db
        .prepare(
          'UPDATE migration_jobs SET lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?',
        )
        .run(owner, expires, now, row.id);
      return this.getJob(row.id);
    });
  }

  renewLease(jobId: string, owner: string, ttlMs: number): boolean {
    const expires = new Date(Date.now() + ttlMs).toISOString();
    const result = this.db
      .prepare(
        'UPDATE migration_jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ?',
      )
      .run(expires, nowIso(), jobId, owner);
    return result.changes === 1;
  }

  releaseLease(jobId: string, owner: string): void {
    this.db
      .prepare(
        'UPDATE migration_jobs SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_owner = ?',
      )
      .run(nowIso(), jobId, owner);
  }

  setJobState(
    jobId: string,
    state: JobState,
    patch: {
      stagingFolderId?: string | null;
      startedAt?: string | null;
      finishedAt?: string | null;
      lastError?: string | null;
      lastErrorCategory?: ErrorCategory | null;
      pauseRequested?: boolean;
    } = {},
  ): void {
    const sets = ['state = ?', 'updated_at = ?'];
    const values: unknown[] = [state, nowIso()];
    if ('stagingFolderId' in patch) {
      sets.push('staging_folder_id = ?');
      values.push(patch.stagingFolderId ?? null);
    }
    if ('startedAt' in patch) {
      sets.push('started_at = ?');
      values.push(patch.startedAt ?? null);
    }
    if ('finishedAt' in patch) {
      sets.push('finished_at = ?');
      values.push(patch.finishedAt ?? null);
    }
    if ('lastError' in patch) {
      sets.push('last_error = ?');
      values.push(patch.lastError ?? null);
    }
    if ('lastErrorCategory' in patch) {
      sets.push('last_error_category = ?');
      values.push(patch.lastErrorCategory ?? null);
    }
    if ('pauseRequested' in patch) {
      sets.push('pause_requested = ?');
      values.push(fromBool(patch.pauseRequested === true));
    }
    values.push(jobId);
    this.db.prepare(`UPDATE migration_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  setPauseRequested(jobId: string, requested: boolean): void {
    this.db
      .prepare('UPDATE migration_jobs SET pause_requested = ?, updated_at = ? WHERE id = ?')
      .run(fromBool(requested), nowIso(), jobId);
  }

  refreshJobTotals(jobId: string): void {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS items, COALESCE(SUM(source_size), 0) AS bytes FROM migration_items WHERE job_id = ?',
      )
      .get(jobId) as { items: number; bytes: number };
    this.db
      .prepare(
        'UPDATE migration_jobs SET total_items = ?, total_bytes = ?, updated_at = ? WHERE id = ?',
      )
      .run(row.items, row.bytes, nowIso(), jobId);
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  /**
   * Idempotent scan write. A rescan that finds the same path unchanged leaves
   * the item alone, so completed work is never redone (requirement 4.6).
   */
  upsertScannedItem(input: ScannedItemInput): 'INSERTED' | 'UNCHANGED' | 'RESCANNED' {
    const existing = this.db
      .prepare('SELECT * FROM migration_items WHERE job_id = ? AND source_relative_path = ?')
      .get(input.jobId, input.sourceRelativePath) as ItemRow | undefined;
    const at = nowIso();
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO migration_items (
             id, job_id, source_relative_path, source_absolute_path, source_file_name,
             source_size, source_modified_at, source_inode, file_type, scanned_at,
             state, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.id,
          input.jobId,
          input.sourceRelativePath,
          input.sourceAbsolutePath,
          input.sourceFileName,
          input.sourceSize,
          input.sourceModifiedAt,
          input.sourceInode,
          input.fileType,
          at,
          'DISCOVERED',
          at,
        );
      return 'INSERTED';
    }
    const changed =
      existing.source_size !== input.sourceSize ||
      existing.source_modified_at !== input.sourceModifiedAt;
    if (!changed) {
      this.db
        .prepare('UPDATE migration_items SET scanned_at = ?, updated_at = ? WHERE id = ?')
        .run(at, at, existing.id);
      return 'UNCHANGED';
    }
    if (existing.state === 'COMPLETED') {
      // The migrated copy stays valid. A changed source is a new decision for
      // a human, never an automatic overwrite.
      this.db
        .prepare(
          `UPDATE migration_items
             SET scanned_at = ?, updated_at = ?, last_error_category = ?, last_error = ?
           WHERE id = ?`,
        )
        .run(at, at, 'SOURCE_CHANGED', '完了後にsource fileが変更されています', existing.id);
      return 'UNCHANGED';
    }
    this.db
      .prepare(
        `UPDATE migration_items
           SET source_size = ?, source_modified_at = ?, source_sha1 = NULL, scanned_at = ?,
               state = 'DISCOVERED', resume_state = NULL, bytes_transferred = 0,
               attempts = 0, next_attempt_at = NULL, last_error = NULL, last_error_category = NULL,
               updated_at = ?
         WHERE id = ?`,
      )
      .run(input.sourceSize, input.sourceModifiedAt, at, at, existing.id);
    return 'RESCANNED';
  }

  getItem(id: string): MigrationItem | null {
    const row = this.db.prepare('SELECT * FROM migration_items WHERE id = ?').get(id) as
      ItemRow | undefined;
    return row ? mapItem(row) : null;
  }

  listItems(
    jobId: string,
    options: { states?: readonly ItemState[]; limit?: number; offset?: number } = {},
  ): MigrationItem[] {
    const clauses = ['job_id = ?'];
    const values: unknown[] = [jobId];
    if (options.states && options.states.length > 0) {
      clauses.push(`state IN (${options.states.map(() => '?').join(',')})`);
      values.push(...options.states);
    }
    values.push(options.limit ?? 500, options.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT * FROM migration_items WHERE ${clauses.join(' AND ')}
         ORDER BY source_relative_path LIMIT ? OFFSET ?`,
      )
      .all(...values) as ItemRow[];
    return rows.map(mapItem);
  }

  /** Items the worker may progress right now, skipping those in retry backoff. */
  listReadyItems(
    jobId: string,
    states: readonly ItemState[],
    limit: number,
    now = nowIso(),
  ): MigrationItem[] {
    if (states.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM migration_items
           WHERE job_id = ?
             AND state IN (${states.map(() => '?').join(',')})
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY next_attempt_at IS NOT NULL, source_relative_path
           LIMIT ?`,
      )
      .all(jobId, ...states, now, limit) as ItemRow[];
    return rows.map(mapItem);
  }

  /**
   * Items a queue may pick up, including those parked in a side state whose
   * `resumeState` belongs to that queue. This is what makes the upload queue
   * and the AI queue independent (docs/requirements.md 4.13).
   */
  listReadyItemsForScope(
    jobId: string,
    scope: readonly ItemState[],
    limit: number,
    now = nowIso(),
  ): MigrationItem[] {
    if (scope.length === 0) return [];
    const placeholders = scope.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM migration_items
           WHERE job_id = ?
             AND (
               state IN (${placeholders})
               OR (state IN ('RETRY_WAIT','UNKNOWN_OUTCOME') AND resume_state IN (${placeholders}))
             )
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY next_attempt_at IS NOT NULL, source_relative_path
           LIMIT ?`,
      )
      .all(jobId, ...scope, ...scope, now, limit) as ItemRow[];
    return rows.map(mapItem);
  }

  countByStates(jobId: string, states: readonly ItemState[]): number {
    if (states.length === 0) return 0;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM migration_items
          WHERE job_id = ? AND state IN (${states.map(() => '?').join(',')})`,
      )
      .get(jobId, ...states) as { count: number };
    return row.count;
  }

  findItemByStagingName(jobId: string, stagingName: string): MigrationItem | null {
    const row = this.db
      .prepare('SELECT * FROM migration_items WHERE job_id = ? AND staging_name = ?')
      .get(jobId, stagingName) as ItemRow | undefined;
    return row ? mapItem(row) : null;
  }

  countItemsByState(jobId: string): Record<string, number> {
    const rows = this.db
      .prepare(
        'SELECT state, COUNT(*) AS count FROM migration_items WHERE job_id = ? GROUP BY state',
      )
      .all(jobId) as Array<{ state: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.state, row.count]));
  }

  byteTotals(jobId: string): { totalBytes: number; transferredBytes: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(source_size), 0) AS total,
                COALESCE(SUM(bytes_transferred), 0) AS transferred
           FROM migration_items WHERE job_id = ?`,
      )
      .get(jobId) as { total: number; transferred: number };
    return { totalBytes: row.total, transferredBytes: row.transferred };
  }

  updateItem(itemId: string, patch: ItemPatch): void {
    const entries = Object.entries(patch).filter(([key]) => key in ITEM_COLUMNS);
    if (entries.length === 0) return;
    const sets = entries.map(([key]) => `${ITEM_COLUMNS[key]} = ?`);
    const values = entries.map(([, value]) => (value === undefined ? null : value));
    sets.push('updated_at = ?');
    values.push(nowIso());
    values.push(itemId);
    this.db.prepare(`UPDATE migration_items SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /**
   * The only way an item changes state. The transition is validated, and the
   * event plus its outbox row are written in the same transaction.
   */
  transitionItem(input: TransitionInput): MigrationItem {
    return this.transaction(() => {
      const current = this.getItem(input.itemId);
      if (!current) {
        throw new ShuttleError('STATE_INVALID', `item ${input.itemId} が存在しません`);
      }
      if (input.expectedFrom && current.state !== input.expectedFrom) {
        throw new ShuttleError(
          'STATE_INVALID',
          `item ${input.itemId} の状態が ${input.expectedFrom} ではなく ${current.state} です`,
        );
      }
      if (!canTransition(current.state, input.to)) {
        throw new ShuttleError(
          'STATE_INVALID',
          `許可されない遷移です: ${current.state} -> ${input.to}`,
          { details: { itemId: input.itemId } },
        );
      }
      this.updateItem(input.itemId, { ...input.patch, state: input.to });
      const updated = this.getItem(input.itemId);
      if (!updated) throw new ShuttleError('UNKNOWN', 'item更新後に読み出せませんでした');
      if (input.event) {
        const { phase, ...rest } = input.event;
        this.appendEvent(
          {
            jobId: updated.jobId,
            itemId: updated.id,
            phase: phase ?? phaseForState(input.to, updated.resumeState),
            ...rest,
          },
          { telemetry: input.telemetry ?? true, payload: input.telemetryPayload },
        );
      }
      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // Upload sessions and parts
  // -------------------------------------------------------------------------

  createUploadSession(input: {
    itemId: string;
    boxSessionId: string;
    partSize: number;
    totalParts: number;
    expiresAt: string | null;
    parts: ReadonlyArray<{ index: number; offset: number; size: number }>;
  }): UploadSessionRecord {
    return this.transaction(() => {
      const id = randomId('ups');
      const at = nowIso();
      this.db
        .prepare(
          `INSERT INTO upload_sessions (
             id, item_id, box_session_id, part_size, total_parts, expires_at, state, created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.itemId,
          input.boxSessionId,
          input.partSize,
          input.totalParts,
          input.expiresAt,
          'OPEN',
          at,
          at,
        );
      const insertPart = this.db.prepare(
        `INSERT INTO upload_parts (session_id, part_index, part_offset, size, state, updated_at)
         VALUES (?,?,?,?,?,?)`,
      );
      for (const part of input.parts) {
        insertPart.run(id, part.index, part.offset, part.size, 'PENDING', at);
      }
      const session = this.getSession(id);
      if (!session) throw new ShuttleError('UNKNOWN', 'upload sessionを読み出せませんでした');
      return session;
    });
  }

  getSession(id: string): UploadSessionRecord | null {
    const row = this.db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(id) as
      SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  getOpenSession(itemId: string): UploadSessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM upload_sessions WHERE item_id = ? AND state IN ('OPEN','COMMITTING')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(itemId) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  setSessionState(id: string, state: UploadSessionRecord['state']): void {
    this.db
      .prepare('UPDATE upload_sessions SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, nowIso(), id);
  }

  incrementCommitAttempts(id: string): number {
    this.db
      .prepare(
        'UPDATE upload_sessions SET commit_attempts = commit_attempts + 1, updated_at = ? WHERE id = ?',
      )
      .run(nowIso(), id);
    return this.getSession(id)?.commitAttempts ?? 0;
  }

  listParts(sessionId: string): UploadPartRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM upload_parts WHERE session_id = ? ORDER BY part_index')
      .all(sessionId) as PartRow[];
    return rows.map(mapPart);
  }

  markPartUploaded(input: {
    sessionId: string;
    partIndex: number;
    sha1: string;
    boxPartJson: string;
  }): void {
    this.db
      .prepare(
        `UPDATE upload_parts
            SET state = 'UPLOADED', sha1 = ?, box_part_json = ?, attempts = attempts + 1, updated_at = ?
          WHERE session_id = ? AND part_index = ?`,
      )
      .run(input.sha1, input.boxPartJson, nowIso(), input.sessionId, input.partIndex);
  }

  markPartFailed(sessionId: string, partIndex: number): void {
    this.db
      .prepare(
        `UPDATE upload_parts SET state = 'FAILED', attempts = attempts + 1, updated_at = ?
          WHERE session_id = ? AND part_index = ?`,
      )
      .run(nowIso(), sessionId, partIndex);
  }

  // -------------------------------------------------------------------------
  // Extraction and routing
  // -------------------------------------------------------------------------

  insertExtraction(
    input: Omit<ExtractionResultRecord, 'id' | 'createdAt'>,
  ): ExtractionResultRecord {
    const id = randomId('ext');
    this.db
      .prepare(
        `INSERT INTO extraction_results (
           id, item_id, attempt, provider, raw_fields, document_type, business_domain,
           business_identifier, effective_date, suggested_destination_key, suggested_tags,
           reason, confidence, refs, created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.itemId,
        input.attempt,
        input.provider,
        JSON.stringify(input.rawFields),
        input.documentType,
        input.businessDomain,
        input.businessIdentifier,
        input.effectiveDate,
        input.suggestedDestinationKey,
        JSON.stringify(input.suggestedTags),
        input.reason,
        input.confidence,
        JSON.stringify(input.references),
        nowIso(),
      );
    const row = this.db.prepare('SELECT * FROM extraction_results WHERE id = ?').get(id) as
      ExtractionRow | undefined;
    if (!row) throw new ShuttleError('UNKNOWN', 'extraction結果を読み出せませんでした');
    return mapExtraction(row);
  }

  latestExtraction(itemId: string): ExtractionResultRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM extraction_results WHERE item_id = ? ORDER BY attempt DESC, created_at DESC LIMIT 1',
      )
      .get(itemId) as ExtractionRow | undefined;
    return row ? mapExtraction(row) : null;
  }

  countExtractionAttempts(itemId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM extraction_results WHERE item_id = ?')
      .get(itemId) as { count: number };
    return row.count;
  }

  getRouting(itemId: string): RoutingDecisionRecord | null {
    const row = this.db.prepare('SELECT * FROM routing_decisions WHERE item_id = ?').get(itemId) as
      RoutingRow | undefined;
    return row ? mapRouting(row) : null;
  }

  upsertSuggestion(input: {
    itemId: string;
    suggestedDestinationKey: string | null;
    suggestionSource: RoutingDecisionRecord['suggestionSource'];
    suggestionReason: string | null;
    state?: RoutingDecisionRecord['state'];
  }): RoutingDecisionRecord {
    const at = nowIso();
    const existing = this.getRouting(input.itemId);
    const state = input.state ?? (input.suggestedDestinationKey ? 'SUGGESTED' : 'NEEDS_INPUT');
    if (existing) {
      this.db
        .prepare(
          `UPDATE routing_decisions
              SET state = ?, suggested_destination_key = ?, suggestion_source = ?,
                  suggestion_reason = ?, updated_at = ?
            WHERE item_id = ?`,
        )
        .run(
          state,
          input.suggestedDestinationKey,
          input.suggestionSource,
          input.suggestionReason,
          at,
          input.itemId,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO routing_decisions (
             id, item_id, state, suggested_destination_key, suggestion_source, suggestion_reason,
             created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          randomId('rtg'),
          input.itemId,
          state,
          input.suggestedDestinationKey,
          input.suggestionSource,
          input.suggestionReason,
          at,
          at,
        );
    }
    const record = this.getRouting(input.itemId);
    if (!record) throw new ShuttleError('UNKNOWN', 'routing decisionを読み出せませんでした');
    return record;
  }

  recordApproval(input: {
    itemId: string;
    approvedDestinationKey: string;
    approvedMetadata: Record<string, unknown>;
    approvedBoxFileId: string;
    approvedBoxVersionId: string | null;
    approvedSha1: string;
    operatorLabel: string;
    humanOverride: boolean;
  }): RoutingDecisionRecord {
    const at = nowIso();
    const existing = this.getRouting(input.itemId);
    this.upsertSuggestion({
      itemId: input.itemId,
      suggestedDestinationKey: existing?.suggestedDestinationKey ?? null,
      suggestionSource: existing?.suggestionSource ?? 'MANUAL',
      suggestionReason: existing?.suggestionReason ?? null,
      state: 'APPROVED',
    });
    this.db
      .prepare(
        `UPDATE routing_decisions
            SET state = 'APPROVED', approved_destination_key = ?, approved_metadata = ?,
                approved_box_file_id = ?, approved_box_version_id = ?, approved_sha1 = ?,
                operator_label = ?, human_override = ?, approved_at = ?, updated_at = ?
          WHERE item_id = ?`,
      )
      .run(
        input.approvedDestinationKey,
        JSON.stringify(input.approvedMetadata),
        input.approvedBoxFileId,
        input.approvedBoxVersionId,
        input.approvedSha1,
        input.operatorLabel,
        fromBool(input.humanOverride),
        at,
        at,
        input.itemId,
      );
    const record = this.getRouting(input.itemId);
    if (!record) throw new ShuttleError('UNKNOWN', 'approval recordを読み出せませんでした');
    return record;
  }

  setRoutingState(itemId: string, state: RoutingDecisionRecord['state']): void {
    this.db
      .prepare('UPDATE routing_decisions SET state = ?, updated_at = ? WHERE item_id = ?')
      .run(state, nowIso(), itemId);
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  enqueueCommand(
    jobId: string,
    type: CommandType,
    payload: Record<string, unknown> = {},
  ): JobCommandRecord {
    const id = newCommandId();
    this.db
      .prepare(
        `INSERT INTO job_commands (id, job_id, type, payload, state, created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(id, jobId, type, JSON.stringify(payload), 'PENDING', nowIso());
    const row = this.db.prepare('SELECT * FROM job_commands WHERE id = ?').get(id) as
      CommandRow | undefined;
    if (!row) throw new ShuttleError('UNKNOWN', 'commandを読み出せませんでした');
    return mapCommand(row);
  }

  /** Claim commands so two workers never execute the same operator action. */
  claimCommands(limit = 20, jobId?: string): JobCommandRecord[] {
    return this.transaction(() => {
      const rows = jobId
        ? (this.db
            .prepare(
              `SELECT * FROM job_commands WHERE state = 'PENDING' AND job_id = ? ORDER BY created_at LIMIT ?`,
            )
            .all(jobId, limit) as CommandRow[])
        : (this.db
            .prepare(
              `SELECT * FROM job_commands WHERE state = 'PENDING' ORDER BY created_at LIMIT ?`,
            )
            .all(limit) as CommandRow[]);
      const claim = this.db.prepare(
        `UPDATE job_commands SET state = 'CLAIMED', claimed_at = ? WHERE id = ? AND state = 'PENDING'`,
      );
      const claimed: CommandRow[] = [];
      for (const row of rows) {
        if (claim.run(nowIso(), row.id).changes === 1) claimed.push(row);
      }
      return claimed.map(mapCommand);
    });
  }

  completeCommand(id: string): void {
    this.db
      .prepare(`UPDATE job_commands SET state = 'DONE', completed_at = ? WHERE id = ?`)
      .run(nowIso(), id);
  }

  rejectCommand(id: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE job_commands SET state = 'REJECTED', rejection_reason = ?, completed_at = ? WHERE id = ?`,
      )
      .run(reason, nowIso(), id);
  }

  listCommands(jobId: string, limit = 50): JobCommandRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM job_commands WHERE job_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(jobId, limit) as CommandRow[];
    return rows.map(mapCommand);
  }

  latestReviewCommand(jobId: string, itemId: string): JobCommandRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM job_commands
       WHERE job_id = ? AND type IN ('APPROVE_ITEM', 'SKIP_ITEM')
         AND json_extract(payload, '$.itemId') = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(jobId, itemId) as CommandRow | undefined;
    return row ? mapCommand(row) : null;
  }

  // -------------------------------------------------------------------------
  // Events and outbox
  // -------------------------------------------------------------------------

  appendEvent(
    input: EventInput,
    options: {
      telemetry?: boolean;
      payload?: (event: MigrationEventRecord) => Record<string, unknown>;
    } = {},
  ): MigrationEventRecord {
    const id = newEventId();
    const at = nowIso();
    const run = () => {
      this.db
        .prepare(
          `INSERT INTO migration_events (
             id, job_id, item_id, phase, status, size_bytes, duration_ms, retry_count,
             error_category, box_file_id, destination_key, ai_used, human_override, message, created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.jobId,
          input.itemId ?? null,
          input.phase,
          input.status,
          input.sizeBytes ?? null,
          input.durationMs ?? null,
          input.retryCount ?? 0,
          input.errorCategory ?? null,
          input.boxFileId ?? null,
          input.destinationKey ?? null,
          fromBool(input.aiUsed === true),
          fromBool(input.humanOverride === true),
          input.message ?? null,
          at,
        );
      const row = this.db.prepare('SELECT * FROM migration_events WHERE id = ?').get(id) as
        EventRow | undefined;
      if (!row) throw new ShuttleError('UNKNOWN', 'eventを読み出せませんでした');
      const event = mapEvent(row);
      const payloadBuilder = options.payload ?? this.#telemetryPayload;
      if (options.telemetry !== false && payloadBuilder) {
        this.db
          .prepare(
            `INSERT INTO snowflake_outbox (event_id, job_id, payload, state, created_at)
             VALUES (?,?,?,?,?)`,
          )
          .run(event.id, event.jobId, JSON.stringify(payloadBuilder(event)), 'PENDING', at);
      }
      return event;
    };
    // Already inside a transaction when called from transitionItem.
    return this.db.inTransaction ? run() : this.transaction(run);
  }

  listEvents(
    jobId: string,
    options: { limit?: number; itemId?: string; sinceCreatedAt?: string } = {},
  ): MigrationEventRecord[] {
    const clauses = ['job_id = ?'];
    const values: unknown[] = [jobId];
    if (options.itemId) {
      clauses.push('item_id = ?');
      values.push(options.itemId);
    }
    if (options.sinceCreatedAt) {
      clauses.push('created_at > ?');
      values.push(options.sinceCreatedAt);
    }
    values.push(options.limit ?? 100);
    const rows = this.db
      .prepare(
        `SELECT * FROM migration_events WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...values) as EventRow[];
    return rows.map(mapEvent);
  }

  errorCategoryCounts(jobId: string): Array<{ category: string; count: number }> {
    return this.db
      .prepare(
        `SELECT error_category AS category, COUNT(*) AS count
           FROM migration_events
          WHERE job_id = ? AND error_category IS NOT NULL
          GROUP BY error_category ORDER BY count DESC`,
      )
      .all(jobId) as Array<{ category: string; count: number }>;
  }

  enqueueOutbox(eventId: string, jobId: string, payload: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO snowflake_outbox (event_id, job_id, payload, state, created_at)
         VALUES (?,?,?,?,?)`,
      )
      .run(eventId, jobId, JSON.stringify(payload), 'PENDING', nowIso());
  }

  claimOutboxBatch(limit: number, now = nowIso()): OutboxRecord[] {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM snowflake_outbox
             WHERE state IN ('PENDING','FAILED')
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             ORDER BY created_at LIMIT ?`,
        )
        .all(now, limit) as OutboxRow[];
      if (rows.length === 0) return [];
      const claim = this.db.prepare(
        `UPDATE snowflake_outbox SET state = 'CLAIMED', attempts = attempts + 1 WHERE event_id = ?`,
      );
      for (const row of rows) claim.run(row.event_id);
      const claimed = this.db
        .prepare(
          `SELECT * FROM snowflake_outbox WHERE event_id IN (${rows.map(() => '?').join(',')})
           ORDER BY created_at`,
        )
        .all(...rows.map((row) => row.event_id)) as OutboxRow[];
      return claimed.map(mapOutbox);
    });
  }

  markOutboxDelivered(eventIds: readonly string[]): void {
    if (eventIds.length === 0) return;
    const at = nowIso();
    const update = this.db.prepare(
      `UPDATE snowflake_outbox SET state = 'DELIVERED', delivered_at = ?, last_error = NULL WHERE event_id = ?`,
    );
    this.transaction(() => {
      for (const id of eventIds) update.run(at, id);
    });
  }

  markOutboxFailed(eventIds: readonly string[], error: string, nextAttemptAt: string): void {
    if (eventIds.length === 0) return;
    const update = this.db.prepare(
      `UPDATE snowflake_outbox SET state = 'FAILED', last_error = ?, next_attempt_at = ? WHERE event_id = ?`,
    );
    this.transaction(() => {
      for (const id of eventIds) update.run(error, nextAttemptAt, id);
    });
  }

  outboxStatus(jobId?: string): { pending: number; failed: number; delivered: number } {
    const rows = (
      jobId
        ? this.db
            .prepare(
              'SELECT state, COUNT(*) AS count FROM snowflake_outbox WHERE job_id = ? GROUP BY state',
            )
            .all(jobId)
        : this.db
            .prepare('SELECT state, COUNT(*) AS count FROM snowflake_outbox GROUP BY state')
            .all()
    ) as Array<{ state: string; count: number }>;
    const byState = Object.fromEntries(rows.map((row) => [row.state, row.count]));
    return {
      pending: (byState.PENDING ?? 0) + (byState.CLAIMED ?? 0),
      failed: byState.FAILED ?? 0,
      delivered: byState.DELIVERED ?? 0,
    };
  }

  getOutbox(eventId: string): OutboxRecord | null {
    const row = this.db
      .prepare('SELECT * FROM snowflake_outbox WHERE event_id = ?')
      .get(eventId) as OutboxRow | undefined;
    return row ? mapOutbox(row) : null;
  }
}
