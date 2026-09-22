/**
 * Synthetic migration dataset (docs/requirements.md section 7).
 *
 * Everything here is invented. No customer content, no credentials.
 * Run with `npm run fixtures`. Add `--force` to overwrite existing files.
 */
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fromRepoRoot } from '@shuttle-lite/config';

const ROOT = fromRepoRoot('fixtures/source');
const force = process.argv.includes('--force');

interface Fixture {
  readonly path: string;
  readonly body: string;
}

function contract(index: number, party: string, date: string): Fixture {
  return {
    path: `legal/contracts/msa-${party.toLowerCase()}-${index}.txt`,
    body: [
      '業務委託契約書',
      `契約番号: LEG-2026-${String(1000 + index)}`,
      `発効日 ${date}`,
      `委託者 (甲): 架空ホールディングス株式会社`,
      `受託者 (乙): ${party} 合同会社`,
      '',
      '第1条 甲および乙は、本契約に基づき業務委託を行う。',
      '第2条 契約期間は発効日から1年とし、以後1年ごとに自動更新する。',
      '第3条 秘密保持義務は契約終了後3年間存続する。',
      '',
      '（これはsynthetic dataです。実在の企業・契約とは関係ありません。）',
    ].join('\n'),
  };
}

function invoice(index: number, vendor: string, date: string, amount: number): Fixture {
  return {
    path: `finance/invoices/invoice-${date.replace(/-/g, '')}-${index}.txt`,
    body: [
      '請求書 / Invoice',
      `請求番号: FIN-2026-${String(2000 + index)}`,
      `発行日 ${date}`,
      `請求先: 架空ホールディングス株式会社 経理部`,
      `請求元: ${vendor}`,
      `金額: ${amount.toLocaleString('ja-JP')} 円`,
      `消費税: ${Math.round(amount * 0.1).toLocaleString('ja-JP')} 円`,
      '支払期限: 翌月末日',
      '',
      '（synthetic data）',
    ].join('\n'),
  };
}

function employee(index: number, name: string, joined: string): Fixture {
  return {
    path: `hr/records/employee-${String(3000 + index)}.txt`,
    body: [
      '従業員記録',
      `社員番号: HR-2026-${String(3000 + index)}`,
      `氏名: ${name}（架空）`,
      `入社日 ${joined}`,
      '所属: 技術本部 ソリューション部',
      '人事評価: 2026年度上期 A',
      'payroll区分: 月給',
      '',
      '（synthetic data。実在の人物ではありません。）',
    ].join('\n'),
  };
}

function runbook(index: number, system: string, date: string): Fixture {
  return {
    path: `it/runbooks/${system}-runbook-${index}.md`,
    body: [
      `# ${system} 運用手順書`,
      '',
      `文書番号: IT-2026-${String(4000 + index)}`,
      `更新日 ${date}`,
      '',
      '## 障害対応手順',
      '1. 監視dashboardでalertを確認する',
      '2. incident channelを作成する',
      '3. deployを停止する',
      '4. rollback手順を実行する',
      '',
      '（synthetic data）',
    ].join('\n'),
  };
}

function proposal(index: number, customer: string, date: string): Fixture {
  return {
    path: `sales/proposals/proposal-${customer.toLowerCase()}-${index}.txt`,
    body: [
      '提案書 / Proposal',
      `文書番号: SLS-2026-${String(5000 + index)}`,
      `提出日 ${date}`,
      `提案先: ${customer} 株式会社（架空）`,
      '',
      'SOW: Box Platformを用いた文書移行のPoC',
      '見積: 初期構築 3,000,000 円 / 月額運用 200,000 円',
      'pricingは概算です。',
      '',
      '（synthetic data）',
    ].join('\n'),
  };
}

