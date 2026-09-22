'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { formatBytes } from '@shuttle-lite/core/progress';
import { withNameSuffix } from '@shuttle-lite/core/naming';
import type { DestinationOption, ReviewItemView } from '../lib/review-types';

interface ApprovalDraft {
  readonly destinationKey: string;
  readonly finalName: string;
  readonly documentType: string;
  readonly businessDomain: string;
  readonly businessIdentifier: string;
  readonly effectiveDate: string;
  readonly suggestedTags: string;
  readonly routingReason: string;
}

function draftFor(item: ReviewItemView): ApprovalDraft {
  return {
    // No suggestion means no preselected destination. Defaulting to the first
    // catalog entry would invite an accidental wrong placement.
    destinationKey: item.hasRoutingDecision ? (item.suggestedDestinationKey as string) : '',
    finalName: item.finalName ?? item.sourceFileName,
    documentType: item.extraction?.documentType ?? '',
    businessDomain: item.extraction?.businessDomain ?? '',
    businessIdentifier: item.extraction?.businessIdentifier ?? '',
    effectiveDate: item.extraction?.effectiveDate ?? '',
    suggestedTags: item.extraction?.suggestedTags.join(',') ?? '',
    routingReason: item.suggestionReason ?? '',
  };
}

function commandFor(item: ReviewItemView, draft: ApprovalDraft, operatorLabel: string) {
  const text = (value: string) => (value.trim().length > 0 ? value.trim() : null);
  return {
    type: 'APPROVE_ITEM' as const,
    payload: {
      itemId: item.itemId,
      destinationKey: draft.destinationKey,
      operatorLabel,
      observedBoxFileId: item.boxFileId,
      observedSha1: item.boxSha1,
      observedVersionId: item.boxVersionId,
      // sourceのfile名どおりに置くなら指示は送らない。
      finalName:
        draft.finalName.trim() === item.sourceFileName ? null : (text(draft.finalName) ?? null),
      metadata: {
        documentType: text(draft.documentType),
        businessDomain: text(draft.businessDomain),
        businessIdentifier: text(draft.businessIdentifier),
        effectiveDate: text(draft.effectiveDate),
        suggestedTags: text(draft.suggestedTags),
        routingReason: text(draft.routingReason),
      },
    },
  };
}

