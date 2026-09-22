import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { WorkspaceNav } from '../components/workspace-nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Shuttle Lite',
  description: 'Box Platformベースの軽量migration path PoC',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <div className="app-shell">
          <aside className="workspace-sidebar">
            <a className="workspace-brand" href="/">
              <svg viewBox="0 0 40 40" aria-hidden="true">
                <path d="M3 27 32 4c3-2 5 0 4 4l-7 27c-1 3-4 4-5 1l-6-12z" fill="#2467f4" />
                <path d="m3 27 15-3L32 8 13 29z" fill="#83b4ff" />
                <path d="m18 24 6 12-1-18z" fill="#1752cf" />
              </svg>
              Shuttle Lite
            </a>
            <WorkspaceNav />
          </aside>
          <main id="workspace-content" className="workspace-content">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