const FIXTURES: Fixture[] = [
  contract(1, 'Alpha', '2026-04-01'),
  contract(2, 'Bravo', '2026-05-15'),
  contract(3, 'Charlie', '2026-06-30'),
  contract(4, 'Delta', '2026-07-01'),

  invoice(1, 'Alpha 合同会社', '2026-04-30', 1_200_000),
  invoice(2, 'Bravo 合同会社', '2026-05-31', 480_000),
  invoice(3, 'Charlie 合同会社', '2026-06-30', 95_000),
  invoice(4, 'Delta 合同会社', '2026-07-31', 2_400_000),
  invoice(5, 'Echo 合同会社', '2026-08-31', 33_000),

  employee(1, '山田 太郎', '2024-04-01'),
  employee(2, '佐藤 花子', '2025-10-01'),
  employee(3, '鈴木 一郎', '2026-01-06'),
  employee(4, '高橋 次郎', '2026-04-01'),

  runbook(1, 'box-sync', '2026-03-12'),
  runbook(2, 'proxy', '2026-04-20'),
  runbook(3, 'sqlite-backup', '2026-05-08'),
  runbook(4, 'snowflake-loader', '2026-06-18'),

  proposal(1, 'Foxtrot', '2026-02-10'),
  proposal(2, 'Golf', '2026-03-22'),
  proposal(3, 'Hotel', '2026-05-19'),
  proposal(4, 'India', '2026-07-07'),

  // Ambiguous on purpose: matches contract and invoice rules equally, so the
  // AI must abstain and the operator has to decide.
  {
    path: 'ambiguous/contract-and-invoice-1.txt',
    body: [
      '契約に基づく請求のご案内',
      '契約番号: LEG-2026-9001 / 請求番号: FIN-2026-9001',
      '発行日 2026-06-01',
      '本書は契約書の写しと請求書を1通にまとめたものです。',
      '（synthetic data）',
    ].join('\n'),
  },
  {
    path: 'ambiguous/proposal-and-contract-1.txt',
    body: [
      '提案書および契約条件の確認',
      '提案書番号: SLS-2026-9002 / 契約番号: LEG-2026-9002',
      '見積と契約条項を併記しています。',
      '（synthetic data）',
    ].join('\n'),
  },
  {
    path: 'ambiguous/untitled-notes.txt',
    body: ['メモ', '', '2026-06-05 打ち合わせの覚書。分類のための手掛かりはありません。'].join(
      '\n',
    ),
  },

  // Same file name in two different folders: staging names differ because the
  // item ID is part of them, so this must not cause a conflict.
  {
    path: 'legal/contracts/nda.txt',
    body: [
      '秘密保持契約書 NDA',
      '契約番号: LEG-2026-7001',
      '発効日 2026-04-10',
      '（synthetic data）',
    ].join('\n'),
  },
  {
    path: 'sales/proposals/nda.txt',
    body: ['提案時に締結するNDAの雛形', '文書番号: SLS-2026-7001', '（synthetic data）'].join('\n'),
  },

  // Byte-identical content at two paths: two separate migration items.
  {
    path: 'duplicates/policy-copy-a.txt',
    body: ['社内規程 v3', '文書番号: IT-2026-8001', '運用手順の概要', '（synthetic data）'].join(
      '\n',
    ),
  },
  {
    path: 'duplicates/policy-copy-b.txt',
    body: ['社内規程 v3', '文書番号: IT-2026-8001', '運用手順の概要', '（synthetic data）'].join(
      '\n',
    ),
  },

  // Box AI cannot read this one: the manual path has to stay reachable.
  {
    path: 'binary/telemetry-dump.zip',
    body: 'PK\u0003\u0004 synthetic-not-a-real-archive',
  },
  {
    path: 'binary/sensor-capture.bin',
    body: '\u0000\u0001\u0002synthetic binary payload',
  },
];

/** Larger than DIRECT_UPLOAD_MAX_BYTES so the chunked path is exercised. */
const LARGE_FILE = {
  path: 'large/archive-export-2026.txt',
  sizeBytes: 52 * 1024 * 1024,
};

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeFixture(relativePath: string, body: string): Promise<'written' | 'skipped'> {
  const absolute = join(ROOT, relativePath);
  if (!force && (await exists(absolute))) return 'skipped';
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${body}\n`, 'utf8');
  return 'written';
}

async function writeLargeFixture(): Promise<'written' | 'skipped'> {
  const absolute = join(ROOT, LARGE_FILE.path);
  if (!force && (await exists(absolute))) return 'skipped';
  await mkdir(dirname(absolute), { recursive: true });
  const header = Buffer.from(
    '運用手順 archive export (synthetic). このfileはchunked uploadの検証用です。\n',
    'utf8',
  );
  const filler = Buffer.alloc(1024 * 1024, 0x41);
  const chunks: Buffer[] = [header];
  let size = header.byteLength;
  while (size + filler.byteLength <= LARGE_FILE.sizeBytes) {
    chunks.push(filler);
    size += filler.byteLength;
  }
  await writeFile(absolute, Buffer.concat(chunks));
  return 'written';
}

async function main(): Promise<void> {
  if (process.argv.includes('--clean')) {
    await rm(ROOT, { recursive: true, force: true });
  }
  await mkdir(ROOT, { recursive: true });
  let written = 0;
  let skipped = 0;
  for (const fixture of FIXTURES) {
    const result = await writeFixture(fixture.path, fixture.body);
    if (result === 'written') written += 1;
    else skipped += 1;
  }
  const large = await writeLargeFixture();
  if (large === 'written') written += 1;
  else skipped += 1;

  process.stdout.write(
    [
      `fixtures: ${ROOT}`,
      `  生成: ${written} 件`,
      `  既存のためskip: ${skipped} 件 (--force で上書き)`,
      `  合計: ${FIXTURES.length + 1} 件 (うち 1 件は ${LARGE_FILE.sizeBytes / 1024 / 1024}MB でchunked upload用)`,
      '',
    ].join('\n'),
  );
}

await main();
