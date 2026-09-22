/**
 * Synthetic な業務文書をPDFで生成する。
 *
 *   npm run fixtures:pdf
 *
 * 既存の .txt fixtureはBox AIでも読めるが、顧客の実態はPDFとOfficeである。
 * PDFでの抽出精度とrepresentation生成の待ち時間を測るために、テキスト層が
 * 正しく入ったPDFが必要になる。
 *
 * macOSの `cupsfilter` は日本語フォントを埋め込むが `/ToUnicode` を出力せず、
 * 見た目は正しいのにテキスト抽出ができないPDFになる。そのためHTMLを
 * headless Chromeで印刷する方式を採る。Chromeは ToUnicode を出力する。
 *
 * 前提: /Applications/Google Chrome.app
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fromRepoRoot } from '@shuttle-lite/config';

const execFileAsync = promisify(execFile);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = fromRepoRoot('fixtures/source-pdf');
const WORK_DIR = fromRepoRoot('.shuttle-lite/pdf-build');

interface DocSpec {
  readonly path: string;
  readonly title: string;
  readonly fields: ReadonlyArray<readonly [string, string]>;
  readonly body: readonly string[];
}

const SHARED_STYLE = `
  @page { size: A4; margin: 20mm; }
  body { font-family: "Hiragino Sans", "Noto Sans JP", sans-serif; font-size: 10.5pt; color: #111; line-height: 1.7; }
  h1 { font-size: 16pt; text-align: center; letter-spacing: 0.15em; margin: 0 0 6mm; }
  table.meta { width: 100%; border-collapse: collapse; margin-bottom: 8mm; font-size: 9.5pt; }
  table.meta th { width: 32mm; text-align: left; color: #555; font-weight: 600; padding: 1.6mm 0; vertical-align: top; }
  table.meta td { padding: 1.6mm 0; }
  .body p { margin: 0 0 3mm; }
  .seal { margin-top: 12mm; text-align: right; color: #666; font-size: 9pt; }
  .note { margin-top: 14mm; padding-top: 3mm; border-top: 1px solid #ccc; color: #777; font-size: 8.5pt; }
`;

function render(doc: DocSpec): string {
  const rows = doc.fields.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('\n      ');
  const body = doc.body.map((p) => `<p>${p}</p>`).join('\n      ');
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>${doc.title}</title>
<style>${SHARED_STYLE}</style></head>
<body>
  <h1>${doc.title}</h1>
  <table class="meta">
      ${rows}
  </table>
  <div class="body">
      ${body}
  </div>
  <div class="seal">架空ホールディングス株式会社</div>
  <div class="note">本書はShuttle Liteの検証用に生成したsynthetic dataです。実在の企業・人物・契約とは関係ありません。</div>
</body></html>`;
}

const DOCS: DocSpec[] = [
  {
    path: 'legal/contracts/msa-alpha.pdf',
    title: '業務委託契約書',
    fields: [
      ['契約番号', 'LEG-2026-1001'],
      ['発効日', '2026-04-01'],
      ['契約期間', '発効日から1年（以後1年ごとに自動更新）'],
      ['委託者（甲）', '架空ホールディングス株式会社'],
      ['受託者（乙）', 'Alpha 合同会社'],
    ],
    body: [
      '第1条（目的） 甲は乙に対し、次条に定める業務を委託し、乙はこれを受託する。',
      '第2条（委託業務） 文書管理基盤の設計、構築および運用支援に関する業務とする。',
      '第3条（委託料） 月額 1,200,000 円（消費税別）とし、翌月末日までに支払う。',
      '第4条（秘密保持） 本契約に関して知り得た秘密情報は、契約終了後3年間は第三者に開示しない。',
    ],
  },
  {
    path: 'legal/contracts/nda-bravo.pdf',
    title: '秘密保持契約書',
    fields: [
      ['契約番号', 'LEG-2026-7001'],
      ['発効日', '2026-04-10'],
      ['開示者', '架空ホールディングス株式会社'],
      ['受領者', 'Bravo 合同会社'],
    ],
    body: [
      '第1条（秘密情報） 本契約における秘密情報とは、開示者が受領者に開示した技術上または営業上の情報をいう。',
      '第2条（目的外使用の禁止） 受領者は秘密情報を本目的以外に使用してはならない。',
      '第3条（有効期間） 本契約の有効期間は締結日から3年とする。',
    ],
  },
  {
    path: 'finance/invoices/invoice-2026-04.pdf',
    title: '請求書',
    fields: [
      ['請求番号', 'FIN-2026-2001'],
      ['発行日', '2026-04-30'],
      ['支払期限', '2026-05-31'],
      ['請求先', '架空ホールディングス株式会社 経理部'],
      ['請求元', 'Alpha 合同会社'],
    ],
    body: [
      '下記のとおりご請求申し上げます。',
      '件名: 文書管理基盤 構築支援（2026年4月分）',
      '小計 1,200,000 円 / 消費税 120,000 円 / 合計 1,320,000 円',
      'お振込先: 架空銀行 丸の内支店 普通 1234567',
    ],
  },
  {
    path: 'finance/invoices/invoice-2026-05.pdf',
    title: '請求書',
    fields: [
      ['請求番号', 'FIN-2026-2002'],
      ['発行日', '2026-05-31'],
      ['支払期限', '2026-06-30'],
      ['請求先', '架空ホールディングス株式会社 経理部'],
      ['請求元', 'Charlie 合同会社'],
    ],
    body: [
      '下記のとおりご請求申し上げます。',
      '件名: 運用支援（2026年5月分）',
      '小計 480,000 円 / 消費税 48,000 円 / 合計 528,000 円',
    ],
  },
  {
    path: 'hr/records/employee-3001.pdf',
    title: '従業員記録',
    fields: [
      ['社員番号', 'HR-2026-3001'],
      ['氏名', '山田 太郎（架空）'],
      ['入社日', '2024-04-01'],
      ['所属', '技術本部 ソリューション部'],
      ['雇用区分', '正社員（月給）'],
    ],
    body: [
      '2026年度上期の人事評価は A とする。',
      '前年度からの主な変更点: 担当領域をsolution architectureへ拡大。',
      '本記録は人事部が管理し、閲覧は権限を持つ者に限る。',
    ],
  },
  {
    path: 'it/runbooks/proxy-runbook.pdf',
    title: '運用手順書 — 明示的proxy',
    fields: [
      ['文書番号', 'IT-2026-4002'],
      ['更新日', '2026-04-20'],
      ['対象system', '明示的proxy (Squid)'],
      ['作成者', 'IT運用部'],
    ],
    body: [
      '1. 監視dashboardでalertを確認する。',
      '2. incident channelを作成し、影響範囲を記録する。',
      '3. proxyのaccess logで 407 および TCP_DENIED の発生を確認する。',
      '4. 復旧しない場合はdeployを停止し、前構成へrollbackする。',
    ],
  },
  {
    path: 'sales/proposals/proposal-foxtrot.pdf',
    title: 'ご提案書',
    fields: [
      ['文書番号', 'SLS-2026-5001'],
      ['提出日', '2026-02-10'],
      ['提案先', 'Foxtrot 株式会社（架空）'],
      ['提案元', '架空ホールディングス株式会社'],
    ],
    body: [
      '1. ご提案の概要: Box Platformを用いた文書移行のPoCを実施します。',
      '2. 対象範囲 (SOW): 対象folderの分析、移行、metadata付与、検証報告。',
      '3. 概算見積: 初期構築 3,000,000 円、月額運用 200,000 円。',
      '4. 前提: 明示的proxy経由での接続、移行対象は約1TB。',
    ],
  },
  // 意図的に判断が難しい文書。契約と請求の両方の性質を持つ。
  {
    path: 'ambiguous/contract-and-invoice.pdf',
    title: '契約に基づくご請求のご案内',
    fields: [
      ['契約番号', 'LEG-2026-9001'],
      ['請求番号', 'FIN-2026-9001'],
      ['発行日', '2026-06-01'],
    ],
    body: [
      '本書は、締結済みの業務委託契約書の写しと、当該契約に基づく請求書を1通にまとめたものです。',
      '契約条項の変更はありません。請求金額は契約第3条に定める委託料と同額です。',
    ],
  },
  {
    path: 'ambiguous/meeting-notes.pdf',
    title: '打ち合わせ覚書',
    fields: [['日付', '2026-06-05']],
    body: ['出席者間で次回の進め方を確認した。分類の手掛かりとなる番号や種別の記載はない。'],
  },
  // ここから下はdemoの筋書き用。
  // 別folderに同名fileを置く。「file名だけでは区別できない」ことを画面で示す。
  {
    path: 'legal/contracts/keiyakusho.pdf',
    title: '業務委託契約書',
    fields: [
      ['契約番号', 'LEG-2026-1002'],
      ['発効日', '2026-05-01'],
      ['委託者（甲）', '架空ホールディングス株式会社'],
      ['受託者（乙）', 'Delta 株式会社'],
    ],
    body: [
      '第1条（目的） 甲は乙に対し、移行対象folderの棚卸し業務を委託する。',
      '第2条（委託料） 一括 800,000 円（消費税別）とする。',
    ],
  },
  {
    path: 'sales/proposals/keiyakusho.pdf',
    title: 'ご提案書（契約書案の添付あり）',
    fields: [
      ['文書番号', 'SLS-2026-5002'],
      ['提出日', '2026-05-20'],
      ['提案先', 'Delta 株式会社（架空）'],
    ],
    body: [
      '1. ご提案の概要: 棚卸し業務の範囲と体制をご提案します。',
      '2. 添付: 業務委託契約書の案（締結前のdraft）。',
      '3. 本書は提案資料であり、契約の成立を意味しません。',
    ],
  },
  // 残りのdestinationも複数件にして、一括承認の塊が見えるようにする。
  {
    path: 'finance/invoices/invoice-2026-06.pdf',
    title: '請求書',
    fields: [
      ['請求番号', 'FIN-2026-2003'],
      ['発行日', '2026-06-30'],
      ['支払期限', '2026-07-31'],
      ['請求先', '架空ホールディングス株式会社 経理部'],
      ['請求元', 'Delta 株式会社'],
    ],
    body: ['件名: 移行対象folderの棚卸し（一括）', '小計 800,000 円 / 消費税 80,000 円'],
  },
  {
    path: 'hr/records/employee-3002.pdf',
    title: '従業員記録',
    fields: [
      ['社員番号', 'HR-2026-3002'],
      ['氏名', '鈴木 花子（架空）'],
      ['入社日', '2021-10-01'],
      ['所属', '管理本部 人事部'],
    ],
    body: ['2026年度上期の人事評価は B とする。', '本記録は人事部が管理する。'],
  },
  {
    path: 'it/runbooks/box-migration-runbook.pdf',
    title: '運用手順書 — 移行作業',
    fields: [
      ['文書番号', 'IT-2026-4003'],
      ['更新日', '2026-06-10'],
      ['対象system', 'Shuttle Lite'],
    ],
    body: [
      '1. proxy疎通を確認する（npm run check:proxy）。',
      '2. migration jobを作成し、承認待ちになるまで待つ。',
      '3. AIの提案を確認し、判断が必要な件だけ人が決める。',
      '4. 完了後にreportを保存し、件数とSHA-1の一致を確認する。',
    ],
  },
  {
    path: 'sales/proposals/proposal-golf.pdf',
    title: 'ご提案書',
    fields: [
      ['文書番号', 'SLS-2026-5003'],
      ['提出日', '2026-06-15'],
      ['提案先', 'Golf 株式会社（架空）'],
    ],
    body: [
      '1. ご提案の概要: file serverからBoxへの移行を段階的に実施します。',
      '2. 第1段階: 明示的proxy環境での疎通確認と、100GB規模の試行移行。',
      '3. 概算見積: 初期構築 2,400,000 円。',
    ],
  },
];

async function main(): Promise<void> {
  if (process.argv.includes('--clean')) await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(WORK_DIR, { recursive: true });

  let written = 0;
  for (const doc of DOCS) {
    const htmlPath = join(WORK_DIR, `${doc.path.replace(/[\\/]/g, '_')}.html`);
    const pdfPath = join(OUT_DIR, doc.path);
    await writeFile(htmlPath, render(doc), 'utf8');
    await mkdir(dirname(pdfPath), { recursive: true });
    // Chromeは /ToUnicode を出力するため、生成したPDFからテキストを抽出できる。
    await execFileAsync(CHROME, [
      '--headless',
      '--disable-gpu',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`,
    ]);
    written += 1;
    process.stdout.write(`  ${doc.path}\n`);
  }

  const dirs = await readdir(OUT_DIR);
  process.stdout.write(
    `\nPDF fixtures: ${OUT_DIR}\n  ${written} 件を生成（folder: ${dirs.join(', ')}）\n`,
  );
}

await main();
