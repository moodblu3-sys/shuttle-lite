import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha1File, ShuttleError } from '@shuttle-lite/core';
import { buildReportDocument, reportToCsv, type ReportRow } from '@shuttle-lite/telemetry';
import type { WorkerContext } from './context';

export interface ReportArtifacts {
  readonly jobId: string;
  readonly rows: readonly ReportRow[];
  readonly jsonPath: string;
  readonly csvPath: string;
  readonly boxJsonFileId: string | null;
  readonly boxCsvFileId: string | null;
}

/**
 * Writes the CSV and JSON report locally and uploads both to the Box
 * `_reports` folder, so the evidence lives next to the migrated content
 * (docs/requirements.md section 4.15).
 */
export async function generateReport(
  ctx: WorkerContext,
  jobId: string,
  assertOwned: () => void = () => {},
): Promise<ReportArtifacts> {
  if (!ctx.store.getJob(jobId)) {
    throw new ShuttleError('STATE_INVALID', `jobが存在しません: ${jobId}`);
  }
  const document = buildReportDocument(ctx.store, jobId);
  const stamp = document.generatedAt.replace(/[:.]/g, '-');
  await mkdir(ctx.config.reportsDir, { recursive: true });

  const jsonPath = join(ctx.config.reportsDir, `${jobId}-${stamp}.json`);
  const csvPath = join(ctx.config.reportsDir, `${jobId}-${stamp}.csv`);
  await writeFile(jsonPath, `${JSON.stringify(document, null, 2)}\n`);
  await writeFile(csvPath, reportToCsv(document.rows));

  const uploaded: Record<'json' | 'csv', string | null> = { json: null, csv: null };
  for (const [kind, path] of [
    ['json', jsonPath],
    ['csv', csvPath],
  ] as const) {
    assertOwned();
    try {
      const digest = await sha1File(path);
      const file = await ctx.gateway.uploadDirect({
        parentFolderId: ctx.layout.reportsFolderId,
        name: `${jobId}-${stamp}.${kind}`,
        size: digest.bytes,
        sha1Hex: digest.sha1,
        content: () => createReadStream(path),
      });
      uploaded[kind] = file.id;
    } catch (error) {
      // A report upload failure is reported, but it never fails the migration.
      ctx.logger.warn('report uploadに失敗しました', { kind, message: (error as Error).message });
    }
  }

  assertOwned();
  const missing = (['json', 'csv'] as const).filter((kind) => uploaded[kind] === null);
  if (missing.length > 0) {
    const message = `レポートのBox保存を確認できませんでした（${missing.join('・').toUpperCase()}）。CSV・JSONは画面から取得できます。`;
    ctx.store.appendEvent({ jobId, phase: 'FINAL_VERIFY', status: 'FAILED', message });
    throw new ShuttleError('BOX_SERVER', message);
  }

  ctx.store.appendEvent({
    jobId,
    phase: 'FINAL_VERIFY',
    status: 'SUCCEEDED',
    message: `report生成: ${document.rows.length}件 (completed ${document.totals.completed} / failed ${document.totals.failed})`,
  });

  return {
    jobId,
    rows: document.rows,
    jsonPath,
    csvPath,
    boxJsonFileId: uploaded.json,
    boxCsvFileId: uploaded.csv,
  };
}
