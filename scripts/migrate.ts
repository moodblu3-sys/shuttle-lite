import { loadConfig } from '@shuttle-lite/config';
import { LATEST_SCHEMA_VERSION, migrate, openDatabase, schemaVersion } from '@shuttle-lite/db';

const config = loadConfig();
const db = openDatabase({ path: config.sqlitePath });
const before = schemaVersion(db);
const after = migrate(db);
db.close();

process.stdout.write(
  `SQLite: ${config.sqlitePath}\n  schema version: ${before} -> ${after} (latest ${LATEST_SCHEMA_VERSION})\n`,
);
