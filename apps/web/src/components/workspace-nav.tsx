'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { workspaceNavigation } from '../lib/workspace-navigation';
import { WorkspaceIcon } from './workspace-icon';

export function WorkspaceNav() {
  const links = workspaceNavigation(usePathname());
  return (
    <nav className="workspace-nav" aria-label="メインナビゲーション">
      <p className="workspace-nav-label">ワークスペース</p>
      {links.map((link) =>
        link.href ? (
          <Link
            key={link.label}
            href={link.href}
            className={link.icon === 'settings' ? 'workspace-settings' : undefined}
            aria-current={link.current ? 'page' : undefined}
          >
            <WorkspaceIcon kind={link.icon} />
            {link.label}
          </Link>
        ) : (
          <span
            key={link.label}
            className="workspace-nav-unavailable"
            title="移行一覧でジョブを選ぶと開けます"
          >
            <WorkspaceIcon kind={link.icon} />
            {link.label}
          </span>
        ),
      )}
    </nav>
  );
}
