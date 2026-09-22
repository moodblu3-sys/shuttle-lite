import { z } from 'zod';
import { assertBoxFileName, ShuttleError } from '@shuttle-lite/core';

/**
 * Box AIは配置先を決められないとき、catalogのneeds-review keyを答える。これは
 * 実在するfolderのkeyなので、そのまま「AIの提案」として扱うと、誰も判断して
 * いない文書を一括承認で完了させてしまう。判断が付いたかどうかはこの関数で
 * 判定する（受け入れ基準9: 承認前にfinal folderへmoveしない、の延長)。
 */
export function hasRoutingDecision(
  suggestedDestinationKey: string | null,
  needsReviewKey: string,
): boolean {
  return suggestedDestinationKey !== null && suggestedDestinationKey !== needsReviewKey;
}

export const ApprovalRequestSchema = z.object({
  itemId: z.string().min(1),
  destinationKey: z.string().min(1),
  operatorLabel: z.string().min(1).max(120),
  /** What the operator actually saw when approving. */
  observedBoxFileId: z.string().min(1),
  observedSha1: z.string().regex(/^[0-9a-f]{40}$/, 'SHA-1は40桁の16進で指定してください'),
  observedVersionId: z.string().nullish(),
  metadata: z
    .object({
      documentType: z.string().max(120).nullish(),
      businessDomain: z.string().max(60).nullish(),
      businessIdentifier: z.string().max(120).nullish(),
      effectiveDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'effectiveDateは YYYY-MM-DD で指定してください')
        .nullish(),
      suggestedTags: z.string().max(400).nullish(),
      routingReason: z.string().max(500).nullish(),
    })
    .default({}),
  /**
   * 配置時に使うfile名。既定はsourceのfile名。同名衝突 (MOVE_CONFLICT) を
   * 操作者が改名で解消するための唯一の出口なので、ここで受ける。
   */
  finalName: z.string().max(255).nullish(),
});

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export function parseApprovalRequest(
  input: unknown,
  allowedKeys: readonly string[],
): ApprovalRequest {
  const parsed = ApprovalRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new ShuttleError('APPROVAL_INVALID', '承認内容の検証に失敗しました', {
      details: {
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      },
    });
  }
  const key = parsed.data.destinationKey.toUpperCase();
  if (!allowedKeys.includes(key)) {
    throw new ShuttleError('DESTINATION_UNKNOWN', `catalogに存在しないdestinationです: ${key}`);
  }
  const finalName = parsed.data.finalName?.trim() ?? null;
  // 空文字はsourceのfile名を使う意思表示として扱う。値があるなら、Boxが
  // 受け付けない名前で承認を通さない。
  if (finalName) assertBoxFileName(finalName);
  return { ...parsed.data, destinationKey: key, finalName: finalName || null };
}

export interface ApprovalSnapshot {
  readonly approvedDestinationKey: string;
  readonly approvedBoxFileId: string;
  readonly approvedBoxVersionId: string | null;
  readonly approvedSha1: string;
  readonly operatorLabel: string;
  readonly approvedAt: string;
}

export interface CurrentFileState {
  readonly fileId: string;
  readonly sha1: string;
  readonly versionId: string | null;
  readonly parentFolderId: string | null;
}

export type FreshnessResult =
  { readonly fresh: true } | { readonly fresh: false; readonly reason: string };

/**
 * Re-checked by the worker immediately before the move. If anything the
 * operator approved has changed, the item goes back for another decision
 * instead of being placed (docs/requirements.md 4.12).
 */
export function checkApprovalFreshness(
  snapshot: ApprovalSnapshot,
  current: CurrentFileState | null,
  options: { expectedStagingFolderId?: string | null; allowedKeys?: readonly string[] } = {},
): FreshnessResult {
  if (!current) {
    return { fresh: false, reason: '承認対象のfileがBox上に見つかりません' };
  }
  if (current.fileId !== snapshot.approvedBoxFileId) {
    return { fresh: false, reason: 'Box file IDが承認時と異なります' };
  }
  if (current.sha1 !== snapshot.approvedSha1) {
    return { fresh: false, reason: 'file内容 (SHA-1) が承認時と異なります' };
  }
  if (
    snapshot.approvedBoxVersionId &&
    current.versionId &&
    snapshot.approvedBoxVersionId !== current.versionId
  ) {
    return { fresh: false, reason: 'file versionが承認時と異なります' };
  }
  if (
    options.expectedStagingFolderId &&
    current.parentFolderId &&
    current.parentFolderId !== options.expectedStagingFolderId
  ) {
    return { fresh: false, reason: 'fileがstaging folderから移動しています' };
  }
  if (options.allowedKeys && !options.allowedKeys.includes(snapshot.approvedDestinationKey)) {
    return { fresh: false, reason: '承認したdestinationがcatalogから削除されています' };
  }
  return { fresh: true };
}
