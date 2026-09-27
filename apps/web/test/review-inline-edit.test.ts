// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewList } from '../src/components/review-list';
import { loadReviewDraft } from '../src/lib/review-drafts';
import type { ReviewItemView } from '../src/lib/review-types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
const template = {
  scope: 'enterprise',
  templateKey: 'contract',
  displayName: '契約書管理',
  fields: [{ key: 'name', displayName: '契約先', type: 'string' as const }],
};
const other = { ...template, templateKey: 'invoice', displayName: '請求書管理' };
function item(id: string, patch: Partial<ReviewItemView> = {}): ReviewItemView {
  return {
    itemId: id,
    jobId: 'job',
    state: 'REVIEW_REQUIRED',
    sourceRelativePath: `${id}.pdf`,
    sourceFileName: `${id}.pdf`,
    sourceSize: 10,
    sourceSha1: 'sha',
    boxFileId: `box-${id}`,
    boxSha1: 'sha',
    boxVersionId: 'v1',
    lastErrorCategory: null,
    lastError: null,
    operatorAction: null,
    needsAttention: false,
    finalName: null,
    suggestedDestinationKey: null,
    hasRoutingDecision: false,
    suggestionSource: 'AI',
    suggestionReason: null,
    extraction: null,
    reviewCommand: null,
    businessMetadata: {
      revision: 1,
      templateId: 'enterprise/contract',
      template,
      values: { name: '古い値' },
      canExtract: true,
      extractionStatus: 'EXTRACTED',
    },
    ...patch,
  };
}
const receipt = (id: string) => ({
  id,
  state: 'PENDING' as const,
  createdAt: '2026-09-27T01:00:00Z',
  rejectionReason: null,
});

