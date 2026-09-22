import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildConfig, parseEnv } from '@shuttle-lite/config';
import { ensureBoxLayout, FakeBoxGateway, loadCachedLayout, saveLayout } from '@shuttle-lite/box';
import { loadDestinationCatalog } from '@shuttle-lite/config';

function configFor(dataDir: string, rootFolderId?: string) {
  return buildConfig(
    parseEnv({
      BOX_MODE: 'fake',
      SHUTTLE_DATA_DIR: dataDir,
      SQLITE_PATH: join(dataDir, 'x.db'),
      ...(rootFolderId ? { BOX_ROOT_FOLDER_ID: rootFolderId } : {}),
    } as NodeJS.ProcessEnv),
  );
}

describe('Box folder layout の cache', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shuttle-layout-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('同じ設定なら再利用する', async () => {
    const config = configFor(dir);
    const gateway = new FakeBoxGateway({ rootDir: config.fakeBox.rootDir, maxFileBytes: 1_000 });
    const layout = await ensureBoxLayout(gateway, config, loadDestinationCatalog());
    expect(loadCachedLayout(config)?.rootFolderId).toBe(layout.rootFolderId);
  });

  it('rootを別folderへ向け直したらcacheを破棄する', async () => {
    const config = configFor(dir);
    const gateway = new FakeBoxGateway({ rootDir: config.fakeBox.rootDir, maxFileBytes: 1_000 });
    const layout = await ensureBoxLayout(gateway, config, loadDestinationCatalog());

    // 検証用folderへ切り替えた状況。古いcacheを使うと本番へ移行してしまう。
    const switched = configFor(dir, 'another-root');
    saveLayout(switched, layout);
    expect(loadCachedLayout(switched)).toBeNull();
  });

  it('staging folderの明示指定がcacheと違えば破棄する', async () => {
    const config = configFor(dir);
    const gateway = new FakeBoxGateway({ rootDir: config.fakeBox.rootDir, maxFileBytes: 1_000 });
    const layout = await ensureBoxLayout(gateway, config, loadDestinationCatalog());

    const switched = buildConfig(
      parseEnv({
        BOX_MODE: 'fake',
        SHUTTLE_DATA_DIR: dir,
        SQLITE_PATH: join(dir, 'x.db'),
        BOX_ROOT_FOLDER_ID: layout.rootFolderId,
        BOX_STAGING_FOLDER_ID: 'different-staging',
      } as NodeJS.ProcessEnv),
    );
    expect(loadCachedLayout(switched)).toBeNull();
  });
});
