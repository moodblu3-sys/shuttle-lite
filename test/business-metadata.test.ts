import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeBusinessValues,
  templateId,
  type MigrationItem,
  type TemplateMapping,
} from '@shuttle-lite/core';
import { demoBusinessTemplates } from '../packages/box/src/fake/business-templates';
import { createHarness, runUntilIdle, approveItem, type Harness } from './harness';
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
});
