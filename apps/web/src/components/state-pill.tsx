import type { ItemState, JobState } from '@shuttle-lite/core';

const ITEM_TONE: Record<string, string> = {
  COMPLETED: 'ok',
  SKIPPED: 'ghost',
  FAILED: 'bad',
  NEEDS_REVIEW: 'warn',
  REVIEW_REQUIRED: 'wait',
  RETRY_WAIT: 'warn',
  UNKNOWN_OUTCOME: 'warn',
  PAUSED: 'ghost',
};

const STATE_LABELS: Record<ItemState | JobState, string> = {
  QUEUED: '未開始',
  SCANNING: 'スキャン中',
  RUNNING: '実行中',
  DISCOVERED: '検出済み',
  HASHING: 'ハッシュ計算中',
  PREFLIGHT: '事前確認中',
  READY: '転送待ち',
  UPLOADING: '転送中',
  STAGED: '一時保管済み',
  TRANSFER_VERIFIED: '転送検証済み',
  PROVENANCE_PENDING: '移行情報の付与待ち',
  PROVENANCE_APPLIED: '移行情報の付与済み',
  AI_PENDING: 'AI分類待ち',
  AI_COMPLETED: 'AI分類済み',
  REVIEW_REQUIRED: '承認待ち',
  APPROVED: '承認済み',
  MOVING: '配置中',
  FINAL_VERIFY: '最終検証中',
  COMPLETED: '完了',
  PAUSED: '一時停止',
  RETRY_WAIT: '再試行待ち',
  UNKNOWN_OUTCOME: '結果確認待ち',
  NEEDS_REVIEW: '要確認',
  SKIPPED: 'スキップ',
  FAILED: '失敗',
};

export function StatePill({ state }: { state: ItemState | JobState | string }) {
  const tone = ITEM_TONE[state] ?? 'run';
  return (
    <span className={`pill ${tone}`}>{STATE_LABELS[state as ItemState | JobState] ?? state}</span>
  );
}
