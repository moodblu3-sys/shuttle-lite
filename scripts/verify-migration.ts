/**
 * 移行の検証。
 *
 *   npm run verify              全fixtureをfake Boxへ移行し、結果を独立に検証する
 *   npm run verify -- --faults  障害シナリオ（429 / crash復旧 / metadata失敗）も実行する
 *
 * 重要なのは「pipelineが成功したと言っている」ことではなく、
 * 「Box側に実在するbyteがsourceと一致している」ことを別経路で確かめる点である。
 * SQLiteに記録されたSHA-1は使わず、source fileとBox側のobjectの両方から
 * その場でSHA-1を計算して突き合わせる。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  createBoxGateway,
  destinationFolderId,
  ensureBoxLayout,
  FakeBoxGateway,
  loadCachedLayout,
  type BoxGateway,
  type BoxLayout,
} from '@shuttle-lite/box';
import {
  buildConfig,
  fromRepoRoot,
  loadConfig,
  loadDestinationCatalog,
  parseEnv,
  type AppConfig,
  type DestinationCatalogConfig,
} from '@shuttle-lite/config';
import {
  createLogger,
  type MigrationItem,
  Semaphore,
  sha1File,
  ShuttleError,
} from '@shuttle-lite/core';
import { migrate, openDatabase, ShuttleStore } from '@shuttle-lite/db';
import { missingProvenanceKeys, REQUIRED_PROVENANCE_KEYS } from '@shuttle-lite/routing';
import {
  buildReportDocument,
  buildTelemetryPayload,
  JsonlTelemetrySink,
  OutboxSender,
  TELEMETRY_FIELDS,
} from '@shuttle-lite/telemetry';
import { processCommands } from '../apps/worker/src/commands';
import type { WorkerContext } from '../apps/worker/src/context';
import { WorkerRuntime } from '../apps/worker/src/runtime';

const SOURCE_ROOT = fromRepoRoot('fixtures/source');
/** 実行ごとに専用のdirectoryを使う。前回のBox内容を引き継がない。 */
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
/** --real で実Box enterpriseへ移行する。既定はlocalのfake Box。 */
const REAL = process.argv.includes('--real');

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const checks: Check[] = [];

