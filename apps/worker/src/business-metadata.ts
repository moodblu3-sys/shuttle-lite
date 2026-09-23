import {
  assertBusinessTemplate,
  mappingForDocument,
  normalizeBusinessValues,
  sameTemplate,
  ShuttleError,
  templateId,
  type BusinessTemplate,
  type BusinessValues,
  type JobCommandRecord,
  type MigrationItem,
  type TemplateMapping,
} from '@shuttle-lite/core';
import type { JobContext, WorkerContext } from './context';
import { applyRuntimeSettings } from '@shuttle-lite/config';

export async function checkTemplate(ctx: WorkerContext, template: BusinessTemplate): Promise<void> {
  const current = await ctx.gateway.getMetadataTemplate(template);
  if (!current)
    throw new ShuttleError('METADATA_SCHEMA', 'Boxのメタデータテンプレートが見つかりません。');
  assertBusinessTemplate(current);
  if (!sameTemplate(template, current))
    throw new ShuttleError(
      'METADATA_SCHEMA',
      'テンプレートの項目が変更されています。設定を保存し直して新しい移行を作成してください。',
    );
}

export async function prepareDocumentMetadata(
  ctx: JobContext,
  item: MigrationItem,
  documentType: string | null,
): Promise<void> {
  if (
    ctx.store.getJobMetadata(item.jobId) === null ||
    ctx.store.getBusinessMetadata(item.id).revision > 0
  )
    return;
  const mappings = ctx.store.getAvailableJobMetadata(item.jobId);
  const mapping = mappingForDocument(mappings, documentType);
  if (!mapping) return;
  await checkTemplate(ctx, mapping.template);
  const values = normalizeBusinessValues(
    mapping.template,
    await ctx.gateway.extractTemplate(item.boxFileId!, mapping.template),
    false,
  );
  ctx.store.transaction(() => {
    assertStillAvailable(ctx, item.jobId, mapping);
    ctx.store.rememberJobTemplate(item.jobId, mapping);
    ctx.store.saveBusinessMetadata(item.id, templateId(mapping.template), values, 0);
  });
}

function assertStillAvailable(ctx: WorkerContext, jobId: string, mapping: TemplateMapping): void {
  const current = ctx.store
    .getAvailableJobMetadata(jobId)
    .find((entry) => templateId(entry.template) === templateId(mapping.template));
  if (!current || !sameTemplate(current.template, mapping.template))
    throw new ShuttleError(
      'APPROVAL_STALE',
      '使用するテンプレートの設定が変更されました。選び直してください。',
    );
}

/** AI reads run outside SQLite transactions; the claim fences the resulting local write. */
export async function selectMetadataTemplate(
  ctx: WorkerContext,
  command: JobCommandRecord,
): Promise<() => void> {
  const item = ctx.store.getItem(String(command.payload.itemId ?? ''));
  const job = ctx.store.getJob(command.jobId);
  const requested = command.payload.templateId;
  const revision = command.payload.revision;
  const validate = () => {
    const current = item && ctx.store.getItem(item.id);
    if (
      !job ||
      !item ||
      item.jobId !== job.id ||
      ctx.store.getJob(job.id)?.cleanupState !== 'NONE' ||
      !current ||
      !['REVIEW_REQUIRED', 'NEEDS_REVIEW'].includes(current.state) ||
      !current.boxFileId ||
      current.boxFileId !== command.payload.observedBoxFileId ||
      current.boxSha1 !== command.payload.observedSha1 ||
      ctx.store.getBusinessMetadata(item.id).revision !== revision
    )
      throw new ShuttleError(
        'APPROVAL_STALE',
        'ファイルまたはメタデータが更新されました。再読み込みしてください。',
      );
  };
  validate();
  if (ctx.store.getJobMetadata(job!.id) === null)
    throw new ShuttleError('APPROVAL_INVALID', 'この移行は旧メタデータ方式です。');
  const mappings = ctx.store.getAvailableJobMetadata(job!.id);
  const mapping = mappings.find((m) => templateId(m.template) === requested);
  if (requested !== null && !mapping)
    throw new ShuttleError('APPROVAL_INVALID', '登録されていないテンプレートです。');
  let values: BusinessValues = {};
  if (mapping) {
    await checkTemplate(ctx, mapping.template);
    // On AI failure the same template can still be chosen for manual entry.
    if (command.payload.extract === true) {
      const profile = ctx.store.getProfile(job!.profileId);
      if (
        !applyRuntimeSettings(ctx.config, ctx.store.getRuntimeSettings().settings).ai.enabled ||
        !profile?.aiRoutingEnabled
      )
        throw new ShuttleError('APPROVAL_INVALID', 'AI分類が無効です。');
      values = normalizeBusinessValues(
        mapping.template,
        await ctx.gateway.extractTemplate(item!.boxFileId!, mapping.template),
        false,
      );
    }
  }
  return () => {
    validate();
    if (mapping) {
      assertStillAvailable(ctx, job!.id, mapping);
      ctx.store.rememberJobTemplate(job!.id, mapping);
    }
    ctx.store.saveBusinessMetadata(
      item!.id,
      mapping ? templateId(mapping.template) : null,
      values,
      revision as number,
    );
  };
}

