/**
 * 実Box enterpriseに対する疎通確認。
 *
 *   npm run verify:box
 *
 * 1 fileだけを往復させて、pipelineが使う各APIが実際に動くことを確かめる。
 * 同時に、docs/decisions.md の Q-002（proxy）、Q-004（Box AIの応答形状と
 * representation待ち時間）、Q-005（metadata field型）に対する実測値を得る。
 *
 * 何も削除しない。作成したfileはBox上に残し、linkを表示する。
 */
import { createReadStream } from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBoxGateway,
  destinationFolderId,
  ensureBoxLayout,
  migrationTemplateSpec,
} from '@shuttle-lite/box';
import { loadConfig, loadDestinationCatalog, redactProxyUrl } from '@shuttle-lite/config';
import { createLogger, sha1File, sleep, toShuttleError } from '@shuttle-lite/core';
import { normalizeExtraction, routingOutcome } from '@shuttle-lite/routing';

const SAMPLE = [
  '業務委託契約書（Shuttle Lite 疎通確認用のsynthetic data）',
  '契約番号: SPIKE-2026-0001',
  '発効日 2026-04-01',
  '委託者 (甲): 架空ホールディングス株式会社',
  '受託者 (乙): Spike 合同会社',
  '',
  '第1条 甲および乙は、本契約に基づき業務委託を行う。',
  '第2条 契約期間は発効日から1年とする。',
  '',
  'このfileはShuttle Liteの疎通確認で作成されました。削除して構いません。',
].join('\n');

interface Step {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const steps: Step[] = [];

function record(name: string, ok: boolean, detail: string): void {
  steps.push({ name, ok, detail });
  process.stdout.write(`${ok ? '  OK  ' : ' FAIL '} ${name}\n        ${detail}\n`);
}

function describeError(error: unknown): string {
  const e = toShuttleError(error);
  return [
    `${e.category}${e.status ? ` (HTTP ${e.status})` : ''}`,
    e.message,
    e.requestId ? `request-id: ${e.requestId}` : null,
    `対応: ${e.operatorAction}`,
  ]
    .filter(Boolean)
    .join('\n        ');
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.box.mode !== 'real') {
    process.stderr.write('BOX_MODE=real を設定してください（現在: fake）。\n');
    process.exitCode = 1;
    return;
  }

  process.stdout.write('Shuttle Lite 実Box疎通確認\n');
  process.stdout.write(`  API      ${config.box.apiBaseUrl}\n`);
  process.stdout.write(`  Upload   ${config.box.uploadBaseUrl}\n`);
  process.stdout.write(
    `  Proxy    ${config.proxy.mode}${config.proxy.url ? ` ${redactProxyUrl(config.proxy.url)}` : ''}\n`,
  );
  process.stdout.write(
    `  Template ${config.box.metadataScope}/${config.box.metadataTemplateKey}\n\n`,
  );

  const logger = createLogger(config.logLevel);
  const gateway = createBoxGateway(config, logger);
  const catalog = loadDestinationCatalog();