function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? '  OK  ' : ' FAIL '} ${name}\n        ${detail}\n`);
}

function section(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

interface Harness {
  readonly config: AppConfig;
  readonly store: ShuttleStore;
  readonly gateway: BoxGateway;
  readonly catalog: DestinationCatalogConfig;
  readonly layout: BoxLayout;
  readonly ctx: WorkerContext;
  readonly close: () => void;
}

async function createHarness(
  label: string,
  overrides: Record<string, string> = {},
): Promise<Harness> {
  // 実Boxでは stateの置き場だけ分け、Box側のfolder layoutは既存のものを使う。
  const dataDir = REAL
    ? fromRepoRoot(`.shuttle-lite/real/verify/${RUN_ID}`)
    : fromRepoRoot(`.shuttle-lite/verify/${RUN_ID}/${label}`);
  mkdirSync(dataDir, { recursive: true });

  // 実Boxでは、実行ごとに `/Shuttle Lite/_verify/<run>` を作り、その下に
  // 本番と同じlayoutを組む。同じ移行先へ同じ名前を置こうとして2回目以降が
  // 必ずMOVE_CONFLICTになるのを避けるため。本番のdestinationsは触らない。
  const perRunRoot = REAL ? await createVerifyRoot() : null;

  const config = buildConfig(
    parseEnv({
      ...(REAL ? (process.env as Record<string, string>) : { BOX_MODE: 'fake' }),
      ...(perRunRoot
        ? {
            BOX_ROOT_FOLDER_ID: perRunRoot,
            // 本番のfolder IDを引き継がせない。未設定にすると
            // ensureBoxLayoutがper-run rootの下に作り直す。
            BOX_STAGING_FOLDER_ID: '',
            BOX_NEEDS_REVIEW_FOLDER_ID: '',
            BOX_REPORTS_FOLDER_ID: '',
          }
        : {}),
      SHUTTLE_DATA_DIR: dataDir,
      SQLITE_PATH: join(dataDir, 'shuttle.db'),
      LOG_LEVEL: REAL ? 'info' : 'error',
      ...overrides,
    } as NodeJS.ProcessEnv),
  );

  const db = openDatabase({ path: config.sqlitePath });
  migrate(db);
  const store = new ShuttleStore(db, { telemetryPayload: buildTelemetryPayload });
  const gateway = createBoxGateway(config, createLogger(config.logLevel));
  const catalog = loadDestinationCatalog();
  const layout = loadCachedLayout(config) ?? (await ensureBoxLayout(gateway, config, catalog));

  return {
    config,
    store,
    gateway,
    catalog,
    layout,
    ctx: {
      config,
      store,
      gateway,
      catalog,
      layout,
      logger: createLogger(config.logLevel),
      fileGate: new Semaphore(config.limits.fileConcurrency),
      chunkGate: new Semaphore(config.limits.chunkConcurrency),
      workerId: `verify-${label}`,
    },
    close: () => {
      db.close();
      void gateway.close();
    },
  };
}

/**
 * 検証専用の親folderを作る。返すのはそのfolder IDで、この下に本番と同じ
 * 構造（_staging / _needs_review / _reports / destinations）が作られる。
 * 何も削除しないので、run跡はBox上に残る。
 */
async function createVerifyRoot(): Promise<string> {
  const base = loadConfig();
  const gateway = createBoxGateway(base, createLogger('error'));
  try {
    const folder = await gateway.ensureFolderPath(base.box.rootFolderId ?? '0', [
      '_verify',
      RUN_ID,
    ]);
    process.stdout.write(`検証用folder: /Shuttle Lite/_verify/${RUN_ID} (${folder.id})\n`);
    return folder.id;
  } finally {
    await gateway.close();
  }
}

async function runUntilIdle(harness: Harness, maxTicks = 400): Promise<void> {
  const runtime = new WorkerRuntime(harness.ctx, { leaseTtlMs: 120_000, idleDelayMs: 1 });
  let idle = 0;
  for (let tick = 0; tick < maxTicks && idle < 2; tick += 1) {
    const commands = await processCommands(harness.ctx);
    const worked = await runtime.tick();
    idle = commands === 0 && !worked ? idle + 1 : 0;
  }
}

/** すべてのsource fileを、pipelineとは無関係にその場で列挙する。 */
async function listSourceFiles(dir = SOURCE_ROOT): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await listSourceFiles(absolute)));
    else if (entry.isFile()) found.push(absolute);
  }
  return found.sort();
}

async function startJob(harness: Harness): Promise<string> {
  const profile = harness.store.createProfile({
    name: `verify-${Date.now()}`,
    sourceRootPath: SOURCE_ROOT,
    targetStagingFolderId: harness.layout.stagingRootFolderId,
    destinationCatalogId: harness.catalog.id,
    proxyProfileName: 'none',
    metadataTemplateKey: harness.config.box.metadataTemplateKey,
    fileConcurrency: harness.config.limits.fileConcurrency,
    chunkConcurrency: harness.config.limits.chunkConcurrency,
    aiRoutingEnabled: true,
    snowflakeLoggingEnabled: true,
    conflictPolicy: 'RENAME',
  });
  const job = harness.store.createJob({ profileId: profile.id, operatorLabel: 'verify (local)' });
  harness.store.enqueueCommand(job.id, 'START_JOB');
  return job.id;
}

/** 操作者の代わりに承認する。提案がないものは NEEDS_REVIEW へ送る。 */
function approveAll(harness: Harness, jobId: string): { approved: number; manual: number } {
  let approved = 0;
  let manual = 0;
  for (const item of harness.store.listItems(jobId, {
    states: ['REVIEW_REQUIRED', 'NEEDS_REVIEW'],
    limit: 1_000,
  })) {
    const routing = harness.store.getRouting(item.id);
    const suggested = routing?.suggestedDestinationKey;
    const destinationKey = suggested ?? harness.catalog.needsReviewKey;
    if (!suggested) manual += 1;
    approved += 1;
    harness.store.enqueueCommand(jobId, 'APPROVE_ITEM', {
      itemId: item.id,
      destinationKey,
      operatorLabel: 'verify (local)',
      observedBoxFileId: item.boxFileId,
      observedSha1: item.boxSha1,
      observedVersionId: item.boxFileVersionId,
      metadata: {},
    });
  }
  return { approved, manual };
}

async function verifyFullMigration(): Promise<void> {
  section('1. 全fixtureの移行と独立検証');

  const harness = await createHarness('full');
  const sourceFiles = await listSourceFiles();
  const totalSourceBytes = (
    await Promise.all(sourceFiles.map(async (path) => (await stat(path)).size))
  ).reduce((sum, size) => sum + size, 0);
  process.stdout.write(
    `source: ${sourceFiles.length} 件 / ${(totalSourceBytes / 1024 / 1024).toFixed(1)} MB\n\n`,
  );

  const startedAt = Date.now();
  const jobId = await startJob(harness);
  await runUntilIdle(harness);

  const beforeApproval = harness.store.countItemsByState(jobId);
  const reviewCount = (beforeApproval.REVIEW_REQUIRED ?? 0) + (beforeApproval.NEEDS_REVIEW ?? 0);
  check(
    '承認前に最終folderへ移動していない',
    (beforeApproval.COMPLETED ?? 0) === 0 && reviewCount === sourceFiles.length,
    `承認待ち ${reviewCount} 件 / 完了 ${beforeApproval.COMPLETED ?? 0} 件`,
  );

  const categoryBeforeApproval = new Map(
    harness.store
      .listItems(jobId, { limit: 1_000 })
      .map((item) => [item.sourceRelativePath, item.lastErrorCategory] as const),
  );
  const { approved, manual } = approveAll(harness, jobId);
  await runUntilIdle(harness);
  const elapsedMs = Date.now() - startedAt;

  const items = harness.store.listItems(jobId, { limit: 1_000 });
  const completed = items.filter((item) => item.state === 'COMPLETED');
  check(
    '全itemが完了した',
    completed.length === sourceFiles.length,
    `完了 ${completed.length} / 全 ${sourceFiles.length} 件` +
      `（承認 ${approved} 件、うち手動判断 ${manual} 件、${(elapsedMs / 1000).toFixed(1)} 秒）`,
  );
  // 同名fileを同じ配置先へ承認した場合、Boxは同じ名前を2つ持てない。RENAME
  // policyは改名して両方残す。上書きされていないことは、配置後の名前が
  // すべて異なり、file IDも別であることで示す (docs/decisions.md D-017)。
  const renamed = completed.filter((item) => item.finalName !== item.sourceFileName);
  const placedNames = completed.map((item) => `${item.finalFolderId}/${item.finalName}`);
  check(
    '同名fileを同じ配置先へ承認しても上書きしない',
    new Set(placedNames).size === placedNames.length &&
      new Set(completed.map((item) => item.boxFileId)).size === completed.length,
    renamed.length === 0
      ? '衝突は発生しなかった'
      : `改名して配置: ${renamed.map((item) => `${item.sourceFileName} → ${item.finalName}`).join(' | ')}`,
  );

  // ---- Box側の実体を、SQLiteの記録とは独立に検証する --------------------
  const mismatches: string[] = [];
  const missingMetadata: string[] = [];
  const wrongFolder: string[] = [];
  const wrongName: string[] = [];
  const boxFileIds = new Set<string>();
  let verifiedBytes = 0;

  for (const item of completed) {
    const file = await harness.gateway.getFile(item.boxFileId!);
    if (!file) {
      mismatches.push(`${item.sourceRelativePath}: Box上にfileがない`);
      continue;
    }
    boxFileIds.add(file.id);

    // fake なら保存されたbyteからSHA-1を再計算する。実Boxでは、Boxがserver側で
    // 算出して返すSHA-1を使う（pipelineがSQLiteへ記録した値ではない）。
    const sourceDigest = await sha1File(item.sourceAbsolutePath);
    const fake = harness.gateway instanceof FakeBoxGateway ? harness.gateway : null;
    const storedDigest = fake
      ? createHash('sha1').update(fake.readStored(file.id)).digest('hex')
      : file.sha1;
    if (sourceDigest.sha1 !== storedDigest || sourceDigest.bytes !== file.size) {
      mismatches.push(
        `${item.sourceRelativePath}: source ${sourceDigest.sha1.slice(0, 12)}/${sourceDigest.bytes}B vs Box ${storedDigest.slice(0, 12)}/${file.size}B`,
      );
    }
    verifiedBytes += file.size;

    if (file.name !== item.sourceFileName) {
      wrongName.push(`${item.sourceRelativePath}: Box上の名前が ${file.name}`);
    }

    const routing = harness.store.getRouting(item.id);
    const expectedFolder = destinationFolderId(harness.layout, routing!.approvedDestinationKey!);
    if (file.parentFolderId !== expectedFolder) {
      wrongFolder.push(`${item.sourceRelativePath}: ${file.parentFolderId} != ${expectedFolder}`);
    }

    const metadata = await harness.gateway.getMetadata(file.id);
    const missing = missingProvenanceKeys(metadata);
    if (
      missing.length > 0 ||
      metadata?.approvedDestinationKey !== routing!.approvedDestinationKey
    ) {
      missingMetadata.push(
        `${item.sourceRelativePath}: ${missing.join(',') || 'destination不一致'}`,
      );
    }
  }

  check(
    'Box上のSHA-1がsourceと一致する',
    mismatches.length === 0,
    mismatches.length === 0
      ? `${completed.length} 件 / ${(verifiedBytes / 1024 / 1024).toFixed(1)} MB（${REAL ? 'Boxがserver側で算出したSHA-1と照合' : '保存されたbyteから再計算して照合'}）`
      : mismatches.slice(0, 3).join(' | '),
  );
  check(
    '最終配置先が承認どおり',
    wrongFolder.length === 0,
    wrongFolder.length === 0 ? `${completed.length} 件` : wrongFolder.slice(0, 3).join(' | '),
  );
  check(
    'staging名から元のfile名へ戻っている',
    wrongName.length === 0,
    wrongName.length === 0 ? `${completed.length} 件` : wrongName.slice(0, 3).join(' | '),
  );
  check(
    '必須provenance metadataが揃っている',
    missingMetadata.length === 0,
    missingMetadata.length === 0
      ? `${REQUIRED_PROVENANCE_KEYS.length} field × ${completed.length} 件`
      : missingMetadata.slice(0, 3).join(' | '),
  );
  check(
    '重複したBox fileが無い',
    boxFileIds.size === completed.length,
    `Box file ID ${boxFileIds.size} 個 / item ${completed.length} 件`,
  );

  const stagingLeftovers = await harness.gateway.listFolder(
    harness.store.getJob(jobId)!.stagingFolderId!,
  );
  // 配置まで進んだitemはstagingから消える。残っていたら取りこぼしである。
  const parked = items.filter((item) => item.state !== 'COMPLETED');
  check(
    'stagingに残るのは配置まで進んでいないitemだけ',
    stagingLeftovers.length === parked.length,
    `staging 残 ${stagingLeftovers.length} 件 / 未配置 ${parked.length} 件`,
  );

  // ---- 個別に確認したい難しいケース ------------------------------------
  const byPath = new Map(items.map((item) => [item.sourceRelativePath, item] as const));
  const chunked = items.filter((item) => item.uploadStrategy === 'CHUNKED');
  check(
    '50MB超はchunked uploadで転送された',
    chunked.length >= 1 && chunked.every((item) => item.state === 'COMPLETED'),
    chunked.map((item) => `${item.sourceRelativePath} (${item.sourceSize} B)`).join(', ') || 'なし',
  );

  const sameName = items.filter((item) => item.sourceFileName === 'nda.txt');
  check(
    '別folderの同名fileが衝突せずに移行された',
    sameName.length === 2 && new Set(sameName.map((item) => item.boxFileId)).size === 2,
    sameName.map((item) => `${item.sourceRelativePath} -> ${item.boxFileId}`).join(' | '),
  );

  const duplicates = ['duplicates/policy-copy-a.txt', 'duplicates/policy-copy-b.txt']
    .map((path) => byPath.get(path))
    .filter((item): item is MigrationItem => item !== undefined);
  check(
    '同一内容でも別itemとして移行された',
    duplicates.length === 2 &&
      duplicates[0]!.sourceSha1 === duplicates[1]!.sourceSha1 &&
      duplicates[0]!.boxFileId !== duplicates[1]!.boxFileId,
    duplicates.map((item) => `${item.sourceRelativePath} -> ${item.boxFileId}`).join(' | '),
  );

  const unsupported = ['binary/telemetry-dump.zip', 'binary/sensor-capture.bin']
    .map((path) => byPath.get(path))
    .filter((item): item is MigrationItem => item !== undefined);
  check(
    'AI対象外のfileも手動判断で完了できた',
    unsupported.length === 2 && unsupported.every((item) => item.state === 'COMPLETED'),
    unsupported
      .map(
        (item) =>
          `${item.sourceFileName}: ${categoryBeforeApproval.get(item.sourceRelativePath) ?? '-'} -> ${item.state}`,
      )
      .join(' | '),
  );

  const ambiguous = items.filter((item) => item.sourceRelativePath.startsWith('ambiguous/'));
  const suggestions = ambiguous.map((item) => ({
    name: item.sourceFileName,
    key: harness.store.getRouting(item.id)?.suggestedDestinationKey ?? null,
  }));
  const allowedKeys = harness.catalog.entries.map((entry) => entry.key);
  // 実Boxのmodelは fake heuristic より踏み込んで提案する。守るべき性質は
  // 「提案がcatalogのkeyに限られること」であって、必ず控えることではない。
  check(
    'AIの提案がcatalog内のkeyに限られている',
    suggestions.every((entry) => entry.key === null || allowedKeys.includes(entry.key)),
    suggestions.map((entry) => `${entry.name}: ${entry.key ?? '提案なし'}`).join(' | '),
  );

  // ---- Report と telemetry ---------------------------------------------
  const report = buildReportDocument(harness.store, jobId);
  check(
    'ReportからBox fileを特定できる',
    report.rows.length === sourceFiles.length &&
      report.rows.every(
        (row) => row.boxFileId && row.boxLink && row.sha1Verified && row.sizeVerified,
      ),
    `${report.rows.length} 行、完了 ${report.totals.completed} / review待ち ${report.totals.awaitingReview} / 手動override ${report.totals.humanOverrides}`,
  );

  const sink = new JsonlTelemetrySink(harness.config.telemetry.jsonlPath);
  const sender = new OutboxSender({ store: harness.store, sink, batchSize: 500 });
  let delivered = 0;
  for (let i = 0; i < 30; i += 1) {
    const result = await sender.runOnce();
    delivered += result.delivered;
    if (result.claimed === 0) break;
  }
  const jsonl = await readFile(sink.path, 'utf8');
  const lines = jsonl.trim().split('\n').filter(Boolean);
  const allowed = new Set<string>([...TELEMETRY_FIELDS, '_deliveredAt']);
  const extraKeys = new Set<string>();
  for (const line of lines) {
    for (const key of Object.keys(JSON.parse(line) as Record<string, unknown>)) {
      if (!allowed.has(key)) extraKeys.add(key);
    }
  }
  const leakedNames = sourceFiles
    .map((path) => relative(SOURCE_ROOT, path).split(sep).join('/'))
    .filter((relativePath) => jsonl.includes(relativePath));

  check(
    'telemetryが許可fieldだけを送っている',
    extraKeys.size === 0,
    extraKeys.size === 0
      ? `${lines.length} event / ${TELEMETRY_FIELDS.length} field`
      : [...extraKeys].join(','),
  );
  check(
    'telemetryにfile名やpathが混入していない',
    leakedNames.length === 0,
    leakedNames.length === 0 ? `${lines.length} event を検査` : leakedNames.slice(0, 3).join(','),
  );
  check(
    'outboxが全eventを配信した',
    delivered === lines.length && harness.store.outboxStatus(jobId).pending === 0,
    `配信 ${delivered} / 残 ${harness.store.outboxStatus(jobId).pending}`,
  );

  writeFileSync(
    join(harness.config.dataDir, 'evidence.json'),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sourceFiles: sourceFiles.length,
        sourceBytes: totalSourceBytes,
        elapsedMs,
        counts: harness.store.countItemsByState(jobId),
        report: report.totals,
        telemetryEvents: lines.length,
      },
      null,
      2,
    )}\n`,
  );
  harness.close();
}

