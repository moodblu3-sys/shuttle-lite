/**
 * Demo reset. Removes local operational state so a demo can be replayed.
 * Never touches the source fixtures, and never deletes anything in Box.
 */
import { rm } from 'node:fs/promises';
import { loadConfig } from '@shuttle-lite/config';

const config = loadConfig();
const all = process.argv.includes('--all');

const targets = [
  config.sqlitePath,
  `${config.sqlitePath}-wal`,
  `${config.sqlitePath}-shm`,
  `${config.dataDir}/telemetry`,
  `${config.dataDir}/reports`,
];

if (all) {
  targets.push(config.fakeBox.rootDir, `${config.dataDir}/box-layout.json`);
}

for (const target of targets) {
  await rm(target, { recursive: true, force: true });
  process.stdout.write(`removed ${target}\n`);
}

if (!all && config.box.mode === 'fake') {
  process.stdout.write(
    'fake Boxの内容は残しています。完全に初期化するには --all を付けてください。\n',
  );
}
