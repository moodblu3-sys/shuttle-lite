/**
 * Creates the Box side objects: the folder layout from
 * docs/architecture.md section 12 and the ShuttleLiteMigration metadata
 * template.
 *
 * In fake mode this runs locally and is safe to repeat. Against a real
 * enterprise it needs a CCG application with write access to the migration
 * root, and template creation additionally needs the "Manage enterprise
 * properties" scope. See docs/integration-todo.md.
 */
import {
  createBoxGateway,
  ensureBoxLayout,
  layoutPath,
  migrationTemplateSpec,
} from '@shuttle-lite/box';
import { loadConfig, loadDestinationCatalog } from '@shuttle-lite/config';
import { createLogger, toShuttleError } from '@shuttle-lite/core';

const config = loadConfig();
const logger = createLogger(config.logLevel, { script: 'bootstrap-box' });
const catalog = loadDestinationCatalog();
const gateway = createBoxGateway(config, logger);
const skipTemplate = process.argv.includes('--skip-template');

try {
  const identity = await gateway.whoAmI();
  process.stdout.write(
    `mode=${gateway.kind} identity=${identity.login} enterprise=${identity.enterpriseId ?? '-'}\n`,
  );

  const layout = await ensureBoxLayout(gateway, config, catalog);
  process.stdout.write(`\nfolder layoutを作成・確認しました (${layoutPath(config)})\n`);
  process.stdout.write(`  root            ${layout.rootFolderId}\n`);
  process.stdout.write(`  _staging        ${layout.stagingRootFolderId}\n`);
  process.stdout.write(`  _needs_review   ${layout.needsReviewFolderId}\n`);
  process.stdout.write(`  _reports        ${layout.reportsFolderId}\n`);
  for (const [key, id] of Object.entries(layout.destinations)) {
    process.stdout.write(`  ${key.padEnd(16)}${id}\n`);
  }

  if (!skipTemplate) {
    const existing = await gateway.getMetadataTemplate();
    if (existing) {
      process.stdout.write(
        `\nmetadata template は既に存在します: ${config.box.metadataScope}/${config.box.metadataTemplateKey}\n`,
      );
    } else {
      await gateway.createMetadataTemplate(
        migrationTemplateSpec(
          config.box.metadataScope,
          config.box.metadataTemplateKey,
          catalog.entries.map((entry) => entry.key),
        ),
      );
      process.stdout.write(
        `\nmetadata templateを作成しました: ${config.box.metadataScope}/${config.box.metadataTemplateKey}\n`,
      );
    }
  }

  if (config.box.mode === 'real') {
    process.stdout.write('\n.env へ以下を設定してください:\n');
    process.stdout.write(`BOX_ROOT_FOLDER_ID=${layout.rootFolderId}\n`);
    process.stdout.write(`BOX_STAGING_FOLDER_ID=${layout.stagingRootFolderId}\n`);
    process.stdout.write(`BOX_NEEDS_REVIEW_FOLDER_ID=${layout.needsReviewFolderId}\n`);
    process.stdout.write(`BOX_REPORTS_FOLDER_ID=${layout.reportsFolderId}\n`);
  }
} catch (error) {
  const shuttleError = toShuttleError(error);
  process.stderr.write(
    `bootstrapに失敗しました\n  category: ${shuttleError.category}\n  message: ${shuttleError.message}\n  対応: ${shuttleError.operatorAction}\n`,
  );
  process.exitCode = 1;
} finally {
  await gateway.close();
}