async function verifyFaultScenarios(): Promise<void> {
  section('2. 障害シナリオ');
  if (REAL) {
    process.stdout.write('  実Boxでは失敗注入を行わないためskipします（fake modeで実施済み）。\n');
    return;
  }

  // 429 と Retry-After -----------------------------------------------------
  {
    const harness = await createHarness('rate-limit', { FAKE_BOX_RATE_LIMIT_EVERY: '4' });
    const jobId = await startJob(harness);
    await runUntilIdle(harness);
    const throttled = harness.store
      .listItems(jobId, { limit: 1_000 })
      .filter((item) => item.lastErrorCategory === 'BOX_RATE_LIMIT');
    const waits = throttled
      .map((item) => (item.nextAttemptAt ? Date.parse(item.nextAttemptAt) - Date.now() : 0))
      .filter((ms) => ms > 0);
    check(
      '429でRetry-Afterの待ち時間を守る',
      throttled.length > 0 && waits.every((ms) => ms <= 1_000),
      `${throttled.length} 件が待機、最大 ${Math.max(0, ...waits)} ms（Retry-After: 1s）`,
    );

    // backoffの待ち時間だけを飛ばし、あとは通常どおり再試行させる。
    // 4回に1回429が返る設定なので、待ち解除は複数回必要になる。
    let rounds = 0;
    for (; rounds < 20; rounds += 1) {
      const waiting = harness.store
        .listItems(jobId, { limit: 1_000 })
        .filter((item) => item.nextAttemptAt !== null);
      if (waiting.length === 0) break;
      for (const item of waiting) harness.store.updateItem(item.id, { nextAttemptAt: null });
      await runUntilIdle(harness);
    }
    const remaining = harness.store.listItems(jobId, { limit: 1_000 });
    const stuck = remaining.filter(
      (item) => item.state !== 'REVIEW_REQUIRED' && item.state !== 'NEEDS_REVIEW',
    );
    const failedItems = remaining.filter((item) => item.state === 'FAILED');
    check(
      '429を挟んでも全件が転送を完了した',
      stuck.length === 0 && failedItems.length === 0,
      stuck.length === 0
        ? `全件が承認待ちに到達（backoff解除 ${rounds} 回、retry合計 ${remaining.reduce((sum, item) => sum + item.retryCount, 0)} 回）`
        : `未達 ${stuck.length} 件: ${stuck
            .map((item) => `${item.sourceFileName}=${item.state}/${item.lastErrorCategory ?? '-'}`)
            .slice(0, 3)
            .join(', ')}`,
    );
    harness.close();
  }

  // Box成功後・SQLite保存前の停止 -----------------------------------------
  {
    const harness = await createHarness('crash');
    const jobId = await startJob(harness);
    await runUntilIdle(harness);
    const item = harness.store.listItems(jobId, { limit: 1 })[0]!;

    // uploadしたがSQLiteへ書く前に落ちた状態を再現する。
    harness.store.updateItem(item.id, {
      state: 'UNKNOWN_OUTCOME',
      resumeState: 'UPLOADING',
      boxFileId: null,
      boxSha1: null,
    });
    const stagingFolderId = harness.store.getJob(jobId)!.stagingFolderId!;
    const before = await harness.gateway.listFolder(stagingFolderId);
    await runUntilIdle(harness);
    const recovered = harness.store.getItem(item.id)!;
    const after = await harness.gateway.listFolder(stagingFolderId);
    const sameNameCount = after.filter((entry) => entry.name === recovered.stagingName).length;
    check(
      '結果不明のuploadを重複なく復旧した',
      recovered.boxFileId !== null &&
        after.length === before.length &&
        sameNameCount === 1 &&
        recovered.state === 'REVIEW_REQUIRED',
      `${recovered.sourceRelativePath}: ${recovered.state} / Box file ${recovered.boxFileId} / staging ${before.length} -> ${after.length} 件（同名 ${sameNameCount} 件）`,
    );
    harness.close();
  }

  // metadata失敗でfileを再uploadしない ------------------------------------
  {
    const harness = await createHarness('metadata');
    const jobId = await startJob(harness);
    const fake = harness.gateway as FakeBoxGateway;
    const realUpload = fake.uploadDirect.bind(fake);
    let uploads = 0;
    fake.uploadDirect = async (request) => {
      uploads += 1;
      return realUpload(request);
    };
    fake.failNext(
      'setMetadata',
      new ShuttleError('BOX_SERVER', 'injected metadata 503', { status: 503 }),
    );
    await runUntilIdle(harness);
    const uploadsAfterFailure = uploads;
    for (const item of harness.store.listItems(jobId, { limit: 1_000 })) {
      harness.store.updateItem(item.id, { nextAttemptAt: null });
    }
    await runUntilIdle(harness);
    const everyItemHasMetadata = harness.store
      .listItems(jobId, { limit: 1_000 })
      .every((item) => item.provenanceAppliedAt !== null);
    check(
      'metadata失敗でfile本体を再uploadしない',
      uploads === uploadsAfterFailure && everyItemHasMetadata,
      `upload回数 ${uploads}（失敗直後 ${uploadsAfterFailure}）、metadata適用済み ${everyItemHasMetadata}`,
    );
    harness.close();
  }
}

async function main(): Promise<void> {
  process.stdout.write('Shuttle Lite 移行検証\n');
  process.stdout.write(`mode: ${REAL ? '実Box enterprise' : 'fake Box (local disk)'}\n`);
  process.stdout.write(`source root: ${SOURCE_ROOT}\n`);

  const sourceFiles = await listSourceFiles().catch(() => []);
  if (sourceFiles.length === 0) {
    process.stderr.write('fixtureがありません。先に npm run fixtures を実行してください。\n');
    process.exitCode = 1;
    return;
  }

  await verifyFullMigration();
  if (process.argv.includes('--faults')) await verifyFaultScenarios();

  const failed = checks.filter((entry) => !entry.ok);
  section('結果');
  process.stdout.write(`${checks.length - failed.length} / ${checks.length} 件の検証項目が成功\n`);
  if (failed.length > 0) {
    for (const entry of failed) process.stdout.write(`  FAIL ${entry.name}: ${entry.detail}\n`);
    process.exitCode = 1;
  }
}

await main();
