'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { jobNavigation } from '../lib/workspace-navigation';

export function JobNavigation({ jobId, mode }: { jobId: string; mode: string }) {
  const links = jobNavigation(jobId, mode, usePathname());
  return (
    <nav className="job-navigation" aria-label="移行の操作">
      {links.map((link) => (
        <Link key={link.href} href={link.href} aria-current={link.current ? 'page' : undefined}>
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
