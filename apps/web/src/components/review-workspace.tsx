'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { destinationDrafts } from '../lib/review-drafts';
import { ReviewList } from './review-list';

type Props = Parameters<typeof ReviewList>[0];
type Page = NonNullable<Props['pagination']> & {
  items: Props['items'];
  metadataTemplates: Props['metadataTemplates'];
};

/** Keeps full-job pagination consistent with local, unapproved destination edits. */
export function ReviewWorkspace(props: Props) {
  const [view, setView] = useState<Page>(() => ({
    ...props.pagination!,
    items: props.items,
    metadataTemplates: props.metadataTemplates,
  }));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(view);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(
    async (page: number, query: string, filter: string, navigation = false) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      if (navigation) setLoading(true);
      const timeout = window.setTimeout(() => {
        if (request.current === controller) {
          controller.abort();
          request.current = null;
          setLoading(false);
          setError('一覧の更新に時間がかかっています。');
        }
      }, 15000);
      try {
        let drafts: ReturnType<typeof destinationDrafts> = [];
        try {
          drafts = destinationDrafts(window.localStorage, props.jobId);
        } catch {
          // The list remains usable when browser storage is unavailable.
          // ReviewList reports the persistence problem separately.
        }
        const response = await fetch(`/api/jobs/${props.jobId}/review`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ page, query, filter, drafts }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('一覧を更新できませんでした。');
        const next = (await response.json()) as Page;
        if (controller.signal.aborted) return;
        current.current = next;
        setView(next);
        setError(null);
        const params = new URLSearchParams({ page: String(next.page), q: next.query });
        if (next.filter !== 'all') params.set('filter', next.filter!);
        const url = `/jobs/${props.jobId}/review?${params}`;
        if (navigation) window.history.pushState(null, '', url);
        else if (page !== next.page) window.history.replaceState(null, '', url);
      } catch (cause) {
        if (!controller.signal.aborted) setError((cause as Error).message);
      } finally {
        window.clearTimeout(timeout);
        if (request.current === controller) {
          request.current = null;
          setLoading(false);
        }
      }
    },
    [props.jobId],
  );
  const refresh = useCallback(() => {
    if (request.current) return;
    const page = current.current;
    void load(page.page, page.query, page.filter ?? 'all');
  }, [load]);
  useEffect(() => {
    refresh();
    const back = () => {
      const params = new URLSearchParams(window.location.search);
      void load(
        Number(params.get('page') ?? 1),
        params.get('q') ?? '',
        params.get('filter') ?? 'all',
      );
    };
    window.addEventListener('popstate', back);
    return () => {
      request.current?.abort();
      window.removeEventListener('popstate', back);
    };
  }, [load, refresh]);
  return (
    <div className="review-container" aria-busy={loading}>
      {error ? (
        <p className="error" role="alert">
          {error}{' '}
          <button type="button" className="ghost" onClick={refresh}>
            再読み込み
          </button>
        </p>
      ) : null}
      <ReviewList
        {...props}
        key={`${view.page}:${view.query}:${view.filter}`}
        items={view.items}
        metadataTemplates={view.metadataTemplates}
        pagination={view}
        navigationPending={loading}
        onRefresh={refresh}
        onNavigate={(page, query, filter) => void load(page, query, filter, true)}
      />
    </div>
  );
}
