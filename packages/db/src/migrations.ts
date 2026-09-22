/**
 * Schema migrations. The SQL lives in TypeScript on purpose: the web app and
 * the worker both import this package, and neither should have to read files
 * from disk relative to a bundled module.
 *
 * Tables follow docs/architecture.md section 8.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const INITIAL = `
CREATE TABLE migration_profiles (
  id                        TEXT PRIMARY KEY,
  name                      TEXT NOT NULL UNIQUE,
  source_root_path          TEXT NOT NULL,
  target_staging_folder_id  TEXT NOT NULL,
  destination_catalog_id    TEXT NOT NULL,
  proxy_profile_name        TEXT NOT NULL,
  metadata_template_key     TEXT NOT NULL,
  file_concurrency          INTEGER NOT NULL,
  chunk_concurrency         INTEGER NOT NULL,
  ai_routing_enabled        INTEGER NOT NULL,
  snowflake_logging_enabled INTEGER NOT NULL,
  created_at                TEXT NOT NULL
) STRICT;

CREATE TABLE migration_jobs (
  id                  TEXT PRIMARY KEY,
  profile_id          TEXT NOT NULL REFERENCES migration_profiles(id),
  state               TEXT NOT NULL,
  operator_label      TEXT NOT NULL,
  staging_folder_id   TEXT,
  pause_requested     INTEGER NOT NULL DEFAULT 0,
  lease_owner         TEXT,
  lease_expires_at    TEXT,
  total_items         INTEGER NOT NULL DEFAULT 0,
  total_bytes         INTEGER NOT NULL DEFAULT 0,
  started_at          TEXT,
  finished_at         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  last_error          TEXT,
  last_error_category TEXT
) STRICT;

CREATE INDEX idx_jobs_state ON migration_jobs(state);

CREATE TABLE migration_items (
  id                     TEXT PRIMARY KEY,
  job_id                 TEXT NOT NULL REFERENCES migration_jobs(id),
  source_relative_path   TEXT NOT NULL,
  source_absolute_path   TEXT NOT NULL,
  source_file_name       TEXT NOT NULL,
  source_size            INTEGER NOT NULL,
  source_modified_at     TEXT NOT NULL,
  source_inode           TEXT,
  file_type              TEXT NOT NULL,
  source_sha1            TEXT,
  scanned_at             TEXT NOT NULL,
  state                  TEXT NOT NULL,
  resume_state           TEXT,
  staging_name           TEXT,
  upload_strategy        TEXT,
  box_file_id            TEXT,
  box_file_version_id    TEXT,
  box_size               INTEGER,
  box_sha1               TEXT,
  bytes_transferred      INTEGER NOT NULL DEFAULT 0,
  transfer_verified_at   TEXT,
  provenance_applied_at  TEXT,
  final_folder_id        TEXT,
  final_name             TEXT,
  completed_at           TEXT,
  attempts               INTEGER NOT NULL DEFAULT 0,
  retry_count            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at        TEXT,
  last_error_category    TEXT,
  last_error             TEXT,
  updated_at             TEXT NOT NULL,
  UNIQUE (job_id, source_relative_path)
) STRICT;

CREATE INDEX idx_items_job_state ON migration_items(job_id, state);
CREATE INDEX idx_items_next_attempt ON migration_items(state, next_attempt_at);
CREATE INDEX idx_items_staging ON migration_items(job_id, staging_name);

CREATE TABLE upload_sessions (
  id              TEXT PRIMARY KEY,
  item_id         TEXT NOT NULL REFERENCES migration_items(id),
  box_session_id  TEXT NOT NULL UNIQUE,
  part_size       INTEGER NOT NULL,
  total_parts     INTEGER NOT NULL,
  expires_at      TEXT,
  state           TEXT NOT NULL,
  commit_attempts INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;

CREATE INDEX idx_sessions_item ON upload_sessions(item_id, state);

CREATE TABLE upload_parts (
  session_id    TEXT NOT NULL REFERENCES upload_sessions(id),
  part_index    INTEGER NOT NULL,
  part_offset   INTEGER NOT NULL,
  size          INTEGER NOT NULL,
  sha1          TEXT,
  box_part_json TEXT,
  state         TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (session_id, part_index)
) STRICT;

CREATE TABLE extraction_results (
  id                        TEXT PRIMARY KEY,
  item_id                   TEXT NOT NULL REFERENCES migration_items(id),
  attempt                   INTEGER NOT NULL,
  provider                  TEXT NOT NULL,
  raw_fields                TEXT NOT NULL,
  document_type             TEXT,
  business_domain           TEXT,
  business_identifier       TEXT,
  effective_date            TEXT,
  suggested_destination_key TEXT,
  suggested_tags            TEXT NOT NULL,
  reason                    TEXT,
  confidence                REAL,
  refs                      TEXT NOT NULL,
  created_at                TEXT NOT NULL
) STRICT;

CREATE INDEX idx_extraction_item ON extraction_results(item_id, attempt);

CREATE TABLE routing_decisions (
  id                        TEXT PRIMARY KEY,
  item_id                   TEXT NOT NULL UNIQUE REFERENCES migration_items(id),
  state                     TEXT NOT NULL,
  suggested_destination_key TEXT,
  suggestion_source         TEXT NOT NULL,
  suggestion_reason         TEXT,
  approved_destination_key  TEXT,
  approved_metadata         TEXT,
  approved_box_file_id      TEXT,
  approved_box_version_id   TEXT,
  approved_sha1             TEXT,
  human_override            INTEGER NOT NULL DEFAULT 0,
  operator_label            TEXT,
  approved_at               TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
) STRICT;

CREATE TABLE job_commands (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES migration_jobs(id),
  type             TEXT NOT NULL,
  payload          TEXT NOT NULL,
  state            TEXT NOT NULL,
  rejection_reason TEXT,
  created_at       TEXT NOT NULL,
  claimed_at       TEXT,
  completed_at     TEXT
) STRICT;

CREATE INDEX idx_commands_pending ON job_commands(state, created_at);

CREATE TABLE migration_events (
  id             TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL REFERENCES migration_jobs(id),
  item_id        TEXT,
  phase          TEXT NOT NULL,
  status         TEXT NOT NULL,
  size_bytes     INTEGER,
  duration_ms    INTEGER,
  retry_count    INTEGER NOT NULL DEFAULT 0,
  error_category TEXT,
  box_file_id    TEXT,
  destination_key TEXT,
  ai_used        INTEGER NOT NULL DEFAULT 0,
  human_override INTEGER NOT NULL DEFAULT 0,
  message        TEXT,
  created_at     TEXT NOT NULL
) STRICT;

CREATE INDEX idx_events_job ON migration_events(job_id, created_at);
CREATE INDEX idx_events_item ON migration_events(item_id, created_at);

CREATE TABLE snowflake_outbox (
  event_id        TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL,
  payload         TEXT NOT NULL,
  state           TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  delivered_at    TEXT
) STRICT;

CREATE INDEX idx_outbox_pending ON snowflake_outbox(state, next_attempt_at);
`;

// 既存profileは、Box Shuttleと同じ「上書きしない」既定に落ちる。
const CONFLICT_POLICY = `
ALTER TABLE migration_profiles ADD COLUMN conflict_policy TEXT NOT NULL DEFAULT 'RENAME';
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial schema', sql: INITIAL },
  { version: 2, name: 'profile conflict policy', sql: CONFLICT_POLICY },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
