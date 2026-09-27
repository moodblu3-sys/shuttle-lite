import { describe, expect, it } from 'vitest';
import { workspaceNavigation, jobNavigation } from '../apps/web/src/lib/workspace-navigation';

describe('desktop workspace navigation', () => {
  it.each([
    '/',
    '/settings',
    '/jobs/first',
    '/jobs/first/review',
    '/jobs/second/delta',
    '/jobs/second/history',
  ])('keeps the same enabled global links on %s', (path) => {
    const links = workspaceNavigation(path);
    expect(links.map(({ label, href }) => ({ label, href }))).toEqual([
      { label: '移行一覧', href: '/' },
      { label: '設定', href: '/settings' },
    ]);
    expect(links.filter((link) => link.current).map((link) => link.label)).toEqual([
      path === '/settings' ? '設定' : '移行一覧',
    ]);
  });
  it.each(['AI_ORGANIZE', 'AS_IS'])('scopes stable %s tabs to the selected job', (mode) => {
    for (const id of ['first', 'second']) {
      for (const suffix of ['', '/review', '/delta', '/history']) {
        const links = jobNavigation(id, mode, `/jobs/${id}${suffix}/`);
        expect(links.map((link) => link.label)).toEqual([
          '進捗',
          mode === 'AS_IS' ? '差分移行' : '分類・承認',
          '実行履歴',
        ]);
        expect(links.every((link) => link.href.startsWith(`/jobs/${id}`))).toBe(true);
        expect(links.filter((link) => link.current)).toHaveLength(
          suffix === (mode === 'AS_IS' ? '/review' : '/delta') ? 0 : 1,
        );
      }
    }
  });
});
