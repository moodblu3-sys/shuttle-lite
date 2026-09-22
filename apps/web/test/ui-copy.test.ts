import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { buildConfig, parseEnv } from '@shuttle-lite/config';
import { ReviewList } from '../src/components/review-list';
import { StatePill } from '../src/components/state-pill';
import type { ReviewItemView } from '../src/lib/review-types';
import HomePage from '../src/app/page';
import RootLayout from '../src/app/layout';
import SettingsPage from '../src/app/settings/page';
import { NewJobForm } from '../src/components/new-job-form';
import { BoxFolderPicker } from '../src/components/box-folder-picker';
import { getConfig } from '../src/lib/runtime';

vi.mock('../src/lib/runtime', () => ({
  getConfig: vi.fn(),
  getStore: () => ({
    listJobs: () => [],
    getRuntimeSettings: () => ({ revision: 0, settings: null }),
  }),
}));
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
    expect(html).toContain('フォルダー選択はMacのみ対応');
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
    for (const label of ['認証情報', 'アクセストークン', '詳細設定', 'AI分類', '保存', 'Snowflake'])
      expect(html).toContain(label);
    for (const copy of [
      '接続先',
      '実Box',
      '通信経路',
      '直接接続',
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

describe('concise review and empty states', () => {
  it('keeps the new migration action in an empty list without a tutorial', () => {
    vi.mocked(getConfig).mockReturnValue(
      buildConfig(parseEnv({ NODE_ENV: 'test', BOX_MODE: 'fake' })),
    );
    const html = renderToStaticMarkup(createElement(HomePage));
    expect(html).toContain('新しい移行');
    expect(html).toContain('移行履歴なし');
    expect(html).not.toContain('右上の');
  });

  it('keeps conflict recovery, approval and original-file access without placeholder content', () => {
    const item: ReviewItemView = {
      itemId: 'itm_1',
      jobId: 'job_1',
      state: 'NEEDS_REVIEW',
      sourceRelativePath: 'contract.pdf',
      sourceFileName: 'contract.pdf',
      sourceSize: 100,
      sourceSha1: 'abc',
      boxFileId: '123',
      boxSha1: 'abc',
      boxVersionId: '1',
      lastErrorCategory: 'MOVE_CONFLICT',
      lastError: '同名ファイルがあります',
      operatorAction: 'ファイル名を変更してください。',
      needsAttention: true,
      finalName: null,
      suggestedDestinationKey: 'contracts',
      hasRoutingDecision: true,
      suggestionSource: 'BOX_AI',
      suggestionReason: '契約書に該当',
      extraction: null,
      reviewCommand: null,
    };
    const html = renderToStaticMarkup(
      createElement(ReviewList, {
        jobId: 'job_1',
        items: [item],
        destinations: [{ key: 'contracts', label: '契約書', boxPath: '/契約書' }],
        needsReviewKey: 'review',
        defaultOperatorLabel: 'tester',
        boxLinkBase: 'https://app.box.com/file/',
      }),
    );
    for (const value of [
      '契約書に該当',
      '同名ファイル',
      '配置するファイル名',
      'このファイルを承認',
      'https://app.box.com/file/123',
    ])
      expect(html).toContain(value);
    for (const copy of [
      '根拠となる本文',
      '原文の抜粋はまだ',
      '承認するまで一時保管',
      '個別に承認してください',
    ])
      expect(html).not.toContain(copy);
  });

  it('shows an empty review list with a return action', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewList, {
        jobId: 'job_1',
        items: [],
        destinations: [],
        needsReviewKey: 'review',
        defaultOperatorLabel: 'tester',
        boxLinkBase: null,
      }),
    );
    expect(html).toContain('承認待ちなし');
    expect(html).toContain('/jobs/job_1');
    expect(html).toContain('ファイル未選択');
    expect(html).not.toContain('一覧からファイルを選ぶと');
  });

  it('uses a Japanese label for a pending approval without changing its status style', () => {
    const html = renderToStaticMarkup(createElement(StatePill, { state: 'REVIEW_REQUIRED' }));
    expect(html).toContain('pill wait');
    expect(html).toContain('承認待ち');
    expect(html).not.toContain('REVIEW_REQUIRED');
  });
});
