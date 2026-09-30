const paths = {
  eye: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  folder: 'M3 6h6l2 2h10v12H3z',
  folderExport: 'M18 10V8h-8L8 5H3v15h15v-3',
  review: 'M13 21H5V3h10l4 4v6 M15 3v5h4 M15 18l2 2 4-5',
  documentSparkles:
    'M17 13v9H3V5h7l7 7 M10 5v7h7 M19 1l1.1 2.9L23 5l-2.9 1.1L19 9l-1.1-2.9L15 5l2.9-1.1Z',
  clock: 'M12 8v5h4 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12 M6 18 18 6',
  search: 'M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  external: 'M14 3h7v7 M21 3 10 14 M10 5H4v15h15v-6',
};

export function WorkspaceIcon({ kind }: { kind: keyof typeof paths | 'settings' }) {
  if (kind === 'settings')
    return <span className="workspace-icon workspace-settings-icon" aria-hidden="true" />;

  return (
    <svg
      className="workspace-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[kind]} />
      {kind === 'folderExport' ? <path d="M14 13.5h8 M19 10.5l3 3-3 3" strokeWidth="2.2" /> : null}
    </svg>
  );
}

export function DocumentIcon({ name }: { name: string }) {
  const extension = name.includes('.') ? name.split('.').at(-1)!.toUpperCase() : 'FILE';
  return (
    <svg className="document-icon" data-format={extension} viewBox="0 0 32 40" aria-hidden="true">
      <path d="M3 1h17l9 9v29H3z M20 1v10h9" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <text x="16" y="29" fill="currentColor" textAnchor="middle" fontSize="8" fontWeight="600">
        {extension.slice(0, 4)}
      </text>
    </svg>
  );
}
