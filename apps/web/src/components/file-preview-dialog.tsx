'use client';

import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { ReviewItemView } from '../lib/review-types';
import styles from './file-preview-dialog.module.css';

type PreviewItem = Pick<
  ReviewItemView,
  'jobId' | 'itemId' | 'sourceFileName' | 'boxFileId' | 'boxVersionId' | 'boxSha1'
>;

export function FilePreviewButton({
  item,
  boxLink,
  disabled,
}: {
  item: PreviewItem;
  boxLink: string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.previewButton}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        プレビュー
      </button>
      {open ? (
        <FilePreviewDialog
          item={item}
          boxLink={boxLink}
          returnFocusTo={triggerRef}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function FilePreviewDialog({
  item,
  boxLink,
  onClose,
  returnFocusTo,
}: {
  item: PreviewItem;
  boxLink: string;
  onClose: () => void;
  returnFocusTo: RefObject<HTMLButtonElement | null>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{ url: string } | { error: string } | null>(null);
  const [retryAt, setRetryAt] = useState(0);
  const [retryBlocked, setRetryBlocked] = useState(false);
  const { jobId, itemId, boxFileId, boxVersionId, boxSha1 } = item;

  useEffect(() => {
    const dialog = dialogRef.current!;
    const trigger = returnFocusTo.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [returnFocusTo]);

  useEffect(() => {
    const delay = retryAt - Date.now();
    if (delay <= 0) return;
    const timer = window.setTimeout(() => setRetryBlocked(false), delay);
    return () => window.clearTimeout(timer);
  }, [retryAt]);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    const timer = window.setTimeout(() => {
      current = false;
      controller.abort();
      setResult({ error: 'プレビューの取得に時間がかかっています。再読み込みしてください' });
    }, 25_000);
    async function load() {
      try {
        const response = await fetch(
          `/api/jobs/${encodeURIComponent(jobId)}/items/${encodeURIComponent(itemId)}/preview`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-shuttle-preview': '1' },
            body: JSON.stringify({
              observedBoxFileId: boxFileId,
              observedBoxVersionId: boxVersionId,
              observedBoxSha1: boxSha1,
            }),
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        const data = (await response.json()) as { url?: string; message?: string };
        if (!current) return;
        if (!response.ok) {
          if (response.status === 429) {
            const seconds = Number(response.headers.get('retry-after'));
            setRetryAt(
              Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 30) * 1000,
            );
            setRetryBlocked(true);
          }
          setResult({ error: data.message ?? 'プレビューを取得できませんでした' });
        } else if (typeof data.url === 'string' && data.url) {
          setResult({ url: data.url });
        } else {
          setResult({ error: 'プレビューを取得できませんでした' });
        }
      } catch {
        if (current)
          setResult({ error: 'プレビューを取得できませんでした。再読み込みしてください' });
      } finally {
        window.clearTimeout(timer);
      }
    }
    void load();
    return () => {
      current = false;
      controller.abort();
      window.clearTimeout(timer);
    };
    // Primitive identity keeps the iframe stable across the review page's polling refreshes.
  }, [jobId, itemId, boxFileId, boxVersionId, boxSha1, reload]);

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className={styles.content}>
        <header className={styles.header}>
          <h2 id={titleId}>{item.sourceFileName}</h2>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={!result || retryBlocked}
              onClick={() => {
                setResult(null);
                setReload((value) => value + 1);
              }}
            >
              再読み込み
            </button>
            <a href={boxLink} target="_blank" rel="noreferrer">
              Boxで原本を開く ↗
            </a>
            <button
              type="button"
              className={styles.close}
              aria-label="プレビューを閉じる"
              autoFocus
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </header>
        <div className={styles.body}>
          {!result ? (
            <p className={styles.message} role="status">
              プレビューを読み込んでいます…
            </p>
          ) : 'error' in result ? (
            <p className={styles.message} role="alert">
              {result.error}
            </p>
          ) : (
            <iframe
              key={result.url}
              src={result.url}
              title={`${item.sourceFileName} のプレビュー`}
              className={styles.frame}
              referrerPolicy="no-referrer"
              allowFullScreen
            />
          )}
        </div>
      </div>
    </dialog>
  );
}
