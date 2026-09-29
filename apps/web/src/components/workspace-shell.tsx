'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';

export function WorkspaceShell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  if (usePathname() === '/login') {
    return (
      <main id="workspace-content" className="login-shell">
        {children}
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="workspace-sidebar">{sidebar}</aside>
      <main id="workspace-content" className="workspace-content">
        {children}
      </main>
    </div>
  );
}
