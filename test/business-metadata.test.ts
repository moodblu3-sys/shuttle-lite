import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeBusinessValues,
  ShuttleError,
  templateId,
  type MigrationItem,
  type TemplateMapping,
} from '@shuttle-lite/core';
import { demoBusinessTemplates } from '../packages/box/src/fake/business-templates';
import { createHarness, runUntilIdle, approveItem, type Harness } from './harness';
import { runRouting } from '../apps/worker/src/steps/routing';
import { processCommands } from '../apps/worker/src/commands';
import { applyBusinessMetadata } from '../apps/worker/src/business-metadata';

const contract = demoBusinessTemplates[0]!;
const invoice = demoBusinessTemplates[1]!;
const mappings: TemplateMapping[] = [
  { documentType: '契約書', template: contract },
  { documentType: '請求書', template: invoice },
];

describe('document-specific business metadata', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    for (const template of demoBusinessTemplates) await h.gateway.createMetadataTemplate(template);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    h.cleanup();
  });

  async function stage(ai = true) {
    const profile = h.createProfile({ aiRoutingEnabled: ai });
    const job = h.store.createJob({ profileId: profile.id, operatorLabel: '担当者' });
    h.store.saveJobMetadata(job.id, mappings);
    h.store.enqueueCommand(job.id, 'START_JOB');
    await runUntilIdle(h);
    return { job, items: h.store.listItems(job.id) };
  }

  function select(
    item: MigrationItem,
    id: string | null,
    extract = false,
    revision = h.store.getBusinessMetadata(item.id).revision,
  ) {
    return h.store.enqueueCommand(item.jobId, 'SELECT_METADATA_TEMPLATE', {
      itemId: item.id,
      templateId: id,
      revision,
      extract,
      observedBoxFileId: item.boxFileId,
      observedSha1: item.boxSha1,
    });
  }

  it('extracts by document template, preserves human edits including blanks, then verifies Box values', async () => {
    h.writeSource(
      'contract.txt',
      '業務委託契約書\n契約先：青葉株式会社\n契約種別：業務委託\n締結日：2026-09-01',
    );
    h.writeSource(
      'invoice.txt',
      '請求書\n請求元：北斗株式会社\n請求番号：INV-100\n金額：12500\n通貨：JPY\n支払期限：2026-09-30',
    );
    const { job, items } = await stage();
    expect(items.every((item) => item.state === 'REVIEW_REQUIRED')).toBe(true);
    const c = items.find((item) => item.sourceFileName === 'contract.txt')!;
    const i = items.find((item) => item.sourceFileName === 'invoice.txt')!;
    expect(h.store.getBusinessMetadata(c.id)).toMatchObject({
      templateId: templateId(contract),
      values: { counterparty: '青葉株式会社', signedDate: '2026-09-01T00:00:00Z' },
    });
    expect(h.store.getBusinessMetadata(i.id)).toMatchObject({
      templateId: templateId(invoice),
      values: { amount: 12500, currency: 'JPY' },
    });
    for (const item of items) {
      expect(await h.gateway.getMetadata(item.boxFileId!)).toBeNull();
      expect(await h.gateway.getMetadata(item.boxFileId!, contract)).toBeNull();
      expect(await h.gateway.getMetadata(item.boxFileId!, invoice)).toBeNull();
    }
    const business = h.store.getBusinessMetadata(c.id);
    h.store.enqueueCommand(job.id, 'APPROVE_ITEM', {
      itemId: c.id,
      destinationKey: 'LEGAL_CONTRACTS',
      operatorLabel: '担当者',
      observedBoxFileId: c.boxFileId,
      observedSha1: c.boxSha1,
      business: {
        ...business,
        values: { ...business.values, counterparty: '青葉商事', signedDate: '' },
      },
    });
    approveItem(h, i, 'FINANCE_INVOICES');
    await runUntilIdle(h);
    expect(h.store.getJob(job.id)?.state).toBe('COMPLETED');
    expect(await h.gateway.getMetadata(c.boxFileId!, contract)).toEqual({
      counterparty: '青葉商事',
      contractType: '業務委託',
    });
    expect(await h.gateway.getMetadata(i.boxFileId!, invoice)).toMatchObject({
      vendor: '北斗株式会社',
      amount: 12500,
    });
    expect(await h.gateway.getMetadata(c.boxFileId!)).toBeNull();
    expect(h.store.getItem(c.id)?.boxFileId).toBe(c.boxFileId);
  });

  it('reuses successful classification when metadata extraction needs a retry', async () => {
    h.writeSource('contract.txt', '契約書\n契約先：青葉株式会社');
    const classify = vi.spyOn(h.gateway, 'extractStructured');
    const fields = vi
      .spyOn(h.gateway, 'extractTemplate')
      .mockRejectedValueOnce(new ShuttleError('AI_NOT_READY', 'pending', { retryAfterMs: 0 }));
    const { items } = await stage();
    expect(items[0]?.state).toBe('REVIEW_REQUIRED');
    expect(classify).toHaveBeenCalledTimes(1);
    expect(fields).toHaveBeenCalledTimes(2);
  });

  it('retains classification across worker recreation and invalidates it when file identity changes', async () => {
    h.writeSource('contract.txt', '契約書\n契約先：青葉株式会社');
    const { job, items } = await stage(false);
    const item = items[0]!;
    h.store.updateItem(item.id, { state: 'AI_PENDING' });
    const classify = vi.spyOn(h.gateway, 'extractStructured');
    const fields = vi
      .spyOn(h.gateway, 'extractTemplate')
      .mockRejectedValueOnce(new ShuttleError('AI_NOT_READY', 'pending', { retryAfterMs: 0 }));
    await expect(
      runRouting({ ...(await h.jobContext(job.id)), aiEnabled: true }, h.store.getItem(item.id)!),
    ).rejects.toThrow('pending');
    await runRouting(
      { ...(await h.jobContext(job.id)), aiEnabled: true },
      h.store.getItem(item.id)!,
    );
    expect(classify).toHaveBeenCalledTimes(1);
    expect(fields).toHaveBeenCalledTimes(2);
    h.store.updateItem(item.id, { state: 'AI_PENDING', boxFileVersionId: 'another-version' });
    await runRouting(
      { ...(await h.jobContext(job.id)), aiEnabled: true },
      h.store.getItem(item.id)!,
    );
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it('allows manual template and values with AI off and rejects stale template selections', async () => {
    h.writeSource('note.txt', '書類');
    const { items } = await stage(false);
    const item = items[0]!;
    expect(h.store.getBusinessMetadata(item.id).templateId).toBeNull();
    select(item, templateId(invoice));
    await processCommands(h.ctx);
    const state = h.store.getBusinessMetadata(item.id);
    expect(state).toMatchObject({ revision: 1, templateId: templateId(invoice), values: {} });
    const stale = select(item, templateId(contract), false, 0);
    await processCommands(h.ctx);
    expect(h.store.listCommands(item.jobId).find((c) => c.id === stale.id)?.state).toBe('REJECTED');
    const command = h.store.enqueueCommand(item.jobId, 'APPROVE_ITEM', {
      itemId: item.id,
      destinationKey: 'FINANCE_INVOICES',
      operatorLabel: '担当者',
      observedBoxFileId: item.boxFileId,
      observedSha1: item.boxSha1,
      business: { ...state, values: { vendor: '手動入力', amount: '1500' } },
    });
    await runUntilIdle(h);
    expect(h.store.listCommands(item.jobId).find((c) => c.id === command.id)?.state).toBe('DONE');
    expect(h.store.getItem(item.id)?.state).toBe('COMPLETED');
    expect(await h.gateway.getMetadata(item.boxFileId!, invoice)).toEqual({
      vendor: '手動入力',
      amount: 1500,
    });
  });

  it('leaves unknown documents unselected and lets a human choose and extract a template', async () => {
    h.writeSource('note.txt', 'メモ\n請求元：青葉株式会社');
    vi.spyOn(h.gateway, 'extractStructured').mockResolvedValue({
      provider: 'fake',
      fields: { documentType: 'その他', suggestedDestinationKey: 'NEEDS_REVIEW' },
      confidence: null,
      references: [],
    });
    const { items } = await stage();
    const item = items[0]!;
    expect(h.store.getBusinessMetadata(item.id).templateId).toBeNull();
    select(item, templateId(invoice), true);
    await processCommands(h.ctx);
    expect(h.store.getBusinessMetadata(item.id).values).toEqual({ vendor: '青葉株式会社' });
  });

  it('blocks schema drift before writing or moving and preserves the approved values', async () => {
    h.writeSource('contract.txt', '契約書\n契約先：青葉株式会社');
    const { items } = await stage();
    const item = items[0]!;
    approveItem(h, item, 'LEGAL_CONTRACTS');
    await h.gateway.createMetadataTemplate({
      ...contract,
      fields: [...contract.fields, { key: 'newField', displayName: '追加項目', type: 'string' }],
    });
    await runUntilIdle(h);
    expect(h.store.getItem(item.id)?.state).not.toBe('COMPLETED');
    expect(h.store.getItem(item.id)?.finalFolderId).toBeNull();
    expect(await h.gateway.getMetadata(item.boxFileId!, contract)).toBeNull();
  });

  it('never overwrites a metadata instance supplied by another process', async () => {
    h.writeSource('contract.txt', '契約書\n契約先：青葉株式会社');
    const { items } = await stage();
    const item = items[0]!;
    await h.gateway.setMetadata(item.boxFileId!, { counterparty: '既存の値' }, contract);
    approveItem(h, item, 'LEGAL_CONTRACTS');
    await runUntilIdle(h);
    expect(await h.gateway.getMetadata(item.boxFileId!, contract)).toEqual({
      counterparty: '既存の値',
    });
    expect(h.store.getItem(item.id)?.state).not.toBe('COMPLETED');
  });

  it('recovers its own partial write and removes cleared fields on reapproval', async () => {
    h.writeSource('contract.txt', '契約書\n契約先：青葉株式会社\n締結日：2026-09-01');
    const { items } = await stage();
    const item = items[0]!;
    approveItem(h, item, 'LEGAL_CONTRACTS');
    await processCommands(h.ctx);
    const ctx = await h.jobContext(item.jobId);
    await applyBusinessMetadata(ctx, item);
    // Repeat after a lost write response; no duplicate template instance is created.
    await applyBusinessMetadata(ctx, item);
    const routing = h.store.getRouting(item.id)!;
    h.store.recordApproval({
      itemId: item.id,
      approvedDestinationKey: 'LEGAL_CONTRACTS',
      approvedMetadata: {
        business: { ...h.store.getBusinessMetadata(item.id), values: { counterparty: '修正済み' } },
      },
      approvedBoxFileId: item.boxFileId!,
      approvedBoxVersionId: item.boxFileVersionId,
      approvedSha1: item.boxSha1!,
      operatorLabel: routing.operatorLabel!,
      humanOverride: true,
    });
    await applyBusinessMetadata(ctx, item);
    expect(await h.gateway.getMetadata(item.boxFileId!, contract)).toEqual({
      counterparty: '修正済み',
    });
  });

  it('validates field types and does not invent values for failed AI output', () => {
    expect(() => normalizeBusinessValues(invoice, { amount: '12円' })).toThrow();
    expect(() => normalizeBusinessValues(invoice, { invoiceDate: '2026-02-30' })).toThrow();
    expect(() => normalizeBusinessValues(invoice, { foreignKey: 'unexpected' })).toThrow();
    expect(
      normalizeBusinessValues(invoice, { vendor: null, amount: '12円', dueDate: '不明' }, false),
    ).toEqual({});
  });

  it('removes only its own previous template when the operator changes the selection', async () => {
    h.writeSource('contract.txt', '契約書\n契約先：青葉株式会社');
    const { items } = await stage();
    const item = items[0]!;
    approveItem(h, item, 'LEGAL_CONTRACTS');
    await processCommands(h.ctx);
    const ctx = await h.jobContext(item.jobId);
    await applyBusinessMetadata(ctx, item);
    h.store.transitionItem({ itemId: item.id, to: 'REVIEW_REQUIRED', telemetry: false });
    select(item, templateId(invoice));
    await processCommands(h.ctx);
    approveItem(h, item, 'FINANCE_INVOICES');
    await runUntilIdle(h);
    expect(h.store.getItem(item.id)?.state).toBe('COMPLETED');
    expect(await h.gateway.getMetadata(item.boxFileId!, contract)).toBeNull();
    expect(await h.gateway.getMetadata(item.boxFileId!, invoice)).toEqual({});
    expect(h.store.getWrittenTemplates(item.id).map(templateId)).toEqual([templateId(invoice)]);
  });

  it('does not overwrite a competing metadata write between the read and create requests', async () => {
    h.writeSource('contract.txt', '契約書\n契約先：青葉株式会社');
    const { items } = await stage();
    const item = items[0]!;
    const set = h.gateway.setMetadata.bind(h.gateway);
    vi.spyOn(h.gateway, 'setMetadata').mockImplementationOnce(async (fileId, values, template) => {
      await set(fileId, { counterparty: '別処理の値' }, template);
      await set(fileId, values, template);
    });
    approveItem(h, item, 'LEGAL_CONTRACTS');
    await runUntilIdle(h);
    expect(h.store.getItem(item.id)?.state).not.toBe('COMPLETED');
    expect(await h.gateway.getMetadata(item.boxFileId!, contract)).toEqual({
      counterparty: '別処理の値',
    });
    expect(h.store.getWrittenTemplates(item.id)).toEqual([]);
  });

  it('selects a clear matching template from enabled choices without a document mapping', async () => {
    h.store.saveMetadataSettings([{ template: contract }, { template: invoice }], 0);
    h.writeSource('A社_業務委託契約書.txt', '業務委託契約書\n契約先：A社\n締結日：2026-04-01');
    const { items } = await stage();
    expect(h.store.getBusinessMetadata(items[0]!.id)).toMatchObject({
      templateId: templateId(contract),
      values: { counterparty: 'A社', signedDate: '2026-04-01T00:00:00Z' },
    });
  });

  it('uses the AI-selected ID even when the template name does not match the document label', async () => {
    const custom = { ...contract, templateKey: 'businessRecords', displayName: '取引台帳' };
    await h.gateway.createMetadataTemplate(custom);
    h.store.saveMetadataSettings([{ template: custom }, { template: invoice }], 0);
    h.writeSource('書類.txt', '業務委託契約書\n契約先：A社');
    const classify = vi
      .spyOn(h.gateway, 'extractStructured')
      .mockResolvedValue({
        provider: 'test',
        confidence: null,
        references: [],
        fields: {
          documentType: '契約書',
          metadataTemplateId: templateId(custom),
          suggestedDestinationKey: 'LEGAL_CONTRACTS',
        },
      });
    const { items } = await stage();
    expect(classify.mock.calls[0]![0].metadataTemplates).toEqual([custom, invoice]);
    expect(h.store.getBusinessMetadata(items[0]!.id)).toMatchObject({
      templateId: templateId(custom),
      extractionStatus: 'EXTRACTED',
      values: { counterparty: 'A社' },
    });
  });

  it.each(['NONE', 'enterprise/disabled', null, undefined, { id: 'contract' }])(
    'does not guess a template for an invalid or undecided AI answer %j',
    async (answer) => {
      h.writeSource('契約書.txt', '契約書\n契約先：A社');
      vi.spyOn(h.gateway, 'extractStructured').mockResolvedValue({
        provider: 'test',
        confidence: null,
        references: [],
        fields: {
          documentType: '契約書',
          metadataTemplateId: answer,
          suggestedDestinationKey: 'LEGAL_CONTRACTS',
        },
      });
      const extract = vi.spyOn(h.gateway, 'extractTemplate');
      const { items } = await stage();
      expect(h.store.getBusinessMetadata(items[0]!.id).templateId).toBeNull();
      expect(extract).not.toHaveBeenCalled();
    },
  );

  it('automatically extracts after a manual template choice without an extract flag', async () => {
    h.writeSource('メモ.txt', 'メモ\n請求元：A社');
    const { items } = await stage();
    const item = items[0]!;
    h.store.enqueueCommand(item.jobId, 'SELECT_METADATA_TEMPLATE', {
      itemId: item.id,
      templateId: templateId(invoice),
      revision: h.store.getBusinessMetadata(item.id).revision,
      observedBoxFileId: item.boxFileId,
      observedSha1: item.boxSha1,
    });
    await processCommands(h.ctx);
    expect(h.store.getBusinessMetadata(item.id)).toMatchObject({
      templateId: templateId(invoice),
      extractionStatus: 'EXTRACTED',
      values: { vendor: 'A社' },
    });
  });

  it('keeps a failed extraction visible and can retry without reclassifying or uploading', async () => {
    h.writeSource('契約書.txt', '契約書\n契約先：A社');
    const classify = vi.spyOn(h.gateway, 'extractStructured');
    vi.spyOn(h.gateway, 'extractTemplate').mockRejectedValueOnce(
      new ShuttleError('AI_UNSUPPORTED', 'unsupported'),
    );
    const { items } = await stage();
    const item = items[0]!;
    expect(item.state).toBe('REVIEW_REQUIRED');
    expect(h.store.getBusinessMetadata(item.id)).toMatchObject({
      templateId: templateId(contract),
      extractionStatus: 'FAILED',
    });
    select(item, templateId(contract), true);
    await processCommands(h.ctx);
    expect(h.store.getBusinessMetadata(item.id)).toMatchObject({
      extractionStatus: 'EXTRACTED',
      values: { counterparty: 'A社' },
    });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(h.store.getItem(item.id)?.boxFileId).toBe(item.boxFileId);
  });

  it('distinguishes an empty extraction from failure and preserves prior values on failed re-extraction', async () => {
    h.writeSource('契約書.txt', '契約書\n契約先：A社');
    const { items } = await stage();
    const item = items[0]!;
    const extract = vi
      .spyOn(h.gateway, 'extractTemplate')
      .mockRejectedValueOnce(new Error('network'));
    select(item, templateId(contract), true);
    await processCommands(h.ctx);
    expect(h.store.getBusinessMetadata(item.id)).toMatchObject({
      extractionStatus: 'FAILED',
      values: { counterparty: 'A社' },
    });
    extract.mockResolvedValueOnce({});
    select(item, templateId(invoice), true);
    await processCommands(h.ctx);
    expect(h.store.getBusinessMetadata(item.id)).toMatchObject({
      extractionStatus: 'EMPTY',
      values: {},
    });
  });

  it('lets an existing job choose a newly enabled template, extract and apply its values', async () => {
    h.writeSource('A社_請求書.txt', '請求書\n請求元：A社\n金額：110000\n通貨：JPY');
    const job = h.store.createJob({ profileId: h.createProfile().id, operatorLabel: '担当者' });
    h.store.saveJobMetadata(job.id, []);
    h.store.enqueueCommand(job.id, 'START_JOB');
    await runUntilIdle(h);
    const item = h.store.listItems(job.id)[0]!;
    expect(h.store.getBusinessMetadata(item.id).templateId).toBeNull();
    h.store.saveMetadataSettings([{ template: invoice }], 0);
    select(item, templateId(invoice), true);
    await processCommands(h.ctx);
    expect(h.store.getBusinessMetadata(item.id)).toMatchObject({
      templateId: templateId(invoice),
      values: { vendor: 'A社', amount: 110000 },
    });
    // Removing a setting must not silently change already selected/approved schemas.
    h.store.saveMetadataSettings([], 1);
    approveItem(h, item, 'FINANCE_INVOICES');
    await runUntilIdle(h);
    expect(h.store.getItem(item.id)?.state).toBe('COMPLETED');
    expect(await h.gateway.getMetadata(item.boxFileId!, invoice)).toMatchObject({
      vendor: 'A社',
      amount: 110000,
    });
  });

  it('rejects a template disabled while extraction is running without saving its values', async () => {
    h.writeSource('memo.txt', '請求元：A社');
    const { items } = await stage(false);
    const item = items[0]!;
    h.store.saveMetadataSettings([{ template: invoice }], 0);
    const command = select(item, templateId(invoice));
    const get = h.gateway.getMetadataTemplate.bind(h.gateway);
    vi.spyOn(h.gateway, 'getMetadataTemplate').mockImplementationOnce(async (template) => {
      h.store.saveMetadataSettings([], 1);
      return get(template);
    });
    await processCommands(h.ctx);
    expect(h.store.listCommands(item.jobId).find((entry) => entry.id === command.id)?.state).toBe(
      'REJECTED',
    );
    expect(h.store.getBusinessMetadata(item.id).templateId).toBeNull();
  });
});
