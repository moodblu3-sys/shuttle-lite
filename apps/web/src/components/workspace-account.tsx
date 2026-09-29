'use client';

import { BoxLabel } from './box-label';

import { useEffect, useId, useRef, useState } from 'react';

export function WorkspaceAccount({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  return (
    <div
      className="workspace-account"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        type="button"
        className="workspace-account-trigger"
        ref={trigger}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <span className="workspace-avatar" aria-hidden="true">
          {Array.from(name)[0] ?? 'U'}
        </span>
        <span className="workspace-account-name" title={name}>
          {name}
        </span>
        <svg viewBox="0 0 24 24" aria-hidden="true" className="workspace-account-chevron">
          <path d={open ? 'm7 14 5-5 5 5' : 'm7 10 5 5 5-5'} />
        </svg>
      </button>
      {open && (
        <div id={id} className="workspace-account-popover" aria-label="アカウント操作">
          <a href="/api/auth/login">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20 7v5h-5 M20 12a8 8 0 1 0-2 6" />
            </svg>
            <BoxLabel>Boxに再ログイン</BoxLabel>
          </a>
          <form action="/api/auth/logout" method="post">
            <button type="submit">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M10 4H4v16h6 M9 12h12 m-4-4 4 4-4 4" />
              </svg>
              ログアウト
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
