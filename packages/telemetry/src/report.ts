import type { ShuttleStore } from '@shuttle-lite/db';

export interface ReportRow {
  readonly migrationItemId: string;
  readonly sourceRelativePath: string;
  readonly sourceFileName: string;
  readonly sourceSize: number;
  readonly sourceSha1: string | null;
  readonly boxFileId: string | null;
  readonly boxLink: string | null;
  readonly finalDestinationKey: string | null;
  readonly finalFolderId: string | null;
  readonly finalName: string | null;
  readonly sizeVerified: boolean;
  readonly sha1Verified: boolean;
  readonly metadataStatus: string;
  readonly suggestedDestinationKey: string | null;
  readonly humanOverride: boolean;
  readonly aiProvider: string | null;
  readonly retryCount: number;
  readonly finalState: string;
  readonly errorCategory: string | null;
  readonly errorReason: string | null;
}

export const REPORT_COLUMNS = [
  'migrationItemId',
  'sourceRelativePath',
  'sourceFileName',
  'sourceSize',
  'sourceSha1',
  'boxFileId',
  'boxLink',
  'finalDestinationKey',
  'finalFolderId',
  'finalName',
  'sizeVerified',
  'sha1Verified',
  'metadataStatus',
  'suggestedDestinationKey',
  'humanOverride',
  'aiProvider',
  'retryCount',
  'finalState',
  'errorCategory',
  'errorReason',
] as const;

/**
 * Source to target mapping for docs/requirements.md section 4.15. Read only:
 * both the worker and the web app build the same rows from SQLite.
 */
export function buildReportRows(store: ShuttleStore, jobId: string): ReportRow[] {
  return store.listItems(jobId, { limit: 10_000 }).map((item) => {
    const routing = store.getRouting(item.id);
    const extraction = store.latestExtraction(item.id);
    return {
      migrationItemId: item.id,
      sourceRelativePath: item.sourceRelativePath,
      sourceFileName: item.sourceFileName,
      sourceSize: item.sourceSize,
      sourceSha1: item.sourceSha1,
      boxFileId: item.boxFileId,
      boxLink: item.boxFileId ? `https://app.box.com/file/${item.boxFileId}` : null,
      finalDestinationKey: routing?.approvedDestinationKey ?? null,
      finalFolderId: item.finalFolderId,
      finalName: item.finalName,
      sizeVerified: item.boxSize !== null && item.boxSize === item.sourceSize,
      sha1Verified: item.boxSha1 !== null && item.boxSha1 === item.sourceSha1,
      metadataStatus: item.provenanceAppliedAt ? 'APPLIED' : 'MISSING',
      suggestedDestinationKey: routing?.suggestedDestinationKey ?? null,
      humanOverride: routing?.humanOverride ?? false,
      aiProvider: extraction?.provider ?? null,
      retryCount: item.retryCount,
      finalState: item.state,
      errorCategory: item.lastErrorCategory,
      errorReason: item.lastError,
    };
  });
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function reportToCsv(rows: readonly ReportRow[]): string {
  const lines = [REPORT_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(REPORT_COLUMNS.map((column) => csvEscape(row[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export interface ReportDocument {
  readonly jobId: string;
  readonly generatedAt: string;
  readonly operatorLabel: string;
  readonly totals: {
    readonly items: number;
    readonly completed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly awaitingReview: number;
    readonly humanOverrides: number;
  };
  readonly rows: readonly ReportRow[];
}

export function buildReportDocument(store: ShuttleStore, jobId: string): ReportDocument {
  const rows = buildReportRows(store, jobId);
  const job = store.getJob(jobId);
  return {
    jobId,
    generatedAt: new Date().toISOString(),
    operatorLabel: job?.operatorLabel ?? 'unknown',
    totals: {
      items: rows.length,
      completed: rows.filter((row) => row.finalState === 'COMPLETED').length,
      failed: rows.filter((row) => row.finalState === 'FAILED').length,
      skipped: rows.filter((row) => row.finalState === 'SKIPPED').length,
      awaitingReview: rows.filter(
        (row) => row.finalState === 'REVIEW_REQUIRED' || row.finalState === 'NEEDS_REVIEW',
      ).length,
      humanOverrides: rows.filter((row) => row.humanOverride).length,
    },
    rows,
  };
}
