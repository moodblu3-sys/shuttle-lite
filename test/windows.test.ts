/**
 * Windows is the platform Shuttle Lite is primarily verified on, because the
 * Box Shuttle file server path is a Windows Agent and the customers with an
 * explicit-proxy constraint run Windows file servers.
 *
 * These cases cover the failure modes specific to that environment. They run
 * on any OS: the behaviour is driven by injected paths and error codes, not by
 * the host platform.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isOfficeLockFile,
  isWindowsReservedName,
  looksLikeNetworkPath,
  looksLikeSyncFolder,
  unsafeStatePathReason,
  WINDOWS_MAX_PATH,
} from '@shuttle-lite/core';
import { parseEnv } from '@shuttle-lite/config';
import { LocalSourceAdapter, mapReadError } from '../apps/worker/src/source/local';
import { createHarness, runUntilIdle, type Harness } from './harness';

describe('windows specific classification', () => {
  it('treats a sharing violation as a retryable lock, not a read failure', () => {
    const busy = mapReadError(Object.assign(new Error('busy'), { code: 'EBUSY' }), 'C:\\a.docx');
    expect(busy.category).toBe('SOURCE_LOCKED');
    expect(busy.retryable).toBe(true);

    const denied = mapReadError(Object.assign(new Error('perm'), { code: 'EPERM' }), 'C:\\a.docx');
    expect(denied.category).toBe('SOURCE_LOCKED');

    const missing = mapReadError(
      Object.assign(new Error('nope'), { code: 'ENOENT' }),
      'C:\\a.docx',
    );
    expect(missing.category).toBe('SOURCE_MISSING');

    const long = mapReadError(
      Object.assign(new Error('long'), { code: 'ENAMETOOLONG' }),
      'C:\\a.docx',
    );
    expect(long.category).toBe('PATH_TOO_LONG');
  });

  it('recognises Office lock files and reserved device names', () => {
    expect(isOfficeLockFile('~$contract.docx')).toBe(true);
    expect(isOfficeLockFile('contract.docx')).toBe(false);
    expect(isWindowsReservedName('CON.txt')).toBe(true);
    expect(isWindowsReservedName('com1.pdf')).toBe(true);
    expect(isWindowsReservedName('console.txt')).toBe(false);
  });

  it('refuses to keep SQLite state on a share or a sync folder', () => {
    expect(looksLikeNetworkPath('\\\\fileserver\\share\\state.db')).toBe(true);
    expect(looksLikeSyncFolder('C:\\Users\\me\\OneDrive - Contoso\\shuttle\\state.db')).toBe(true);
    expect(looksLikeSyncFolder('/Users/me/Library/Mobile Documents/shuttle/state.db')).toBe(true);
    expect(
      unsafeStatePathReason('/Users/me/projects/shuttle-lite/.shuttle-lite/state.db'),
    ).toBeNull();

    expect(() =>
      parseEnv({
        BOX_MODE: 'fake',
        SQLITE_PATH: '\\\\nas\\share\\shuttle.db',
      } as NodeJS.ProcessEnv),
    ).toThrowError(/local disk/);
    expect(() =>
      parseEnv({
        BOX_MODE: 'fake',
        SQLITE_PATH: '\\\\nas\\share\\shuttle.db',
        ALLOW_UNSAFE_STATE_PATH: 'true',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});

describe('windows specific scan behaviour', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(() => {
    harness.cleanup();
  });

  it('skips Office lock files so a document open by a colleague is not migrated', async () => {
    harness.writeSource('legal/契約書.txt', '業務委託契約書 契約番号: LEG-2026-1');
    harness.writeSource('legal/~$契約書.txt', 'lock');
    const profile = harness.createProfile();
    const job = harness.store.createJob({ profileId: profile.id, operatorLabel: 'tester' });
    harness.store.enqueueCommand(job.id, 'START_JOB');

    await runUntilIdle(harness);

    const paths = harness.store.listItems(job.id).map((item) => item.sourceRelativePath);
    expect(paths).toEqual(['legal/契約書.txt']);
  });

  it('reports a path over the Windows limit in preflight instead of mid-upload', async () => {
    const deep = join('a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60), 'd'.repeat(60));
    harness.writeSource(join(deep, 'contract.txt'), '業務委託契約書');
    const adapter = new LocalSourceAdapter({
      rootPath: harness.sourceRoot,
      maxPathLength: WINDOWS_MAX_PATH,
    });
    const absolute = adapter.absolutePathFor(`${deep.split(/[\\/]/).join('/')}/contract.txt`);
    expect(absolute.length).toBeGreaterThan(WINDOWS_MAX_PATH);
    expect(() => adapter.checkPathLength(absolute)).toThrowError(/上限を超えています/);
    // A short path is accepted.
    expect(() => adapter.checkPathLength(adapter.absolutePathFor('short.txt'))).not.toThrow();
  });

  it('rejects a source root that cannot be reached', async () => {
    const adapter = new LocalSourceAdapter({ rootPath: '/no/such/share/path' });
    await expect(adapter.verifyRoot()).rejects.toMatchObject({ category: 'SOURCE_READ' });

    const relative = new LocalSourceAdapter({ rootPath: 'fixtures/source' });
    await expect(relative.verifyRoot()).rejects.toMatchObject({ category: 'CONFIG_INVALID' });
  });

  it('walks a UNC style root shape without mangling relative paths', async () => {
    const root = join(harness.dataDir, 'unc-like');
    mkdirSync(join(root, 'dept', 'legal'), { recursive: true });
    writeFileSync(join(root, 'dept', 'legal', 'msa.txt'), '業務委託契約書');
    const adapter = new LocalSourceAdapter({ rootPath: root });
    const seen: string[] = [];
    for await (const entry of adapter.scan()) seen.push(entry.relativePath);
    expect(seen).toEqual(['dept/legal/msa.txt']);
  });
});
