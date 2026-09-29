'use client';

import { BoxLabel } from './box-label';

import { useMemo, useState } from 'react';
import type { DestinationOption } from '../lib/review-types';
import { WorkspaceIcon } from './workspace-icon';
import styles from './review-workspace.module.css';

type FolderNode = {
  path: string;
  name: string;
  destination?: DestinationOption;
  children: Map<string, FolderNode>;
};

// 承認APIと同じカタログを使い、この移行で選べる配置先だけを表示する。
function folderTree(destinations: readonly DestinationOption[], needsReviewKey: string) {
  const roots = new Map<string, FolderNode>();
  for (const destination of destinations) {
    if (destination.key === needsReviewKey) continue;
    const segments = destination.boxPath.split('/').filter(Boolean);
    if (!segments.length) segments.push(destination.label);
    let level = roots;
    for (let index = 0; index < segments.length; index++) {
      const name = segments[index]!;
      let node = level.get(name);
      if (!node) {
        node = { path: segments.slice(0, index + 1).join('/'), name, children: new Map() };
        level.set(name, node);
      }
      if (index === segments.length - 1) node.destination = destination;
      level = node.children;
    }
  }
  return roots;
}

export function ReviewDestinationPane({
  destinations,
  needsReviewKey,
  count,
  disabled,
  onApply,
}: {
  destinations: readonly DestinationOption[];
  needsReviewKey: string;
  count: number;
  disabled: boolean;
  onApply: (destinationKey: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = useMemo(
    () => folderTree(destinations, needsReviewKey),
    [destinations, needsReviewKey],
  );
  const selected = destinations.find(
    (entry) => entry.key === selectedKey && entry.key !== needsReviewKey,
  );
  const needle = query.trim().toLocaleLowerCase();
  function matches(node: FolderNode): boolean {
    return (
      !needle ||
      node.path.toLocaleLowerCase().includes(needle) ||
      [...node.children.values()].some(matches)
    );
  }
  function toggle(path: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }
  function folders(nodes: Map<string, FolderNode>) {
    return (
      <ul className={styles.folderTree}>
        {[...nodes.values()].filter(matches).map((node) => {
          const hasChildren = node.children.size > 0;
          const expanded = !!needle || !collapsed.has(node.path);
          return (
            <li key={node.path}>
              <div className={styles.folderRow}>
                {hasChildren ? (
                  <button
                    type="button"
                    className={styles.folderToggle}
                    aria-label={`${node.path}を${expanded ? '折りたたむ' : '展開'}`}
                    aria-expanded={expanded}
                    disabled={disabled || !!needle}
                    onClick={() => toggle(node.path)}
                  >
                    <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                  </button>
                ) : (
                  <span className={styles.folderSpacer} />
                )}
                {node.destination ? (
                  <button
                    type="button"
                    className={styles.folderChoice}
                    aria-label={`${node.path}を配置先に選択`}
                    aria-pressed={selected?.key === node.destination.key}
                    title={node.path}
                    disabled={disabled}
                    onClick={() => setSelectedKey(node.destination!.key)}
                  >
                    <WorkspaceIcon kind="folder" />
                    <span>{node.name}</span>
                  </button>
                ) : (
                  <span className={styles.folderAncestor} title={node.path}>
                    <WorkspaceIcon kind="folder" />
                    <span>{node.name}</span>
                  </span>
                )}
              </div>
              {hasChildren && expanded ? folders(node.children) : null}
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <section className={styles.destinationPane} aria-label="Boxの配置先">
      <header className={styles.paneHeading}>
        <h2>
          <BoxLabel>Boxの配置先</BoxLabel>
        </h2>
      </header>
      <div className={styles.folderSearch}>
        <WorkspaceIcon kind="search" />
        <input
          type="search"
          placeholder="フォルダーを検索"
          aria-label="配置先フォルダーを検索"
          value={query}
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className={styles.folderList}>
        {folders(tree)}
        {![...tree.values()].some(matches) ? (
          <p className={styles.folderEmpty}>
            {needle ? '一致するフォルダーはありません' : '選択できる配置先はありません'}
          </p>
        ) : null}
      </div>
      <div className={styles.destinationActions}>
        <span>選択中の配置先</span>
        <p>
          <WorkspaceIcon kind="folder" />
          <span title={selected?.boxPath}>{selected?.boxPath ?? '未選択'}</span>
        </p>
        <button
          type="button"
          className="secondary"
          disabled={disabled || count === 0 || !selected}
          onClick={() => {
            if (selected) onApply(selected.key);
          }}
        >
          選択した{count}件の配置先に指定
        </button>
        <button
          type="button"
          className={styles.textButton}
          disabled={disabled || count === 0}
          onClick={() => onApply('')}
        >
          配置先を未選択に戻す
        </button>
      </div>
    </section>
  );
}
