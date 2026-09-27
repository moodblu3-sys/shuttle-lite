'use client';

import {
  loadReviewDraft,
  saveReviewDraft,
  reconcileReviewDraft,
  type SavedReviewDraft,
} from '../lib/review-drafts';
import type { TemplateMapping } from '@shuttle-lite/core';
import { BusinessMetadataFields } from './business-metadata-fields';
import { FilePreviewButton } from './file-preview-dialog';
import { useRouter } from 'next/navigation';
import { Fragment, useEffect, useRef, useState } from 'react';
import { formatBytes } from '@shuttle-lite/core/progress';
import { withNameSuffix } from '@shuttle-lite/core/naming';
import type { DestinationOption, ReviewCommandView, ReviewItemView } from '../lib/review-types';
import {
  bulkReviewItems,
  canApprove,
  commandFor,
  draftFor,
  matchesReviewSearch,
  isReviewPending,
  reviewRevision,
  type ApprovalDraft,
} from '../lib/review-model';
import { DocumentIcon, WorkspaceIcon as Icon } from './workspace-icon';
import styles from './review-workspace.module.css';
import { ErrorNotice } from './error-notice';
import { errorPresentation } from '../lib/error-presentation';

function metadataStatus(item: ReviewItemView, pending: boolean): string {
  if (pending) return '処理中';
  switch (item.businessMetadata?.extractionStatus) {
    case 'EXTRACTED':
      return '抽出済み';
    case 'EMPTY':
      return '該当項目なし';
    case 'FAILED':
      return '抽出失敗';
    default:
      return '手動入力';
  }
}

const FILTERS = [
  ['all', 'すべて'],
  ['ready', '承認待ち'],
  ['unselected', '未選択'],
  ['attention', '要対応'],
] as const;
type ReviewFilter = (typeof FILTERS)[number][0];

