import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { buildConfig, parseEnv } from '@shuttle-lite/config';
import SettingsPage from '../src/app/settings/page';
import { requirePageUser, isAdmin } from '../src/lib/auth';
import { getConfig, getStore } from '../src/lib/runtime';
vi.mock('../src/lib/auth', () => ({ requirePageUser: vi.fn(), isAdmin: vi.fn() }));
vi.mock('../src/lib/runtime', () => ({ getConfig: vi.fn(), getStore: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
beforeEach(() => {
  vi.mocked(requirePageUser).mockResolvedValue({
    id: '11',
    name: '太郎',
    login: 'test@example.test',
    enterpriseId: '99',
  });
  vi.mocked(isAdmin).mockReturnValue(false);
  vi.mocked(getConfig).mockReturnValue(
    buildConfig(
      parseEnv({
        NODE_ENV: 'test',
        BOX_MODE: 'real',
        BOX_ACCESS_TOKEN: 'secret-test-token',
        SNOWFLAKE_ACCOUNT: 'org-account',
        SNOWFLAKE_USERNAME: 'LOGGER',
        SNOWFLAKE_WAREHOUSE: 'WH',
        SNOWFLAKE_DATABASE: 'AUDIT',
        SNOWFLAKE_SCHEMA: 'PUBLIC',
        SNOWFLAKE_PRIVATE_KEY_PATH: '/private/key.pem',
        SNOWFLAKE_PRIVATE_KEY_PASSPHRASE: 'secret-passphrase',
      }),
    ),
  );
});
it('shows the destination and configuration to ordinary users without exposing credentials or edit controls', async () => {
  const html = renderToStaticMarkup(await SettingsPage());
  expect(html).toContain('Snowflake');
  expect(html).toContain('AUDIT.PUBLIC.SHUTTLE_LITE_EVENTS');
  expect(html).toContain('設定済み（接続確認は管理者が実施）');
  for (const hidden of [
    'secret-test-token',
    'secret-passphrase',
    '/private/key.pem',
    'org-account',
    'LOGGER',
    '管理者設定',
    'テストログを送信',
  ])
    expect(html).not.toContain(hidden);
});
it('shows missing setup explicitly without claiming successful delivery', async () => {
  vi.mocked(getConfig).mockReturnValue(
    buildConfig(parseEnv({ NODE_ENV: 'test', BOX_MODE: 'real', BOX_ACCESS_TOKEN: 'test-token' })),
  );
  const html = renderToStaticMarkup(await SettingsPage());
  expect(html).toContain('未設定・管理者の設定が必要');
  expect(html).not.toContain('設定済み');
});
it('retains the full connection editor and test button for administrators', async () => {
  vi.mocked(isAdmin).mockReturnValue(true);
  vi.mocked(getStore).mockReturnValue({ getRuntimeSettings: () => ({ revision: 0 }) } as ReturnType<
    typeof getStore
  >);
  const html = renderToStaticMarkup(await SettingsPage());
  expect(html).toContain('管理者設定');
  expect(html).toContain('ウェアハウス');
  expect(html).toContain('テストログを送信');
  expect(html).not.toContain('secret-passphrase');
});
it('shows the effective local destination when explicitly configured', async () => {
  const config = getConfig();
  vi.mocked(getConfig).mockReturnValue({
    ...config,
    telemetry: { ...config.telemetry, sink: 'jsonl' },
  });
  const html = renderToStaticMarkup(await SettingsPage());
  expect(html).toContain('ローカルフォルダー');
  expect(html).not.toContain('自動送信');
});
