import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RootLayout from '../src/app/layout';
import LoginPage from '../src/app/login/page';
import { currentUser, oauthEnabled } from '../src/lib/auth';

const location = vi.hoisted(() => ({ pathname: '/login' }));
vi.mock('next/navigation', () => ({
  usePathname: () => location.pathname,
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock('../src/lib/auth', () => ({ currentUser: vi.fn(), oauthEnabled: vi.fn() }));

describe('login layout', () => {
  beforeEach(() => {
    location.pathname = '/login';
    vi.mocked(oauthEnabled).mockReturnValue(true);
    vi.mocked(currentUser).mockResolvedValue(null);
  });

  it('shows only the login action and brand without workspace navigation', async () => {
    const page = await LoginPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(await RootLayout({ children: page }));
    expect(html).toContain('Shuttle Lite');
    expect(html).toContain('<h1 id="login-title">Shuttle Liteにログイン</h1>');
    expect(html.match(/Shuttle Lite/g)).toHaveLength(1);
    expect(html).not.toContain('workspace-brand');
    expect(html).toContain('href="/api/auth/login"');
    expect(html).toContain('Boxでログイン');
    expect(html).not.toContain('<aside');
    expect(html).not.toContain('<nav');
    expect(html).not.toContain('href="/settings"');
    expect(html).not.toContain('role="alert"');
  });

  it('keeps reauthentication failures outside the workspace, even with an existing session', async () => {
    vi.mocked(currentUser).mockResolvedValue({
      id: '123',
      name: '確認ユーザー',
      login: 'user@example.test',
      enterpriseId: '456',
    });
    const page = await LoginPage({ searchParams: Promise.resolve({ error: 'oauth' }) });
    const html = renderToStaticMarkup(await RootLayout({ children: page }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('href="/api/auth/login"');
    expect(html).not.toContain('<nav');
    expect(html).not.toContain('ログアウト');
    expect(html).not.toContain('確認ユーザー');
  });

  it.each(['/', '/settings', '/jobs/job_123/review'])(
    'preserves workspace navigation on %s',
    async (pathname) => {
      location.pathname = pathname;
      const html = renderToStaticMarkup(
        await RootLayout({ children: createElement('h1', null, '移行内容') }),
      );
      expect(html).toContain('メインナビゲーション');
      expect(html).toContain('href="/settings"');
      expect(html).toContain('移行内容');
    },
  );

  it('still redirects a signed-in user and the legacy mode away from login', async () => {
    vi.mocked(oauthEnabled).mockReturnValue(false);
    await expect(LoginPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('redirect:/');
    vi.mocked(oauthEnabled).mockReturnValue(true);
    vi.mocked(currentUser).mockResolvedValue({
      id: '123',
      name: '確認ユーザー',
      login: 'user@example.test',
      enterpriseId: '456',
    });
    await expect(LoginPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('redirect:/');
  });
});