export function ReviewList({
  jobId,
  items,
  destinations,
  needsReviewKey,
  defaultOperatorLabel,
  boxLinkBase,
}: {
  jobId: string;
  items: readonly ReviewItemView[];
  destinations: readonly DestinationOption[];
  /** Catalog key the AI uses to decline. Not a decision. */
  needsReviewKey: string;
  defaultOperatorLabel: string;
  /** Null in fake mode: a Box web link would 404 for a synthetic file ID. */
  boxLinkBase: string | null;
}) {
  const router = useRouter();
  const [operatorLabel, setOperatorLabel] = useState(defaultOperatorLabel);
  const [drafts, setDrafts] = useState<Record<string, ApprovalDraft>>(() =>
    Object.fromEntries(items.map((item) => [item.itemId, draftFor(item)])),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showSuggested, setShowSuggested] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * An item that came back from a failed step must leave the bulk groups.
   * Re-sending the identical approval reproduces the identical failure, which
   * is what made bulk approve look like an endless loop.
   */
  const attention = useMemo(() => items.filter((item) => item.needsAttention), [items]);
  const suggested = useMemo(
    () => items.filter((item) => item.hasRoutingDecision && !item.needsAttention),
    [items],
  );
  const undecided = useMemo(
    () => items.filter((item) => !item.hasRoutingDecision && !item.needsAttention),
    [items],
  );

  /** Same source file name in two places: the operator must not confuse them. */
  const duplicateNames = useMemo(() => {
    const seen = new Map<string, number>();
    for (const item of items) {
      seen.set(item.sourceFileName, (seen.get(item.sourceFileName) ?? 0) + 1);
    }
    return new Set([...seen].filter(([, count]) => count > 1).map(([name]) => name));
  }, [items]);

  /** Lets the operator sanity-check how the AI clustered the batch. */
  const suggestionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of suggested) {
      const key = item.suggestedDestinationKey ?? '';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [suggested]);

  const selectedReady = [...selected].filter((id) => (drafts[id]?.destinationKey ?? '') !== '');

  function updateDraft(itemId: string, patch: Partial<ApprovalDraft>) {
    setDrafts((current) => ({
      ...current,
      [itemId]: { ...(current[itemId] ?? ({} as ApprovalDraft)), ...patch },
    }));
  }

  function toggle(set: Set<string>, id: string): Set<string> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  function toggleGroup(group: readonly ReviewItemView[]) {
    const ids = group.map((item) => item.itemId);
    const allSelected = ids.every((id) => selected.has(id));
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  async function sendAll(targets: readonly ReviewItemView[], label: string) {
    if (targets.length === 0) return;
    setBusy(label);
    setError(null);
    setProgress({ done: 0, total: targets.length });
    let done = 0;
    const failures: string[] = [];
    for (const item of targets) {
      const draft = drafts[item.itemId];
      if (!draft || draft.destinationKey === '') continue;
      try {
        const response = await fetch(`/api/jobs/${jobId}/commands`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(commandFor(item, draft, operatorLabel)),
        });
        if (!response.ok) {
          const body = (await response.json()) as { error?: string };
          failures.push(`${item.sourceFileName}: ${body.error ?? response.status}`);
        }
      } catch (cause) {
        failures.push(`${item.sourceFileName}: ${(cause as Error).message}`);
      }
      done += 1;
      setProgress({ done, total: targets.length });
    }
    if (failures.length > 0) setError(failures.slice(0, 3).join(' / '));
    setBusy(null);
    setProgress(null);
    setSelected(new Set());
    router.refresh();
  }

  async function skip(item: ReviewItemView) {
    if (!window.confirm(`${item.sourceFileName} をskipします。Boxへは配置されません。`)) return;
    setBusy(`skip-${item.itemId}`);
    setError(null);
    try {
      await fetch(`/api/jobs/${jobId}/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'SKIP_ITEM',
          payload: { itemId: item.itemId, reason: '操作者がskipしました' },
        }),
      });
      router.refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) {
    return (
      <div className="card">
        <h2>承認待ちはありません</h2>
        <p className="muted small">
          <a href={`/jobs/${jobId}`}>進捗画面へ戻る</a>
        </p>
      </div>
    );
  }

  function renderRow(item: ReviewItemView) {
    const draft = drafts[item.itemId] ?? draftFor(item);
    const isOpen = expanded.has(item.itemId);
    const overriding =
      item.hasRoutingDecision && draft.destinationKey !== item.suggestedDestinationKey;
    const confidence = item.extraction?.confidence ?? null;
    const sha1Match =
      item.sourceSha1 !== null && item.boxSha1 !== null && item.sourceSha1 === item.boxSha1;
    const boxLink =
      boxLinkBase !== null && item.boxFileId !== null ? `${boxLinkBase}${item.boxFileId}` : null;
    // The reason names the catalog keys the AI could not choose between.
    // Offering them as one click is faster than hunting through the select.
    const candidates =
      !item.hasRoutingDecision && item.suggestionReason !== null
        ? destinations.filter(
            (destination) =>
              destination.key !== needsReviewKey &&
              item.suggestionReason?.includes(destination.key),
          )
        : [];

    return (
      <div key={item.itemId} className={`review-row${isOpen ? ' open' : ''}`}>
        <div className="review-summary">
          <input
            type="checkbox"
            checked={selected.has(item.itemId)}
            onChange={() => setSelected((current) => toggle(current, item.itemId))}
            aria-label={`${item.sourceRelativePath} を選択`}
          />

          <div className="review-name">
            <span className="review-path mono" title={item.sourceRelativePath}>
              {item.sourceRelativePath}
            </span>
            <span className="review-meta small">
              <span className="muted review-size">{formatBytes(item.sourceSize)}</span>
              {duplicateNames.has(item.sourceFileName) ? (
                <span className="pill warn">同名あり</span>
              ) : null}
              {confidence !== null ? (
                <span className="muted">confidence {confidence.toFixed(2)}</span>
              ) : null}
              {/* A blocked row states its failure below; repeating the reason
                  here only buries the file name. */}
              {item.suggestionReason && !item.needsAttention ? (
                <span className="review-reason muted" title={item.suggestionReason}>
                  {item.suggestionReason}
                </span>
              ) : null}
            </span>
          </div>

          <select
            value={draft.destinationKey}
            onChange={(event) => updateDraft(item.itemId, { destinationKey: event.target.value })}
            className={`review-select${draft.destinationKey === '' ? ' review-select-empty' : ''}`}
            aria-label={`${item.sourceRelativePath} の配置先`}
          >
            <option value="">配置先を選択…</option>
            {destinations.map((destination) => (
              <option key={destination.key} value={destination.key}>
                {destination.key}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="secondary"
            disabled={busy !== null || draft.destinationKey === ''}
            onClick={() => void sendAll([item], `one-${item.itemId}`)}
          >
            {busy === `one-${item.itemId}` ? '承認中…' : '承認'}
          </button>
          <button
            type="button"
            className="ghost"
            aria-expanded={isOpen}
            onClick={() => setExpanded((current) => toggle(current, item.itemId))}
          >
            {isOpen ? '閉じる' : '詳細'}
          </button>
        </div>

        {/* The reason this row is back must be readable without expanding it,
            otherwise the operator just presses approve again. */}
        {item.needsAttention ? (
          <div className="review-blocked">
            <p className="small">
              <span className="pill bad">{item.lastErrorCategory}</span>{' '}
              {item.lastError ?? '前回の処理が失敗しました。'}
            </p>
            {/* MOVE_CONFLICT has its own control below, so the generic
                guidance would just repeat it. */}
            {item.operatorAction && item.lastErrorCategory !== 'MOVE_CONFLICT' ? (
              <p className="small muted">{item.operatorAction}</p>
            ) : null}
            {item.lastErrorCategory === 'MOVE_CONFLICT' ? (
              <>
                <p className="small muted">
                  {item.finalName === null
                    ? '承認すると、空いている名前に連番を付けて配置します。名前を決めたい場合は入力してください。'
                    : '指定された名前は使われています。別の名前を入力してください。'}
                </p>
                <div className="row review-rename">
                  <label>
                    配置するfile名
                    <input
                      type="text"
                      value={draft.finalName}
                      onChange={(event) =>
                        updateDraft(item.itemId, { finalName: event.target.value })
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() =>
                      updateDraft(item.itemId, { finalName: withNameSuffix(draft.finalName) })
                    }
                  >
                    連番を付ける
                  </button>
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {candidates.length > 0 ? (
          <div className="review-candidates">
            <span className="small muted">AIが迷った候補</span>
            {candidates.map((destination) => (
              <button
                key={destination.key}
                type="button"
                className="ghost"
                onClick={() => updateDraft(item.itemId, { destinationKey: destination.key })}
              >
                {destination.key}
              </button>
            ))}
          </div>
        ) : null}

        {overriding ? (
          <p className="small overriding">
            AI提案 <code className="mono">{item.suggestedDestinationKey}</code> → 承認{' '}
            <code className="mono">{draft.destinationKey || '未選択'}</code>
            （human overrideとして記録します）
          </p>
        ) : null}

        {isOpen ? (
          <div className="review-detail">
            {/* First, because the document itself is what the placement
                decision rests on. The file is already in Box staging, so
                Boxのpreviewで開く。PDFやOfficeが対象なので、local fileの冒頭を
                textとして出す方法では中身が読めない。 */}
            <h3>文書を確認する</h3>
            {boxLink === null ? (
              <p className="muted small">
                fake modeではBoxのpreviewを開けません。source pathとAIの結果で判断してください。
              </p>
            ) : (
              <p className="small">
                <a className="open-in-box" href={boxLink} target="_blank" rel="noreferrer">
                  Boxで{item.sourceFileName}を開く
                </a>
                <span className="muted"> — 配置前のstaging folderにあります</span>
              </p>
            )}

            <div className="grid cols-2">
              <div>
                <h3>SourceとBox</h3>
                <dl className="kv">
                  <dt>File名</dt>
                  <dd>{item.sourceFileName}</dd>
                  <dt>内容の一致</dt>
                  <dd>
                    {sha1Match ? (
                      <>
                        <span className="pill ok">SHA-1 一致</span>{' '}
                        <span className="mono small muted" title={item.sourceSha1 ?? ''}>
                          {(item.sourceSha1 ?? '').slice(0, 12)}…
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="pill bad">未一致</span>
                        <div className="mono small">source {item.sourceSha1 ?? '-'}</div>
                        <div className="mono small">box&nbsp;&nbsp;&nbsp;{item.boxSha1 ?? '-'}</div>
                      </>
                    )}
                  </dd>
                  <dt>Box file</dt>
                  <dd className="mono small">
                    {item.boxFileId === null ? (
                      '-'
                    ) : boxLink === null ? (
                      item.boxFileId
                    ) : (
                      <a href={boxLink} target="_blank" rel="noreferrer">
                        {item.boxFileId}
                      </a>
                    )}
                    {item.boxVersionId ? ` (version ${item.boxVersionId})` : ''}
                  </dd>
                </dl>
                {item.lastErrorCategory ? (
                  <p className="notice small">
                    <strong>{item.lastErrorCategory}</strong>
                    {item.lastError ? <> — {item.lastError}</> : null}
                    {item.operatorAction ? (
                      <>
                        <br />
                        推奨対応: {item.operatorAction}
                      </>
                    ) : null}
                  </p>
                ) : null}
              </div>

              <div>
                <h3>AIの抽出結果</h3>
                {item.extraction ? (
                  <dl className="kv">
                    <dt>Provider</dt>
                    <dd>{item.extraction.provider}</dd>
                    <dt>提案元 / 理由</dt>
                    <dd>
                      {item.suggestionSource ?? '-'}
                      {item.suggestionReason ? ` — ${item.suggestionReason}` : ''}
                    </dd>
                    <dt>Reference</dt>
                    <dd>{item.extraction.references.join(' / ') || '-'}</dd>
                  </dl>
                ) : (
                  <p className="muted small">
                    AIの抽出結果はありません。下の項目を手動で入力してください。
                  </p>
                )}
                <p className="small muted">
                  抽出fieldのconfidenceは、destination提案が正しい確率ではありません。
                </p>
              </div>
            </div>

            <h3>Boxへ書き込むmetadata</h3>
            <div className="row">
              <label>
                documentType
                <input
                  type="text"
                  value={draft.documentType}
                  onChange={(event) =>
                    updateDraft(item.itemId, { documentType: event.target.value })
                  }
                />
              </label>
              <label>
                businessDomain
                <input
                  type="text"
                  value={draft.businessDomain}
                  onChange={(event) =>
                    updateDraft(item.itemId, { businessDomain: event.target.value })
                  }
                />
              </label>
              <label>
                businessIdentifier
                <input
                  type="text"
                  value={draft.businessIdentifier}
                  onChange={(event) =>
                    updateDraft(item.itemId, { businessIdentifier: event.target.value })
                  }
                />
              </label>
            </div>
            <div className="row">
              <label>
                effectiveDate
                <input
                  type="date"
                  value={draft.effectiveDate}
                  onChange={(event) =>
                    updateDraft(item.itemId, { effectiveDate: event.target.value })
                  }
                />
              </label>
              <label>
                suggestedTags
                <input
                  type="text"
                  value={draft.suggestedTags}
                  onChange={(event) =>
                    updateDraft(item.itemId, { suggestedTags: event.target.value })
                  }
                />
              </label>
              <label style={{ flex: '2 1 320px' }}>
                routingReason
                <input
                  type="text"
                  value={draft.routingReason}
                  onChange={(event) =>
                    updateDraft(item.itemId, { routingReason: event.target.value })
                  }
                />
              </label>
            </div>

            <div className="actions">
              <button
                type="button"
                className="ghost"
                disabled={busy !== null}
                onClick={() => void skip(item)}
              >
                {busy === `skip-${item.itemId}` ? '送信中…' : 'このfileをskipする'}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <div className="review-bar">
        <div className="review-bar-main">
          <div>
            <div className="review-count">{items.length} 件が承認待ち</div>
            <div className="small muted">
              {attention.length > 0 ? `要対応 ${attention.length} 件 / ` : ''}
              要判断 {undecided.length} 件 / AI提案あり {suggested.length} 件
            </div>
          </div>
          {selectedReady.length > 0 ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void sendAll(
                  items.filter((item) => selectedReady.includes(item.itemId)),
                  'bulk-selected',
                )
              }
            >
              {busy === 'bulk-selected'
                ? `承認中… ${progress?.done ?? 0}/${progress?.total ?? 0}`
                : `選択した ${selectedReady.length} 件を承認`}
            </button>
          ) : null}
        </div>
        {error ? <p className="error">{error}</p> : null}
      </div>

      {/* First: these are the only rows where pressing approve unchanged is
          guaranteed to fail again. */}
      {attention.length > 0 ? (
        <section className="review-group review-group-blocked">
          <div className="review-group-head">
            <div>
              <h2>
                対応が必要 <span className="review-group-count">{attention.length} 件</span>
              </h2>
              <p className="small muted">
                前の処理が失敗して戻ってきたfileです。理由を読んでから1件ずつ承認してください。
                まとめて承認の対象には入りません。
              </p>
            </div>
          </div>
          <div className="review-rows">{attention.map(renderRow)}</div>
        </section>
      ) : null}

      {undecided.length > 0 ? (
        <section className="review-group review-group-attention">
          <div className="review-group-head">
            <div>
              <h2>
                あなたの判断が必要 <span className="review-group-count">{undecided.length} 件</span>
              </h2>
              <p className="small muted">
                AIが配置先を提案できませんでした。配置先を選ぶと承認できます。
              </p>
            </div>
            <button type="button" className="ghost" onClick={() => toggleGroup(undecided)}>
              この{undecided.length}件を選択
            </button>
          </div>
          <div className="review-rows">{undecided.map(renderRow)}</div>
        </section>
      ) : null}

      {suggested.length > 0 ? (
        <section className="review-group">
          <div className="review-group-head">
            <div>
              <h2>
                AI提案どおりで良い <span className="review-group-count">{suggested.length} 件</span>
              </h2>
              <div className="dest-counts">
                {suggestionCounts.map(([key, count]) => (
                  <span key={key} className="pill run">
                    {key} {count}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="actions">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void sendAll(suggested, 'bulk-suggested')}
            >
              {busy === 'bulk-suggested'
                ? `承認中… ${progress?.done ?? 0}/${progress?.total ?? 0}`
                : `AI提案どおり ${suggested.length} 件をまとめて承認`}
            </button>
            <button
              type="button"
              className="ghost"
              aria-expanded={showSuggested}
              onClick={() => setShowSuggested((value) => !value)}
            >
              {showSuggested ? '一覧を隠す' : '1件ずつ確認する'}
            </button>
            {showSuggested ? (
              <button type="button" className="ghost" onClick={() => toggleGroup(suggested)}>
                この{suggested.length}件を選択
              </button>
            ) : null}
          </div>
          {showSuggested ? <div className="review-rows">{suggested.map(renderRow)}</div> : null}
        </section>
      ) : null}

      <details className="review-notice">
        <summary>承認の扱いについて</summary>
        <p className="small muted">
          confidenceが高い場合でも自動moveしません。承認は<strong>local operator label</strong>
          として記録され、Box上で本人確認されたuserの承認ではありません。承認後、workerが file
          ID・version・metadata・destinationを再確認してからBox内でmoveします。
        </p>
        <label className="operator-input">
          承認者 (local operator label)
          <input
            type="text"
            value={operatorLabel}
            onChange={(event) => setOperatorLabel(event.target.value)}
          />
        </label>
      </details>
    </>
  );
}
