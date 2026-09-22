import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { buildConfig, parseEnv } from '@shuttle-lite/config';
import RootLayout from '../src/app/layout';
import SettingsPage from '../src/app/settings/page';
import { NewJobForm } from '../src/components/new-job-form';
import { BoxFolderPicker } from '../src/components/box-folder-picker';
import { getConfig } from '../src/lib/runtime';

vi.mock('../src/lib/runtime', () => ({ getConfig: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/',
}));

describe('concise workspace screens', () => {
  it('renders navigation and page content without the top bar or sidebar slogan', () => {
    const html = renderToStaticMarkup(
      createElement(RootLayout, { children: createElement('h1', null, '移行一覧') }),
    );
    expect(html).toContain('workspace-content');
    expect(html).toContain('メインナビゲーション');
    expect(html).not.toContain('workspace-topbar');
    expect(html).not.toContain('AIが提案し、人が確認して配置');
  });

  it('keeps form labels and actions without static explanations', () => {
    const html = renderToStaticMarkup(
      createElement(NewJobForm, { aiEnabled: true, boxMode: 'real', folderPickerAvailable: true }),
    );
    for (const label of [
      '移行名',
      '移行元',
      '移行先',
      'フォルダーを選択',
      'Boxから選択',
      '移行を開始',
    ])
      expect(html).toContain(label);
    for (const copy of [
      'このMac',
      '選択だけでは',
      '選んだ範囲内で',
      '新しく作りません',
      '一時保管先',
      '元ファイルは残ります',
    ])
      expect(html).not.toContain(copy);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it('still explains unavailable folder selection', () => {
    const html = renderToStaticMarkup(
      createElement(NewJobForm, {
        aiEnabled: false,
        boxMode: 'fake',
        folderPickerAvailable: false,
      }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('フォルダー選択はMacで利用できます');
    expect(html).toContain('共通設定でAI分類が無効');
  });

  it('shows the selected destination and change action without a descriptive paragraph', () => {
    const html = renderToStaticMarkup(
      createElement(BoxFolderPicker, {
        value: { folderId: '123', name: '営業部', folderCount: 5 },
        onChange: vi.fn(),
        onBusyChange: vi.fn(),
        disabled: false,
        boxMode: 'real',
      }),
    );
    expect(html).toContain('営業部');
    expect(html).toContain('変更');
    expect(html).not.toContain('既存フォルダー');
    expect(html).not.toContain('AIが配置先');
  });

  it('shows connection values and detail settings without explanatory notes', () => {
    vi.mocked(getConfig).mockReturnValue(
      buildConfig(parseEnv({ NODE_ENV: 'test', BOX_MODE: 'real', BOX_ACCESS_TOKEN: 'test-only' })),
    );
    const html = renderToStaticMarkup(createElement(SettingsPage));
    for (const label of ['Box接続', '実Box', 'アクセストークン', '通信経路', '詳細設定', 'AI分類'])
      expect(html).toContain(label);
    for (const copy of [
      'すべての移行で使う',
      '新しい移行',
      '接続テストの結果',
      '.env',
      '移行ごとにオフ',
      'このMac',
    ])
      expect(html).not.toContain(copy);
  });
});
