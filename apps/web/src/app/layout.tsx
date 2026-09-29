import { currentUser } from '../lib/auth';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { WorkspaceAccount } from '../components/workspace-account';
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
              {user && <WorkspaceAccount name={user.name} />}
            </>
          }
        >
          {children}
        </WorkspaceShell>
      </body>
    </html>
  );
}