  try {
    // 1. 認証 -------------------------------------------------------------
    try {
      const me = await gateway.whoAmI();
      record(
        'CCGでtokenを取得しAPIを呼べる',
        true,
        `login=${me.login} name=${me.name} enterprise=${me.enterpriseId ?? '-'}`,
      );
    } catch (error) {
      record('CCGでtokenを取得しAPIを呼べる', false, describeError(error));
      return;
    }

    // 2. folder layout ----------------------------------------------------
    let layout;
    try {
      layout = await ensureBoxLayout(gateway, config, catalog);
      record(
        'folder階層を解決できる',
        true,
        `root=${layout.rootFolderId} staging=${layout.stagingRootFolderId} destinations=${Object.keys(layout.destinations).length}`,
      );
    } catch (error) {
      record('folder階層を解決できる', false, describeError(error));
      return;
    }

    // 3. metadata template ------------------------------------------------
    try {
      const template = await gateway.getMetadataTemplate();
      if (template) {
        record(
          'metadata templateが存在する',
          true,
          `${template.templateKey}: ${template.fields.length} field（${template.fields
            .map((f) => `${f.key}:${f.type}`)
            .slice(0, 4)
            .join(', ')}…）`,
        );
      } else {
        const spec = migrationTemplateSpec(
          config.box.metadataScope,
          config.box.metadataTemplateKey,
          catalog.entries.map((entry) => entry.key),
        );
        await gateway.createMetadataTemplate(spec);
        record(
          'metadata templateを作成した',
          true,
          `${spec.templateKey}: ${spec.fields.length} field`,
        );
      }
    } catch (error) {
      record('metadata templateを用意できる', false, describeError(error));
    }

    // 4. upload -----------------------------------------------------------
    const dir = mkdtempSync(join(tmpdir(), 'shuttle-spike-'));
    const localPath = join(dir, 'spike-contract.txt');
    writeFileSync(localPath, `${SAMPLE}\n`, 'utf8');
    const digest = await sha1File(localPath);
    const stagingName = `spike-${Date.now()}-contract.txt`;

    let file;
    try {
      await gateway.preflightUpload({
        parentFolderId: layout.stagingRootFolderId,
        name: stagingName,
        size: digest.bytes,
      });
      file = await gateway.uploadDirect({
        parentFolderId: layout.stagingRootFolderId,
        name: stagingName,
        size: digest.bytes,
        sha1Hex: digest.sha1,
        content: () => createReadStream(localPath),
      });
      record(
        'preflightとdirect uploadが通る',
        true,
        `file=${file.id} size=${file.size} version=${file.versionId}`,
      );
    } catch (error) {
      record('preflightとdirect uploadが通る', false, describeError(error));
      return;
    }

    // 5. 転送検証 ---------------------------------------------------------
    try {
      const fetched = await gateway.getFile(file.id);
      const match = fetched?.sha1 === digest.sha1 && fetched?.size === digest.bytes;
      record(
        'Box上のSHA-1とsizeがsourceと一致する',
        match,
        `source ${digest.sha1.slice(0, 16)}…/${digest.bytes}B vs Box ${fetched?.sha1?.slice(0, 16)}…/${fetched?.size}B`,
      );
    } catch (error) {
      record('Box上のSHA-1とsizeがsourceと一致する', false, describeError(error));
    }

    // 6. metadata ---------------------------------------------------------
    try {
      await gateway.setMetadata(file.id, {
        migrationJobId: 'spike',
        migrationItemId: 'spike-item',
        sourceRelativePath: 'spike/spike-contract.txt',
        sourceFileName: 'spike-contract.txt',
        sourceModifiedAt: new Date().toISOString(),
        sourceSize: digest.bytes,
        sourceSha1: digest.sha1,
        migratedAt: new Date().toISOString(),
        migrationStatus: 'VERIFIED',
      });
      const stored = await gateway.getMetadata(file.id);
      record(
        'provenance metadataを書き込める',
        stored?.sourceSha1 === digest.sha1,
        `sourceSize=${String(stored?.sourceSize)} (${typeof stored?.sourceSize}) sourceModifiedAt=${String(stored?.sourceModifiedAt)}`,
      );
    } catch (error) {
      record('provenance metadataを書き込める', false, describeError(error));
    }

    // 7. Box AI -----------------------------------------------------------
    // representationの生成待ちがどれくらいかを実測する。
    const aiStarted = Date.now();
    let aiAttempts = 0;
    let aiDone = false;
    for (; aiAttempts < config.ai.maxAttempts && !aiDone; aiAttempts += 1) {
      try {
        const response = await gateway.extractStructured({
          fileId: file.id,
          destinationKeys: catalog.entries.map((entry) => entry.key),
          fileName: 'spike-contract.txt',
        });
        const extraction = normalizeExtraction(
          response,
          catalog.entries.map((entry) => entry.key),
        );
        const outcome = routingOutcome(extraction);
        aiDone = true;
        record(
          'Box AI Structured Extractが応答する',
          true,
          [
            `${Math.round((Date.now() - aiStarted) / 1000)}秒 / ${aiAttempts + 1}回目`,
            `provider=${extraction.provider}`,
            `documentType=${extraction.documentType ?? '-'}`,
            `businessIdentifier=${extraction.businessIdentifier ?? '-'}`,
            `effectiveDate=${extraction.effectiveDate ?? '-'}`,
            `提案=${outcome.kind === 'SUGGESTED' ? outcome.destinationKey : '提案なし'}`,
            `confidence=${extraction.confidence === null ? '返ってこない' : extraction.confidence}`,
            extraction.rejectedDestinationKey
              ? `catalog外のkeyを返した: ${extraction.rejectedDestinationKey}`
              : null,
          ]
            .filter(Boolean)
            .join('\n        '),
        );
      } catch (error) {
        const e = toShuttleError(error);
        if (e.category === 'AI_NOT_READY' && aiAttempts < config.ai.maxAttempts - 1) {
          const waitMs = e.retryAfterMs ?? 5_000;
          process.stdout.write(
            `        AI_NOT_READY（${aiAttempts + 1}回目）。${waitMs}ms 待って再試行します。\n`,
          );
          await sleep(waitMs);
          continue;
        }
        record('Box AI Structured Extractが応答する', false, describeError(error));
        break;
      }
    }

    // 8. move と最終検証 ---------------------------------------------------
    try {
      const target = destinationFolderId(layout, 'LEGAL_CONTRACTS');
      const moved = await gateway.moveFile({
        fileId: file.id,
        targetFolderId: target,
        newName: `spike-contract-${Date.now()}.txt`,
      });
      const verified = await gateway.getFile(moved.id);
      record(
        'Box内moveでfile IDを保ったまま最終配置できる',
        moved.id === file.id &&
          verified?.parentFolderId === target &&
          verified?.sha1 === digest.sha1,
        `file=${moved.id} parent=${verified?.parentFolderId} name=${verified?.name}`,
      );
      process.stdout.write(`\n        作成したfile: https://app.box.com/file/${moved.id}\n`);
    } catch (error) {
      record('Box内moveでfile IDを保ったまま最終配置できる', false, describeError(error));
    }
  } finally {
    await gateway.close();
  }

  const failed = steps.filter((step) => !step.ok);
  process.stdout.write(`\n結果: ${steps.length - failed.length} / ${steps.length} 項目が成功\n`);
  if (failed.length > 0) process.exitCode = 1;
  else {
    process.stdout.write(
      '\n次は npm run bootstrap:box の出力をもとに .env の folder ID を埋め、\n' +
        'fixtureの本番移行と、Squid経由でのproxy検証（npm run check:proxy）へ進めます。\n',
    );
  }
}

await main();
