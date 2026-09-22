export function workspaceNavigation(pathname: string) {
  const job = /^\/jobs\/([^/]+)(\/review)?\/?$/.exec(pathname);
  const jobPath = job ? `/jobs/${job[1]}` : null;
  return [
    { label: '移行一覧', icon: 'folder', href: '/', current: pathname === '/' },
    {
      label: '分類・承認',
      icon: 'review',
      href: jobPath ? `${jobPath}/review` : null,
      current: !!job?.[2],
    },
    { label: '進捗', icon: 'clock', href: jobPath, current: !!job && !job[2] },
    { label: '設定', icon: 'settings', href: '/settings', current: pathname === '/settings' },
  ] as const;
}