describe('inline and bulk review edits', () => {
  let root: Root;
  let container: HTMLDivElement;
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    localStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  async function render(items: ReviewItemView[]) {
    await act(async () =>
      root.render(
        createElement(ReviewList, {
          jobId: 'job',
          items,
          destinations: [
            { key: 'contracts', label: '契約書', boxPath: '/営業/契約書' },
            { key: 'invoices', label: '請求書', boxPath: '/営業/請求書' },
          ],
          needsReviewKey: 'REVIEW',
          boxLinkBase: null,
          defaultOperatorLabel: '担当者',
          metadataTemplates: [{ template }, { template: other }],
        }),
      ),
    );
  }
  function button(text: string) {
    return [...container.querySelectorAll('button')].find((b) => b.textContent === text)!;
  }
  async function click(text: string) {
    await act(async () => button(text).click());
  }
  async function change(select: HTMLSelectElement, value: string) {
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  async function all() {
    await act(async () =>
      container.querySelector<HTMLInputElement>('[aria-label="全選択"]')!.click(),
    );
  }
  async function applyDestination() {
    await click('配置先を変更');
    const select = container.querySelector<HTMLSelectElement>('footer select')!;
    await change(select, 'invoices');
    await click('選択した2件に適用');
  }
  const destination = (id: string) =>
    container.querySelector<HTMLSelectElement>(`[aria-label="${id}.pdf の配置先"]`)!;
  const chooseTemplate = (id: string) =>
    container.querySelector<HTMLSelectElement>(`[aria-label="${id}.pdf のテンプレート"]`)!;

  it('assigns unselected files together and approves exactly the edited destinations', async () => {
    const rows = [item('A'), item('B')];
    fetchMock.mockImplementation(async (_, init) =>
      Response.json({ command: receipt(JSON.parse(init!.body as string).payload.itemId) }),
    );
    await render(rows);
    expect(container.querySelector('aside')).toBeNull();
    await all();
    expect(container.textContent).toContain('2件を選択中');
    expect(button('選択した2件を承認').disabled).toBe(true);
    await applyDestination();
    expect(destination('A').value).toBe('invoices');
    expect(destination('B').value).toBe('invoices');
    await render([...rows]);
    expect(button('選択した2件を承認').disabled).toBe(false);
    expect(loadReviewDraft(localStorage, rows[0]!)!.draft.destinationKey).toBe('invoices');
    await click('選択した2件を承認');
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init!.body as string))).toMatchObject([
      { type: 'APPROVE_ITEM', payload: { itemId: 'A', destinationKey: 'invoices' } },
      { type: 'APPROVE_ITEM', payload: { itemId: 'B', destinationKey: 'invoices' } },
    ]);
  });

  it('excludes failures and pending items, and never silently approves a subset of mixed selections', async () => {
    await render([
      item('ready', { suggestedDestinationKey: 'contracts', hasRoutingDecision: true }),
      item('unset'),
      item('failed', { needsAttention: true }),
      item('pending', { reviewCommand: receipt('pending') }),
    ]);
    await all();
    expect(container.textContent).toContain('2件を選択中');
    expect(button('選択した2件を承認').disabled).toBe(true);
    for (const id of ['failed', 'pending']) {
      expect(
        container.querySelector<HTMLInputElement>(`[aria-label="${id}.pdf を選択"]`)!.disabled,
      ).toBe(true);
    }
    await change(destination('unset'), 'contracts');
    expect(button('選択した2件を承認').disabled).toBe(false);
    await act(async () =>
      container.querySelector<HTMLInputElement>('[aria-label="ready.pdf を選択"]')!.click(),
    );
    expect(container.querySelector<HTMLInputElement>('[aria-label="全選択"]')!.indeterminate).toBe(
      true,
    );
    await render([item('unset', { boxVersionId: 'v2' })]);
    expect(container.textContent).toContain('0件を選択中');
    expect(destination('unset').value).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports partial template failures, retains failed selections and uses new extracted values', async () => {
    const rows = [item('A'), item('B')];
    fetchMock.mockImplementation(async (_, init) => {
      const payload = JSON.parse(init!.body as string).payload;
      return payload.itemId === 'A'
        ? Response.json({ command: receipt('template-A') })
        : Response.json({ error: '受付失敗' }, { status: 409 });
    });
    await render(rows);
    await all();
    await applyDestination();
    await click('テンプレートを変更');
    await change(
      container.querySelector<HTMLSelectElement>('footer select')!,
      'enterprise/invoice',
    );
    await click('選択した2件に適用');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(chooseTemplate('A').disabled).toBe(true);
    expect(container.textContent).toContain('1件を選択中');
    expect(container.querySelector('[role=alert]')!.textContent).toContain('B.pdf: 受付失敗');
    const updated = item('A', {
      businessMetadata: {
        ...rows[0]!.businessMetadata!,
        revision: 2,
        templateId: 'enterprise/invoice',
        template: other,
        values: { name: '新しい値' },
      },
      reviewCommand: { ...receipt('template-A'), state: 'DONE' },
    });
    await render([updated, rows[1]!]);
    expect(destination('A').value).toBe('invoices');
    expect(chooseTemplate('A').value).toBe('enterprise/invoice');
    expect(chooseTemplate('A').disabled).toBe(false);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(Response.json({ command: receipt('approve-A') }));
    await click('選択解除');
    await act(async () =>
      container.querySelector<HTMLInputElement>('[aria-label="A.pdf を選択"]')!.click(),
    );
    await click('選択した1件を承認');
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({
      type: 'APPROVE_ITEM',
      payload: {
        destinationKey: 'invoices',
        business: { revision: 2, templateId: 'enterprise/invoice', values: { name: '新しい値' } },
      },
    });
  });

  it('retains placement after a completed template command across reload, but not after a file change', async () => {
    const row = item('A');
    fetchMock.mockResolvedValue(Response.json({ command: receipt('template-A') }));
    await render([row]);
    await change(destination('A'), 'invoices');
    await change(chooseTemplate('A'), 'enterprise/invoice');
    const updated = item('A', {
      businessMetadata: {
        ...row.businessMetadata!,
        revision: 2,
        templateId: 'enterprise/invoice',
        template: other,
        values: { name: '新しい値' },
      },
      reviewCommand: { ...receipt('template-A'), state: 'DONE' },
    });
    await act(async () => root.unmount());
    root = createRoot(container);
    await render([updated]);
    expect(destination('A').value).toBe('invoices');
    expect(loadReviewDraft(localStorage, updated)!.draft.businessValues).toEqual({
      name: '新しい値',
    });
    await render([{ ...updated, boxVersionId: 'v2' }]);
    expect(destination('A').value).toBe('');
  });

  it('invalidates a placement draft when a different command or metadata revision completes', async () => {
    const row = item('A');
    fetchMock.mockResolvedValue(Response.json({ command: receipt('template-A') }));
    await render([row]);
    await change(destination('A'), 'invoices');
    await change(chooseTemplate('A'), 'enterprise/invoice');
    const next = {
      ...row,
      businessMetadata: {
        ...row.businessMetadata!,
        revision: 2,
        templateId: 'enterprise/invoice',
        template: other,
      },
    };
    expect(
      loadReviewDraft(localStorage, {
        ...next,
        reviewCommand: { ...receipt('unrelated'), state: 'DONE' },
      }),
    ).toBeUndefined();
    await render([
      {
        ...next,
        businessMetadata: { ...next.businessMetadata, revision: 3 },
        reviewCommand: { ...receipt('template-A'), state: 'DONE' },
      },
    ]);
    expect(destination('A').value).toBe('');
  });
});
