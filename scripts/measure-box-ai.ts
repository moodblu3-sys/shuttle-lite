/**
 * 実BoxでのBox AI Structured Extractを測る。
 *
 *   npm run measure:ai
 *
 * 目的は docs/decisions.md の Q-004 に実測で答えること。
 *   - upload直後にrepresentationが生成されるまでの待ち時間（202が返る回数）
 *   - confidenceが返るのか
 *   - PDFでの抽出精度（.txtとの違い）
 *   - catalog外のkeyを返さないか
 *
 * 隔離した `/Shuttle Lite/_verify/ai-<実行時刻>` へuploadする。何も削除しない。
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createBoxGateway } from '@shuttle-lite/box';
import { fromRepoRoot, loadConfig, loadDestinationCatalog } from '@shuttle-lite/config';
import { createLogger, sha1File, sleep, toShuttleError } from '@shuttle-lite/core';
import { hasRoutingDecision, normalizeExtraction, routingOutcome } from '@shuttle-lite/routing';

const SOURCE = fromRepoRoot(
  process.argv.find((a) => a.startsWith('--source='))?.slice(9) ?? 'fixtures/source-pdf',
);
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');

interface Measurement {
  readonly path: string;
  readonly sizeKb: number;
  readonly notReadyCount: number;
  readonly waitedMs: number;
  readonly provider: string;
  readonly documentType: string | null;
  readonly businessIdentifier: string | null;
  readonly effectiveDate: string | null;
  readonly suggestion: string;
  readonly confidence: number | null;
  readonly rejectedKey: string | null;
  readonly error: string | null;
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(abs)));
    else if (entry.isFile()) out.push(abs);
  }
  return out.sort();
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.box.mode !== 'real') {
    process.stderr.write('BOX_MODE=real が必要です。\n');
    process.exitCode = 1;
    return;
  }

  const files = await listFiles(SOURCE).catch(() => []);
  if (files.length === 0) {
    process.stderr.write(
      `fixtureがありません: ${SOURCE}\n先に npm run fixtures:pdf を実行してください。\n`,
    );
    process.exitCode = 1;
    return;
  }

  const catalog = loadDestinationCatalog();
  const keys = catalog.entries.map((entry) => entry.key);
  const gateway = createBoxGateway(config, createLogger('error'));

  process.stdout.write(`Box AI 実測\n  source: ${SOURCE}\n  files : ${files.length}\n`);

  const root = await gateway.ensureFolderPath(config.box.rootFolderId ?? '0', [
    '_verify',
    `ai-${RUN_ID}`,
  ]);
  process.stdout.write(`  upload先: /Shuttle Lite/_verify/ai-${RUN_ID} (${root.id})\n\n`);

  const results: Measurement[] = [];
  for (const path of files) {
    const rel = relative(SOURCE, path).split(sep).join('/');
    const digest = await sha1File(path);
    const sizeKb = Math.round((await stat(path)).size / 1024);
    const name = `${rel.replace(/[\\/]/g, '_')}`;

    const file = await gateway.uploadDirect({
      parentFolderId: root.id,
      name,
      size: digest.bytes,
      sha1Hex: digest.sha1,
      content: () => createReadStream(path),
    });

    // uploadしてから何秒でextractが通るかを測る。
    const started = Date.now();
    let notReady = 0;
    let measurement: Measurement | null = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        const response = await gateway.extractStructured({
          fileId: file.id,
          destinationKeys: keys,
          fileName: name,
        });
        const extraction = normalizeExtraction(response, keys);
        const outcome = routingOutcome(extraction);
        measurement = {
          path: rel,
          sizeKb,
          notReadyCount: notReady,
          waitedMs: Date.now() - started,
          provider: extraction.provider,
          documentType: extraction.documentType,
          businessIdentifier: extraction.businessIdentifier,
          effectiveDate: extraction.effectiveDate,
          suggestion: outcome.kind === 'SUGGESTED' ? outcome.destinationKey : '提案なし',
          confidence: extraction.confidence,
          rejectedKey: extraction.rejectedDestinationKey,
          error: null,
        };
        break;
      } catch (error) {
        const e = toShuttleError(error);
        if (e.category === 'AI_NOT_READY') {
          notReady += 1;
          await sleep(e.retryAfterMs ?? 3_000);
          continue;
        }
        measurement = {
          path: rel,
          sizeKb,
          notReadyCount: notReady,
          waitedMs: Date.now() - started,
          provider: '-',
          documentType: null,
          businessIdentifier: null,
          effectiveDate: null,
          suggestion: '-',
          confidence: null,
          rejectedKey: null,
          error: `${e.category}: ${e.message.slice(0, 60)}`,
        };
        break;
      }
    }
    if (measurement) {
      results.push(measurement);
      process.stdout.write(
        `  ${measurement.path.padEnd(38)} ${String(measurement.waitedMs).padStart(6)}ms ` +
          `202×${measurement.notReadyCount} ${measurement.suggestion.padEnd(18)} ` +
          `${measurement.error ?? measurement.documentType ?? '-'}\n`,
      );
    }
  }

  await gateway.close();

  const ok = results.filter((r) => r.error === null);
  const waits = ok.map((r) => r.waitedMs);
  process.stdout.write('\n=== まとめ ===\n');
  process.stdout.write(`  成功                 : ${ok.length} / ${results.length}\n`);
  if (waits.length > 0) {
    process.stdout.write(
      `  extractまでの待ち時間 : 最小 ${Math.min(...waits)}ms / 最大 ${Math.max(...waits)}ms / 平均 ${Math.round(waits.reduce((a, b) => a + b, 0) / waits.length)}ms\n`,
    );
  }
  process.stdout.write(
    `  AI_NOT_READY (202)    : 合計 ${results.reduce((sum, r) => sum + r.notReadyCount, 0)} 回\n`,
  );
  process.stdout.write(
    `  confidenceが返った件数 : ${ok.filter((r) => r.confidence !== null).length} / ${ok.length}\n`,
  );
  process.stdout.write(
    `  catalog外のkeyを返した : ${results.filter((r) => r.rejectedKey !== null).length} 件\n`,
  );
  process.stdout.write(
    // NEEDS_REVIEWはcatalogに実在するkeyだが判断ではない。提案として数えると
    // 「15件すべて提案あり」と読めてしまい、AIが判断を断った件が見えなくなる。
    `  判断あり / 判断を断った : ${ok.filter((r) => hasRoutingDecision(r.suggestion, catalog.needsReviewKey)).length} / ${ok.filter((r) => !hasRoutingDecision(r.suggestion, catalog.needsReviewKey)).length}\n`,
  );
  process.stdout.write('\n=== 抽出値 ===\n');
  for (const r of ok) {
    process.stdout.write(
      `  ${r.path}\n    documentType=${r.documentType ?? '-'} / identifier=${r.businessIdentifier ?? '-'} / effectiveDate=${r.effectiveDate ?? '-'}\n`,
    );
  }
}

await main();
