import { currentUser } from '../lib/auth';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { WorkspaceNav } from '../components/workspace-nav';
import { WorkspaceShell } from '../components/workspace-shell';
import { ShuttleBrand } from '../components/shuttle-brand';
import './globals.css';

export const metadata: Metadata = {
  title: 'Shuttle Lite',
  description: 'Box Platformベースの軽量migration path PoC',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="ja">
      <body>
        <WorkspaceShell
          sidebar={
            <>
              <a className="workspace-brand" href="/">
                <ShuttleBrand />
              </a>
              <WorkspaceNav />
              {user && (
                <div className="workspace-account">
                  <span>{user.name}</span>
                  <div>
                    <a href="/api/auth/login">Boxに再ログイン</a>
                  </div>
                  <form action="/api/auth/logout" method="post">
                    <button type="submit">ログアウト</button>
                  </form>
                </div>
              )}
            </>
          }
        >
          {children}
        </WorkspaceShell>
      </body>
    </html>
  );
}