export function validateBusinessApproval(ctx: WorkerContext, item: MigrationItem, input: unknown) {
  const mappings = ctx.store.getJobMetadata(item.jobId);
  if (!mappings) return null;
  const state = ctx.store.getBusinessMetadata(item.id);
  const approval = input as {
    revision?: number;
    templateId?: string | null;
    values?: unknown;
  } | null;
  if (!approval || approval.revision !== state.revision || approval.templateId !== state.templateId)
    throw new ShuttleError('APPROVAL_STALE', 'メタデータが更新されました。再確認してください。');
  const template = mappings.find((m) => templateId(m.template) === approval.templateId)?.template;
  if (!template) {
    if (
      approval.templateId !== null ||
      !approval.values ||
      typeof approval.values !== 'object' ||
      Array.isArray(approval.values) ||
      Object.keys(approval.values).length
    )
      throw new ShuttleError('APPROVAL_INVALID', 'メタデータのテンプレートを選択してください。');
    return { revision: state.revision, templateId: null, values: {} };
  }
  return {
    revision: state.revision,
    templateId: state.templateId,
    values: normalizeBusinessValues(template, approval.values),
  };
}

function approvedMetadata(ctx: WorkerContext, item: MigrationItem) {
  const routing = ctx.store.getRouting(item.id);
  const approval = validateBusinessApproval(ctx, item, routing?.approvedMetadata?.business);
  const template = ctx.store
    .getJobMetadata(item.jobId)
    ?.find((m) => templateId(m.template) === approval?.templateId)?.template;
  return { approval, template };
}

export async function applyBusinessMetadata(ctx: JobContext, item: MigrationItem): Promise<void> {
  const { approval, template } = approvedMetadata(ctx, item);
  const written = ctx.store.getWrittenTemplates(item.id);
  if (template) await checkTemplate(ctx, template);
  for (const previous of written) {
    if (!template || templateId(previous) !== templateId(template)) {
      await ctx.gateway.removeBusinessMetadata(item.boxFileId!, previous);
      ctx.store.forgetTemplateWrite(item.id, templateId(previous));
    }
  }
  if (!template || !approval) return;
  const recovering = written.some((t) => templateId(t) === templateId(template));
  if (!recovering) {
    if (await ctx.gateway.getMetadata(item.boxFileId!, template))
      throw new ShuttleError(
        'APPROVAL_STALE',
        'Boxに同じテンプレートのメタデータが既にあります。内容を確認してください。',
      );
    // Persist intent before the HTTP write so an uncertain result is recoverable.
    ctx.store.recordTemplateWrite(item.id, template);
  }
  try {
    await ctx.gateway.setMetadata(item.boxFileId!, approval.values, template);
  } catch (error) {
    if ((error as { category?: string }).category !== 'METADATA_CONFLICT') throw error;
    if (!recovering) {
      ctx.store.forgetTemplateWrite(item.id, templateId(template));
      throw new ShuttleError(
        'APPROVAL_STALE',
        'Boxのメタデータが同時に更新されました。内容を確認してください。',
      );
    }
    await ctx.gateway.updateMetadata(item.boxFileId!, approval.values, template);
  }
}

export async function verifyBusinessMetadata(ctx: JobContext, item: MigrationItem): Promise<void> {
  const { approval, template } = approvedMetadata(ctx, item);
  if (!template || !approval) return;
  const actual = await ctx.gateway.getMetadata(item.boxFileId!, template);
  if (!actual) throw new ShuttleError('METADATA_SCHEMA', 'メタデータが反映されていません。');
  const values = normalizeBusinessValues(template, actual, false);
  if (template.fields.some((field) => values[field.key] !== approval.values[field.key]))
    throw new ShuttleError('METADATA_SCHEMA', '承認したメタデータとBoxの値が一致しません。');
}