export function ReviewList({
  jobId,
  items,
  destinations,
  needsReviewKey,
  defaultOperatorLabel,
  boxLinkBase,
  metadataTemplates = [],
  pagination,
  onNavigate,
  onRefresh,
  navigationPending = false,
}: {
  jobId: string;
  items: readonly ReviewItemView[];
  destinations: readonly DestinationOption[];
  needsReviewKey: string;
  defaultOperatorLabel: string;
  boxLinkBase: string | null;
  metadataTemplates?: readonly TemplateMapping[];
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    allTotal: number;
    query: string;
    filter?: string;
    counts?: Record<ReviewFilter, number>;
    destinationOverrides?: Record<string, string>;
  };
  onNavigate?: (page: number, query: string, filter: string) => void;
  onRefresh?: () => void;
  navigationPending?: boolean;
}) {
  const router = useRouter();
  const [operatorLabel, setOperatorLabel] = useState(defaultOperatorLabel);
  const [edits, setEdits] = useState<Record<string, SavedReviewDraft>>({});
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [localFilter, setLocalFilter] = useState<ReviewFilter>('all');
  const filter = (pagination?.filter ?? localFilter) as ReviewFilter;
  const [query, setQuery] = useState(pagination?.query ?? '');
  const [submitting, setBusy] = useState(false);
  const busy = submitting || navigationPending;
  const sending = useRef(false);
  const [submitted, setSubmitted] = useState<Record<string, ReviewCommandView>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bulkEdit, setBulkEdit] = useState<'destination' | 'template' | null>(null);
  const [bulkValue, setBulkValue] = useState('');
  const active = items.find((item) => item.itemId === activeId);
  const visibleItems = items.filter(
    (item) =>
      (pagination || matchesReviewSearch(item, query)) &&
      (filter === 'all' || categoryFor(item, currentDraft(item), true) === filter),
  );
  const pending = visibleItems.filter((item) => !isReviewPending(item, submitted[item.itemId]));
  const ready = bulkReviewItems(pending, selected, currentDraft, destinations, needsReviewKey);
  const selectable = pending.filter((item) => !item.needsAttention);
  const chosen = selectable.filter(isSelected);
  const allSelected = selectable.length > 0 && selectable.every(isSelected);
  const filterCounts = { all: 0, ready: 0, unselected: 0, attention: 0, ...pagination?.counts };
  for (const item of items) {
    if (!pagination && !matchesReviewSearch(item, query)) continue;
    const category = categoryFor(item, currentDraft(item), true);
    if (pagination?.counts) {
      // Reflect local destination edits and command receipts without losing global totals.
      const originalDraft = draftFor(item);
      const original = categoryFor(
        item,
        {
          ...originalDraft,
          destinationKey:
            pagination.destinationOverrides?.[item.itemId] ?? originalDraft.destinationKey,
        },
        false,
      );
      if (original !== 'processing') filterCounts[original]--;
    } else {
      filterCounts.all++;
    }
    if (category !== 'processing') filterCounts[category]++;
  }
  const duplicateNames = new Set(
    items
      .filter((item, index) =>
        items.some(
          (other, otherIndex) =>
            index !== otherIndex && other.sourceFileName === item.sourceFileName,
        ),
      )
      .map((item) => item.sourceFileName),
  );

  function currentDraft(item: ReviewItemView) {
    const edit = edits[item.itemId];
    // Only our completed template command may carry placement edits into a new snapshot.
    return reconcileReviewDraft(item, edit)?.draft ?? draftFor(item);
  }
  function categoryFor(item: ReviewItemView, draft: ApprovalDraft, includeReceipt: boolean) {
    if (isReviewPending(item, includeReceipt ? submitted[item.itemId] : undefined))
      return 'processing';
    if (item.needsAttention) return 'attention';
    return canApprove(draft, destinations, needsReviewKey) ? 'ready' : 'unselected';
  }
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden && !sending.current && !navigationPending) refresh();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [router, onRefresh, navigationPending]);

  function refresh() {
    if (onRefresh) onRefresh();
    else router.refresh();
  }

  useEffect(() => {
    try {
      const restored: Record<string, SavedReviewDraft> = {};
      for (const item of items) {
        const draft = loadReviewDraft(window.localStorage, item);
        if (draft) restored[item.itemId] = draft;
      }
      setEdits((previous) => {
        for (const item of items) {
          const saved = reconcileReviewDraft(item, previous[item.itemId]);
          if (saved) restored[item.itemId] = saved;
        }
        return restored;
      });
    } catch {
      setError('下書きを保存できません。ブラウザーの保存設定を確認してください。');
    }
  }, [items]);

  function pageUrl(page: number, search = query, nextFilter = filter) {
    const params = new URLSearchParams({ page: String(page), q: search });
    if (nextFilter !== 'all') params.set('filter', nextFilter);
    return `/jobs/${jobId}/review?${params}`;
  }
  function navigate(page: number, search = query, nextFilter = filter) {
    setSelected(new Map());
    setBulkEdit(null);
    if (onNavigate) onNavigate(page, search, nextFilter);
    else router.push(pageUrl(page, search, nextFilter));
  }
  function changeFilter(nextFilter: ReviewFilter) {
    setSelected(new Map());
    setActiveId(null);
    setBulkEdit(null);
    if (pagination) navigate(1, pagination.query, nextFilter);
    else setLocalFilter(nextFilter);
  }
  function closeInspector() {
    const row = document.getElementById(`review-file-${activeId}`);
    setActiveId(null);
    row?.focus();
  }

  function isSelected(item: ReviewItemView) {
    return selected.get(item.itemId) === reviewRevision(item);
  }
  function updateDraft(item: ReviewItemView, patch: Partial<ApprovalDraft>) {
    const draft = { ...currentDraft(item), ...patch };
    let saved: SavedReviewDraft = {
      revision: reviewRevision(item),
      commandId: item.reviewCommand?.id ?? null,
      draft,
      savedAt: Date.now(),
    };
    try {
      saved = saveReviewDraft(window.localStorage, item, draft);
    } catch {
      setError('下書きを保存できません。ブラウザーの保存設定を確認してください。');
    }
    setEdits((previous) => ({ ...previous, [item.itemId]: saved }));
  }
  function toggleGroup(group: readonly ReviewItemView[]) {
    const available = group.filter(
      (item) => !item.needsAttention && !isReviewPending(item, submitted[item.itemId]),
    );
    setSelected((previous) => {
      const next = new Map(previous);
      const remove = available.every((item) => previous.get(item.itemId) === reviewRevision(item));
      for (const item of available) {
        if (remove) next.delete(item.itemId);
        else next.set(item.itemId, reviewRevision(item));
      }
      return next;
    });
  }
  async function send(targets: readonly ReviewItemView[], skip = false) {
    if (sending.current || targets.length === 0) return;
    if (
      skip &&
      !window.confirm('このファイルを移行対象から除外します。保留とは異なり、配置されません。')
    )
      return;
    sending.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const accepted: string[] = [];
    const failures: string[] = [];
    try {
      for (const item of targets) {
        if (isReviewPending(item, submitted[item.itemId])) continue;
        if (!skip && !canApprove(currentDraft(item), destinations, needsReviewKey)) continue;
        try {
          const response = await fetch(`/api/jobs/${jobId}/commands`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(
              skip
                ? {
                    type: 'SKIP_ITEM',
                    payload: { itemId: item.itemId, reason: '操作者が移行対象から除外しました' },
                  }
                : commandFor(item, currentDraft(item), operatorLabel),
            ),
          });
          if (!response.ok) {
            const body = (await response.json()) as { error?: string };
            throw new Error(body.error ?? `送信に失敗しました (${response.status})`);
          }
          const body = (await response.json()) as { command: ReviewCommandView };
          setSubmitted((previous) => ({ ...previous, [item.itemId]: body.command }));
          accepted.push(item.itemId);
        } catch (cause) {
          failures.push(`${item.sourceFileName}: ${(cause as Error).message}`);
        }
      }
      setSelected((previous) => new Map([...previous].filter(([id]) => !accepted.includes(id))));
      if (accepted.length > 0)
        setNotice(`${accepted.length}件の${skip ? '除外' : '承認'}を受け付けました。`);
      if (failures.length > 0) setError(failures.join(' / '));
      // 202 means queued; server command state unlocks rejected or returned items.
      refresh();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function selectTemplates(targets: readonly ReviewItemView[], templateId: string | null) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const failures: string[] = [];
    let accepted = 0;
    try {
      for (const item of targets) {
        if (!item.businessMetadata || isReviewPending(item, submitted[item.itemId])) continue;
        try {
          const response = await fetch(`/api/jobs/${jobId}/commands`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              type: 'SELECT_METADATA_TEMPLATE',
              payload: {
                itemId: item.itemId,
                templateId,
                revision: item.businessMetadata.revision,
                observedBoxFileId: item.boxFileId,
                observedSha1: item.boxSha1,
              },
            }),
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error ?? '変更を受け付けられませんでした。');
          // Preserve placement edits across our own extraction, never old metadata values.
          const saved: SavedReviewDraft = {
            revision: reviewRevision(item),
            commandId: item.reviewCommand?.id ?? null,
            draft: currentDraft(item),
            savedAt: Date.now(),
            templateChange: { commandId: data.command.id, templateId },
          };
          setEdits((previous) => ({ ...previous, [item.itemId]: saved }));
          try {
            saveReviewDraft(window.localStorage, item, saved.draft, saved.templateChange);
          } catch {
            failures.push(`${item.sourceFileName}: 下書きを保存できません。`);
          }
          setSubmitted((previous) => ({ ...previous, [item.itemId]: data.command }));
          setSelected((previous) => {
            const next = new Map(previous);
            next.delete(item.itemId);
            return next;
          });
          accepted++;
        } catch (cause) {
          failures.push(`${item.sourceFileName}: ${(cause as Error).message}`);
        }
      }
      if (accepted) setNotice(`${accepted}件のテンプレート変更を受け付けました。`);
      if (failures.length) setError(failures.join(' / '));
      refresh();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  function selectTemplate(item: ReviewItemView, templateId: string | null) {
    return selectTemplates([item], templateId);
  }
  function templateOptions(item?: ReviewItemView) {
    const metadata = item?.businessMetadata;
    return (
      <>
        <option value="">未選択</option>
        {metadata?.template &&
        !metadataTemplates.some(
          ({ template }) => `${template.scope}/${template.templateKey}` === metadata.templateId,
        ) ? (
          <option value={metadata.templateId!} disabled>
            {metadata.template.displayName}（選択済み）
          </option>
        ) : null}
        {metadataTemplates.map(({ template }) => (
          <option
            key={`${template.scope}/${template.templateKey}`}
            value={`${template.scope}/${template.templateKey}`}
          >
            {template.displayName}
          </option>
        ))}
      </>
    );
  }
  function destinationOptions() {
    return (
      <>
        <option value="">未選択</option>
        {destinations
          .filter((entry) => entry.key !== needsReviewKey)
          .map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.label}
            </option>
          ))}
      </>
    );
  }
  function renderRow(item: ReviewItemView) {
    const queued = isReviewPending(item, submitted[item.itemId]);
    const draft = currentDraft(item);
    const category = categoryFor(item, draft, true);
    const destination = destinations.find((entry) => entry.key === draft.destinationKey);
    const subtitle = duplicateNames.has(item.sourceFileName)
      ? item.sourceRelativePath
      : item.needsAttention
        ? item.businessMetadata?.extractionStatus === 'FAILED'
          ? 'メタデータを抽出できませんでした'
          : errorPresentation(item.lastErrorCategory).title
        : null;
    const previewLink = boxLinkBase && item.boxFileId ? `${boxLinkBase}${item.boxFileId}` : null;
    return (
      <tr
        key={item.itemId}
        className={`${styles.fileRow} ${isSelected(item) ? styles.selected : ''} ${activeId === item.itemId ? styles.focused : ''}`}
      >
        <td>
          <input
            type="checkbox"
            checked={isSelected(item) && !queued && !item.needsAttention}
            disabled={busy || queued || item.needsAttention}
            onChange={() => toggleGroup([item])}
            aria-label={`${item.sourceRelativePath} を選択`}
          />
        </td>
        <td>
          <button
            id={`review-file-${item.itemId}`}
            title={item.sourceRelativePath}
            type="button"
            className={styles.fileButton}
            aria-pressed={activeId === item.itemId}
            aria-controls={active ? 'review-inspector' : undefined}
            onClick={() => setActiveId(item.itemId)}
          >
            <DocumentIcon name={item.sourceFileName} />
            <span className={styles.fileText}>
              <strong>{item.sourceFileName}</strong>
              {subtitle ? <span>{subtitle}</span> : null}
            </span>
          </button>
        </td>
        <td>
          <select
            className={`${styles.inlineSelect} ${!destination ? styles.warning : ''}`}
            aria-label={`${item.sourceRelativePath} の配置先`}
            title={destination?.boxPath ?? '未選択'}
            value={draft.destinationKey}
            disabled={busy || queued}
            onChange={(event) => updateDraft(item, { destinationKey: event.target.value })}
          >
            {destinationOptions()}
          </select>
        </td>
        <td className={styles.templateCell}>
          {item.businessMetadata ? (
            <select
              className={`${styles.inlineSelect} ${!item.businessMetadata.templateId ? styles.warning : ''}`}
              aria-label={`${item.sourceRelativePath} のテンプレート`}
              title={item.businessMetadata.template?.displayName ?? '未選択'}
              value={item.businessMetadata.templateId ?? ''}
              disabled={busy || queued}
              onChange={(event) => void selectTemplate(item, event.target.value || null)}
            >
              {templateOptions(item)}
            </select>
          ) : (
            <span>—</span>
          )}
          {item.businessMetadata?.template ? <small>{metadataStatus(item, queued)}</small> : null}
        </td>
        <td>
          <span
            className={`${styles.status} ${category === 'attention' || category === 'unselected' ? styles.warning : ''}`}
          >
            {queued
              ? '処理中'
              : category === 'attention'
                ? '要対応'
                : category === 'ready'
                  ? '承認待ち'
                  : '未選択'}
          </span>
        </td>
        <td>
          {previewLink ? (
            <FilePreviewButton
              key={`${item.boxFileId}:${item.boxVersionId}:${item.boxSha1}:${item.state}:${item.reviewCommand?.state ?? ''}`}
              item={item}
              boxLink={previewLink}
              compact
              disabled={busy || queued || !item.boxVersionId || !item.boxSha1}
            />
          ) : null}
        </td>
      </tr>
    );
  }
  const draft = active ? currentDraft(active) : null;
  const classificationReason = active ? draftFor(active).routingReason : '';
  const classificationFields = [
    ['文書種別', active?.extraction?.documentType],
    ['業務区分', active?.extraction?.businessDomain],
    ['識別情報', active?.extraction?.businessIdentifier],
  ].filter(([, value]) => value && !active?.businessMetadata);
  const destinationPath = destinations.find(
    (entry) => entry.key === draft?.destinationKey,
  )?.boxPath;
  const boxLink =
    active && boxLinkBase && active.boxFileId ? `${boxLinkBase}${active.boxFileId}` : null;
  const locked = busy || !!(active && isReviewPending(active, submitted[active.itemId]));
  return (
    <div className={styles.workspace}>
      <section className={styles.main} aria-label="分類結果">
        <header className={styles.heading}>
          <p className={styles.breadcrumb}>
            <a href="/">移行一覧</a> / <a href={`/jobs/${jobId}`}>進捗</a> / 承認
          </p>
          <h1>分類・承認</h1>
        </header>
        <ol className={styles.workflow} aria-label="移行の工程">
          <li>
            <span>1</span>アップロード
          </li>
          <li>
            <span>2</span>AI分類
          </li>
          <li aria-current="step">
            <span>3</span>確認・承認
          </li>
          <li>
            <span>4</span>配置
          </li>
        </ol>
        <div className={styles.toolbar}>
          <div className={styles.filters} role="group" aria-label="ファイルの状態">
            {FILTERS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                disabled={busy}
                onClick={() => changeFilter(value)}
              >
                {label} <span>{filterCounts[value]}</span>
              </button>
            ))}
          </div>
          <form
            className={styles.search}
            onSubmit={(event) => {
              event.preventDefault();
              if (pagination) navigate(1);
            }}
          >
            <Icon kind="search" />
            <input
              type="search"
              aria-label="ファイルを検索"
              placeholder="ファイルを検索"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(new Map());
              }}
            />
            {pagination ? (
              <button type="submit" className={styles.textButton}>
                検索
              </button>
            ) : null}
          </form>
        </div>
        {(pagination ? pagination.query : query) ? (
          <p className={styles.searchResult}>
            検索結果{' '}
            {pagination?.total ?? items.filter((item) => matchesReviewSearch(item, query)).length}件
          </p>
        ) : null}
        <div className={styles.list}>
          {visibleItems.length > 0 ? (
            <table className={styles.table} aria-label="承認するファイル">
              <colgroup>
                <col className={styles.checkColumn} />
                <col />
                <col className={styles.destinationColumn} />
                <col className={styles.templateColumn} />
                <col className={styles.statusColumn} />
                <col className={styles.previewColumn} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">
                    <input
                      type="checkbox"
                      aria-label="全選択"
                      checked={allSelected}
                      ref={(node) => {
                        if (node) node.indeterminate = chosen.length > 0 && !allSelected;
                      }}
                      disabled={busy || selectable.length === 0}
                      onChange={() => toggleGroup(selectable)}
                    />
                  </th>
                  <th scope="col">ファイル名</th>
                  <th scope="col">配置先</th>
                  <th scope="col">テンプレート</th>
                  <th scope="col">状態</th>
                  <th scope="col">
                    <span className={styles.srOnly}>{boxLinkBase ? 'プレビュー' : '操作'}</span>
                  </th>
                </tr>
              </thead>
              <tbody>{visibleItems.map(renderRow)}</tbody>
            </table>
          ) : null}
          {visibleItems.length === 0 ? (
            <div className={styles.empty}>
              <Icon kind="check" />
              <h2>
                {(pagination?.query ?? query) || filter !== 'all'
                  ? '該当するファイルなし'
                  : '承認待ちなし'}
              </h2>
              <a href={`/jobs/${jobId}`}>進捗画面へ戻る →</a>
            </div>
          ) : null}
        </div>
        <footer className={styles.approvalBar}>
          {pagination && pagination.total > pagination.pageSize ? (
            <nav className={styles.pagination} aria-label="承認一覧のページ">
              <button
                type="button"
                className={styles.textButton}
                disabled={busy || pagination.page <= 1}
                onClick={() => navigate(pagination.page - 1, pagination.query)}
              >
                前へ
              </button>
              <span>
                {(pagination.page - 1) * pagination.pageSize + 1}–
                {Math.min(pagination.page * pagination.pageSize, pagination.total)} /{' '}
                {pagination.total}件
              </span>
              <button
                type="button"
                className={styles.textButton}
                disabled={busy || pagination.page * pagination.pageSize >= pagination.total}
                onClick={() => navigate(pagination.page + 1, pagination.query)}
              >
                次へ
              </button>
            </nav>
          ) : null}
          {error ? (
            <ErrorNotice
              title="操作を完了できませんでした"
              action="受付状況・入力内容と技術情報を確認してください。"
              message={error}
            />
          ) : null}
          {notice ? (
            <p className={styles.notice} role="status">
              {notice} <a href={`/jobs/${jobId}`}>進捗を確認 →</a>
            </p>
          ) : null}
          <div className={styles.approvalActions}>
            <strong>{chosen.length}件を選択中</strong>
            <button
              type="button"
              className={styles.textButton}
              disabled={busy || selected.size === 0}
              onClick={() => {
                setSelected(new Map());
                setBulkEdit(null);
              }}
            >
              選択解除
            </button>
            <div className={styles.bulkButtons}>
              <button
                type="button"
                className="secondary"
                disabled={busy || chosen.length === 0}
                aria-expanded={bulkEdit === 'destination'}
                onClick={() => {
                  setBulkEdit(bulkEdit === 'destination' ? null : 'destination');
                  setBulkValue('');
                }}
              >
                配置先を変更
              </button>
              <button
                type="button"
                className="secondary"
                disabled={
                  busy || chosen.length === 0 || chosen.some((item) => !item.businessMetadata)
                }
                aria-expanded={bulkEdit === 'template'}
                onClick={() => {
                  setBulkEdit(bulkEdit === 'template' ? null : 'template');
                  setBulkValue('');
                }}
              >
                テンプレートを変更
              </button>
            </div>
            <button
              type="button"
              className={styles.primary}
              disabled={
                busy ||
                !!bulkEdit ||
                ready.length === 0 ||
                ready.length !== chosen.length ||
                !operatorLabel.trim()
              }
              onClick={() => void send(ready)}
            >
              {busy ? '送信中…' : `選択した${chosen.length}件を承認`}
            </button>
          </div>
          {bulkEdit && chosen.length > 0 ? (
            <form
              className={styles.bulkEditor}
              onSubmit={(event) => {
                event.preventDefault();
                if (busy || !bulkValue) return;
                if (bulkEdit === 'destination') {
                  for (const item of chosen)
                    updateDraft(item, {
                      destinationKey: bulkValue === '__clear__' ? '' : bulkValue,
                    });
                } else {
                  void selectTemplates(chosen, bulkValue === '__clear__' ? null : bulkValue);
                }
                setBulkEdit(null);
              }}
            >
              <label>
                {bulkEdit === 'destination' ? '一括変更する配置先' : '一括変更するテンプレート'}
                <select
                  value={bulkValue}
                  disabled={busy}
                  onChange={(event) => setBulkValue(event.target.value)}
                >
                  <option value="" disabled>
                    選択してください
                  </option>
                  <option value="__clear__">未選択に戻す</option>
                  {bulkEdit === 'destination'
                    ? destinations
                        .filter((entry) => entry.key !== needsReviewKey)
                        .map((entry) => (
                          <option key={entry.key} value={entry.key}>
                            {entry.label}
                          </option>
                        ))
                    : metadataTemplates.map(({ template }) => (
                        <option
                          key={`${template.scope}/${template.templateKey}`}
                          value={`${template.scope}/${template.templateKey}`}
                        >
                          {template.displayName}
                        </option>
                      ))}
                </select>
              </label>
              <button type="submit" disabled={busy || !bulkValue}>
                選択した{chosen.length}件に適用
              </button>
              <button
                type="button"
                className={styles.textButton}
                disabled={busy}
                onClick={() => setBulkEdit(null)}
              >
                キャンセル
              </button>
            </form>
          ) : null}
          <details className={styles.operator}>
            <summary>承認者</summary>
            <label>
              承認者名
              <input
                type="text"
                value={operatorLabel}
                disabled={busy}
                onChange={(event) => setOperatorLabel(event.target.value)}
              />
            </label>
          </details>
        </footer>
      </section>
      {active ? (
        <aside id="review-inspector" className={styles.inspector} aria-label="ファイルの詳細">
          <div className={styles.inspectorHeader}>
            <h2>ファイルの詳細</h2>
            {active ? (
              <button
                type="button"
                className={styles.textButton}
                aria-label="詳細を閉じる"
                onClick={closeInspector}
              >
                <Icon kind="close" />
              </button>
            ) : null}
          </div>
          {active && draft ? (
            <>
              <div className={styles.inspectorBody}>
                <div className={styles.documentTitle}>
                  <DocumentIcon name={active.sourceFileName} />
                  <h3>{active.sourceFileName}</h3>
                </div>
                <p className={styles.hint}>
                  {formatBytes(active.sourceSize)} · {active.sourceRelativePath}
                </p>
                {boxLink ? (
                  <div className={styles.previewActions}>
                    <FilePreviewButton
                      key={`${active.itemId}:${active.boxFileId}:${active.boxVersionId}:${active.boxSha1}:${active.state}:${active.reviewCommand?.state ?? ''}`}
                      item={active}
                      boxLink={boxLink}
                      disabled={locked || !active.boxVersionId || !active.boxSha1}
                    />
                    <a
                      className={styles.openOriginal}
                      href={boxLink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Icon kind="external" /> Boxで原本を開く
                    </a>
                  </div>
                ) : null}
                {active.reviewCommand?.state === 'REJECTED' ? (
                  <ErrorNotice
                    title="操作を反映できませんでした"
                    action="最新の処理状態と入力内容を確認してください。"
                    message={active.reviewCommand.rejectionReason}
                  />
                ) : null}
                <fieldset disabled={locked} className={styles.fields}>
                  <section>
                    <h3>配置先</h3>
                    <details className={styles.destinationPicker}>
                      <summary>
                        <Icon kind="folder" />
                        <span>
                          {destinations.find((entry) => entry.key === draft.destinationKey)
                            ?.label ?? '配置先を選択'}
                        </span>
                        <span className={styles.changeDestination}>変更</span>
                      </summary>
                      <label>
                        承認する配置先
                        <select
                          value={draft.destinationKey}
                          onChange={(event) =>
                            updateDraft(active, { destinationKey: event.target.value })
                          }
                        >
                          <option value="">配置先を選択…</option>
                          {destinations
                            .filter((entry) => entry.key !== needsReviewKey)
                            .map((entry) => (
                              <option key={entry.key} value={entry.key}>
                                {entry.label}
                              </option>
                            ))}
                        </select>
                      </label>
                    </details>
                    {destinationPath ? <p className={styles.path}>{destinationPath}</p> : null}
                  </section>
                  {active.needsAttention ? (
                    <section className={styles.problem}>
                      <ErrorNotice
                        category={active.lastErrorCategory}
                        message={active.lastError}
                        state={active.state}
                        {...(active.businessMetadata?.extractionStatus === 'FAILED'
                          ? {
                              title: 'メタデータを抽出できませんでした',
                              action:
                                '「項目を確認・編集」から再抽出するか、値を入力してください。',
                            }
                          : {})}
                      />
                      {active.lastErrorCategory === 'MOVE_CONFLICT' ? (
                        <>
                          <label>
                            配置するファイル名
                            <input
                              type="text"
                              value={draft.finalName}
                              onChange={(event) =>
                                updateDraft(active, { finalName: event.target.value })
                              }
                            />
                          </label>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() =>
                              updateDraft(active, { finalName: withNameSuffix(draft.finalName) })
                            }
                          >
                            連番を付ける
                          </button>
                        </>
                      ) : null}
                    </section>
                  ) : null}
                  {classificationReason || classificationFields.length > 0 ? (
                    <section>
                      <h3>{classificationReason ? '分類理由' : '分類結果'}</h3>
                      {classificationReason ? <p>{classificationReason}</p> : null}
                      {classificationFields.length > 0 ? (
                        <dl className={styles.extracted}>
                          {classificationFields.map(([label, value]) => (
                            <Fragment key={label}>
                              <dt>{label}</dt>
                              <dd>{value}</dd>
                            </Fragment>
                          ))}
                        </dl>
                      ) : null}
                    </section>
                  ) : null}
                  {active.businessMetadata ? (
                    <section>
                      <h3>メタデータ</h3>
                      <label>
                        テンプレート
                        <select
                          value={active.businessMetadata.templateId ?? ''}
                          onChange={(event) =>
                            void selectTemplate(active, event.target.value || null)
                          }
                        >
                          <option value="">未選択</option>
                          {active.businessMetadata.template &&
                          !metadataTemplates.some(
                            ({ template }) =>
                              `${template.scope}/${template.templateKey}` ===
                              active.businessMetadata!.templateId,
                          ) ? (
                            <option value={active.businessMetadata.templateId!} disabled>
                              {active.businessMetadata.template.displayName}（選択済み）
                            </option>
                          ) : null}
                          {metadataTemplates.map(({ template }) => (
                            <option
                              key={`${template.scope}/${template.templateKey}`}
                              value={`${template.scope}/${template.templateKey}`}
                            >
                              {template.displayName}
                            </option>
                          ))}
                        </select>
                      </label>
                      {locked && !active.businessMetadata.template ? (
                        <p role="status">処理中</p>
                      ) : null}
                      {active.businessMetadata.template ? (
                        <>
                          <p role="status">{metadataStatus(active, locked)}</p>
                          <details
                            className={styles.more}
                            key={`${active.itemId}:${active.businessMetadata.templateId}`}
                          >
                            <summary>項目を確認・編集</summary>
                            <BusinessMetadataFields
                              template={active.businessMetadata.template}
                              values={draft.businessValues ?? {}}
                              onChange={(businessValues) => updateDraft(active, { businessValues })}
                            />
                            <button
                              type="button"
                              className="ghost"
                              disabled={
                                !active.businessMetadata.canExtract ||
                                !metadataTemplates.some(
                                  ({ template }) =>
                                    `${template.scope}/${template.templateKey}` ===
                                    active.businessMetadata!.templateId,
                                )
                              }
                              onClick={() =>
                                void selectTemplate(active, active.businessMetadata!.templateId)
                              }
                            >
                              再抽出
                            </button>
                          </details>
                        </>
                      ) : null}
                    </section>
                  ) : (
                    <details className={styles.more}>
                      <summary>メタデータを確認・編集</summary>
                      {(
                        [
                          ['documentType', '文書種別'],
                          ['businessDomain', '業務区分'],
                          ['businessIdentifier', '識別情報'],
                          ['effectiveDate', '発効日'],
                          ['suggestedTags', 'タグ（カンマ区切り）'],
                          ['routingReason', '分類理由'],
                        ] as const
                      ).map(([field, label]) => (
                        <label key={field}>
                          {label}
                          <input
                            type={field === 'effectiveDate' ? 'date' : 'text'}
                            value={draft[field]}
                            onChange={(event) =>
                              updateDraft(active, { [field]: event.target.value })
                            }
                          />
                        </label>
                      ))}
                    </details>
                  )}
                  <details className={styles.more}>
                    <summary>検証情報とその他の操作</summary>
                    <dl className={styles.extracted}>
                      <dt>内容の一致</dt>
                      <dd>
                        {active.sourceSha1 && active.sourceSha1 === active.boxSha1
                          ? 'SHA-1 一致'
                          : '未確認・不一致'}
                      </dd>
                      <dt>BoxファイルID</dt>
                      <dd>{active.boxFileId ?? '未取得'}</dd>
                      <dt>バージョン</dt>
                      <dd>{active.boxVersionId ?? '未取得'}</dd>
                      <dt>提案元</dt>
                      <dd>{active.suggestionSource ?? '未取得'}</dd>
                    </dl>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => void send([active], true)}
                    >
                      このファイルを移行対象から除外
                    </button>
                  </details>
                </fieldset>
              </div>
              {active.needsAttention ? (
                <div className={styles.individual}>
                  <button
                    type="button"
                    className="secondary"
                    disabled={
                      locked ||
                      !canApprove(draft, destinations, needsReviewKey) ||
                      !operatorLabel.trim()
                    }
                    onClick={() => void send([active])}
                  >
                    {isReviewPending(active, submitted[active.itemId])
                      ? '処理待ち'
                      : 'このファイルを承認'}
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <p className={styles.inspectorEmpty}>ファイル未選択</p>
          )}
        </aside>
      ) : null}
    </div>
  );
}
