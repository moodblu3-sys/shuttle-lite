'use client';

import {
  loadReviewDraft,
  saveReviewDraft,
  validReviewDraft,
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
  groupReviewItems,
  matchesReviewSearch,
  isReviewPending,
  reviewRevision,
  type ApprovalDraft,
} from '../lib/review-model';
import { DocumentIcon, WorkspaceIcon as Icon } from './workspace-icon';
import styles from './review-workspace.module.css';

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
  const active = items.find((item) => item.itemId === activeId);
  const { groups, attention, undecided } = groupReviewItems(
    items,
    destinations,
    needsReviewKey,
    currentDraft,
  );
  const visibleItems = items.filter(
    (item) =>
      (pagination || matchesReviewSearch(item, query)) &&
      (filter === 'all' || categoryFor(item, currentDraft(item), true) === filter),
  );
  const pending = visibleItems.filter((item) => !isReviewPending(item, submitted[item.itemId]));
  const ready = bulkReviewItems(pending, selected, currentDraft, destinations, needsReviewKey);
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
    // Never reuse edits against a new worker snapshot (version, error or AI result).
    return validReviewDraft(item, edit) ? edit!.draft : draftFor(item);
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
          if (validReviewDraft(item, previous[item.itemId]))
            restored[item.itemId] = previous[item.itemId]!;
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
    if (onNavigate) onNavigate(page, search, nextFilter);
    else router.push(pageUrl(page, search, nextFilter));
  }
  function changeFilter(nextFilter: ReviewFilter) {
    setSelected(new Map());
    setActiveId(null);
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
    setSelected((previous) => {
      const next = new Map(previous);
      next.delete(item.itemId);
      return next;
    });
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
    const available = group.filter((item) => !isReviewPending(item, submitted[item.itemId]));
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
  async function selectTemplate(item: ReviewItemView, templateId: string | null) {
    if (sending.current || !item.businessMetadata) return;
    sending.current = true;
    setBusy(true);
    setError(null);
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
      if (!response.ok) throw new Error(data.error);
      setSubmitted((previous) => ({ ...previous, [item.itemId]: data.command }));
      setSelected((previous) => {
        const next = new Map(previous);
        next.delete(item.itemId);
        return next;
      });
      refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  function renderRow(item: ReviewItemView, bulk: boolean) {
    const queued = isReviewPending(item, submitted[item.itemId]);
    const changed = currentDraft(item).destinationKey !== draftFor(item).destinationKey;
    const subtitle = duplicateNames.has(item.sourceFileName)
      ? item.sourceRelativePath
      : item.lastError;
    return (
      <li
        key={item.itemId}
        className={`${styles.fileRow} ${activeId === item.itemId ? styles.focused : ''}`}
      >
        {bulk ? (
          <input
            type="checkbox"
            checked={isSelected(item)}
            disabled={busy || queued}
            onChange={() => toggleGroup([item])}
            aria-label={`${item.sourceRelativePath} を選択`}
          />
        ) : (
          <span className={styles.checkboxSpacer} />
        )}
        <button
          id={`review-file-${item.itemId}`}
          type="button"
          className={styles.fileButton}
          aria-pressed={activeId === item.itemId}
          aria-controls="review-inspector"
          onClick={() => setActiveId(item.itemId)}
        >
          <DocumentIcon name={item.sourceFileName} />
          <span className={styles.fileText}>
            <strong>{item.sourceFileName}</strong>
            {subtitle ? <span>{subtitle}</span> : null}
          </span>
          <span className={styles.templateCell}>
            <span title={item.businessMetadata?.template?.displayName}>
              {item.businessMetadata
                ? (item.businessMetadata.template?.displayName ?? '未選択')
                : '—'}
            </span>
            {item.businessMetadata?.template ? <small>{metadataStatus(item, queued)}</small> : null}
          </span>
          <span className={`${styles.status} ${!bulk ? styles.warning : ''}`}>
            {queued
              ? '処理待ち'
              : changed
                ? '配置先を変更'
                : item.needsAttention
                  ? '要対応'
                  : bulk
                    ? '承認待ち'
                    : '未選択'}
          </span>
        </button>
      </li>
    );
  }
  function renderSection(
    key: string,
    title: string,
    group: readonly ReviewItemView[],
    bulk: boolean,
  ) {
    const visible = group.filter((item) => visibleItems.includes(item));
    if (visible.length === 0) return null;
    const available = visible.filter((item) => !isReviewPending(item, submitted[item.itemId]));
    return (
      <section
        key={key}
        className={`${styles.group} ${!bulk ? styles.exceptionGroup : ''}`}
        aria-label={title}
      >
        <div className={styles.groupHeader}>
          <Icon kind="folder" />
          <div>
            <h2>
              {title} <span>{visible.length}件</span>
            </h2>
          </div>
          {bulk ? (
            <button
              type="button"
              className={styles.textButton}
              disabled={busy || available.length === 0}
              onClick={() => toggleGroup(visible)}
            >
              {available.length > 0 && available.every((item) => isSelected(item))
                ? '選択を解除'
                : '全選択'}
            </button>
          ) : null}
        </div>
        <ul className={styles.files}>{visible.map((item) => renderRow(item, bulk))}</ul>
      </section>
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
    <div className={`${styles.workspace} ${!active ? styles.withoutInspector : ''}`}>
      <section className={styles.main} aria-label="分類結果">
        <header className={styles.heading}>
          <p className={styles.breadcrumb}>
            <a href="/">移行一覧</a> / <a href={`/jobs/${jobId}`}>進捗</a> / 承認
          </p>
          <h1>分類結果を確認</h1>
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
            <div className={styles.columnHead} aria-hidden="true">
              <span>ファイル名</span>
              <span>テンプレート</span>
              <span>状態</span>
            </div>
          ) : null}
          {renderSection('attention', '対応が必要', attention, false)}
          {groups.map(({ destination, items: group }) =>
            renderSection(destination.key, destination.label, group, true),
          )}
          {renderSection('undecided', '未選択', undecided, false)}
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
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className={styles.notice} role="status">
              {notice} <a href={`/jobs/${jobId}`}>進捗を確認 →</a>
            </p>
          ) : null}
          <div className={styles.approvalActions}>
            <strong>{ready.length}件を選択中</strong>
            <button
              type="button"
              className={styles.textButton}
              disabled={busy || selected.size === 0}
              onClick={() => setSelected(new Map())}
            >
              選択解除
            </button>
            <button
              type="button"
              className={styles.primary}
              disabled={busy || ready.length === 0 || !operatorLabel.trim()}
              onClick={() => void send(ready)}
            >
              {busy ? '送信中…' : `選択した${ready.length}件を承認`}
            </button>
          </div>
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
                  <p className="error" role="alert">
                    操作を反映できませんでした。
                    {active.reviewCommand.rejectionReason}
                  </p>
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
                  {active.needsAttention && (active.lastError || active.operatorAction) ? (
                    <section className={styles.problem}>
                      <h3>要対応</h3>
                      <p>{active.lastError}</p>
                      <p>{active.operatorAction}</p>
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
            </>
          ) : (
            <p className={styles.inspectorEmpty}>ファイル未選択</p>
          )}
        </aside>
      ) : null}
    </div>
  );
}
