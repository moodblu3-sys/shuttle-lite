export function workspaceNavigation(pathname: string) {
  return [
    {
      label: '移行一覧',
      icon: 'folder',
      href: '/',
      current: pathname === '/' || pathname.startsWith('/jobs/'),
    },
    { label: '設定', icon: 'settings', href: '/settings', current: pathname === '/settings' },
  ] as const;
}

export function jobNavigation(jobId: string, mode: string, pathname: string) {
  const base = `/jobs/${encodeURIComponent(jobId)}`;
  return [
    { label: '進捗', href: base },
    mode === 'AS_IS'
      ? { label: '差分移行', href: `${base}/delta` }
      : { label: '分類・承認', href: `${base}/review` },
    { label: '実行履歴', href: `${base}/history` },
  ].map((link) => ({ ...link, current: pathname.replace(/\/$/, '') === link.href }));
}
