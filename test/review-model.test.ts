import { describe, expect, it } from 'vitest';
import {
  bulkReviewItems,
  canApprove,
  commandFor,
  draftFor,
  groupReviewItems,
  matchesReviewSearch,
  isReviewPending,
  reviewRevision,
} from '../apps/web/src/lib/review-model';
import type { ReviewItemView } from '../apps/web/src/lib/review-types';

const destinations = [
  { key: 'CONTRACTS', label: '契約書', boxPath: '/営業部/青葉商事/契約書' },
  { key: 'PROPOSALS', label: '提案書', boxPath: '/営業部/北斗工業/提案書' },
  { key: 'NEEDS_REVIEW', label: '要判断', boxPath: '/要判断' },
];
const item = (id: string, patch: Partial<ReviewItemView> = {}): ReviewItemView => ({
  itemId: id,
  jobId: 'job',
  state: 'REVIEW_REQUIRED',
  sourceRelativePath: `${id}/契約書.pdf`,
  sourceFileName: '契約書.pdf',
  sourceSize: 240,
  sourceSha1: 'digest',
  boxFileId: `box-${id}`,
  boxSha1: 'digest',
  boxVersionId: 'version-1',
  lastErrorCategory: null,
  lastError: null,
  operatorAction: null,
  needsAttention: false,
  finalName: null,
  suggestedDestinationKey: 'CONTRACTS',
  hasRoutingDecision: true,
  suggestionSource: 'AI',
  suggestionReason: '契約内容が一致',
  extraction: null,
  reviewCommand: null,
  ...patch,
});

describe('review workspace approval boundaries', () => {
  it('groups by destination and separates unresolved, unknown and failed items', () => {
    const good = item('one');
    const other = item('two', { suggestedDestinationKey: 'PROPOSALS' });
    const undecided = item('three', {
      suggestedDestinationKey: 'NEEDS_REVIEW',
      hasRoutingDecision: false,
    });
    const unknown = item('four', { suggestedDestinationKey: 'REMOVED' });
    const failed = item('five', { needsAttention: true, lastErrorCategory: 'MOVE_CONFLICT' });
    const result = groupReviewItems(
      [good, other, undecided, unknown, failed],
      destinations,
      'NEEDS_REVIEW',
    );
    expect(
      result.groups.map((group) => [
        group.destination.key,
        group.items.map((entry) => entry.itemId),
      ]),
    ).toEqual([
      ['CONTRACTS', ['one']],
      ['PROPOSALS', ['two']],
    ]);
    expect(result.undecided.map((entry) => entry.itemId)).toEqual(['three', 'four']);
    expect(result.attention).toEqual([failed]);
  });
  it('never bulk approves exceptions even when selected and manually given a valid destination', () => {
    const rows = [
      item('one'),
      item('two', { needsAttention: true }),
      item('three', { hasRoutingDecision: false, suggestedDestinationKey: 'NEEDS_REVIEW' }),
    ];
    const selected = new Map(rows.map((entry) => [entry.itemId, reviewRevision(entry)]));
    const draft = (entry: ReviewItemView) => ({ ...draftFor(entry), destinationKey: 'PROPOSALS' });
    expect(
      bulkReviewItems(rows, selected, draft, destinations, 'NEEDS_REVIEW').map(
        (entry) => entry.itemId,
      ),
    ).toEqual(['one']);
    expect(canApprove(draft(rows[2]!), destinations, 'NEEDS_REVIEW')).toBe(true);
  });
  it('excludes cleared, review-only and missing destinations from approval', () => {
    const row = item('one');
    for (const destinationKey of ['', 'NEEDS_REVIEW', 'REMOVED']) {
      const draft = { ...draftFor(row), destinationKey };
      expect(canApprove(draft, destinations, 'NEEDS_REVIEW')).toBe(false);
      expect(
        bulkReviewItems(
          [row],
          new Map([[row.itemId, reviewRevision(row)]]),
          () => draft,
          destinations,
          'NEEDS_REVIEW',
        ),
      ).toEqual([]);
    }
  });
  it('does not select an arbitrary default for an unresolved document', () => {
    expect(
      draftFor(item('one', { hasRoutingDecision: false, suggestedDestinationKey: 'NEEDS_REVIEW' }))
        .destinationKey,
    ).toBe('');
  });
  it('preserves the reviewed Box snapshot and human overrides in the command', () => {
    const row = item('one');
    const command = commandFor(
      row,
      {
        ...draftFor(row),
        destinationKey: 'PROPOSALS',
        finalName: '契約書 (2).pdf',
        documentType: ' 修正した種別 ',
      },
      'reviewer',
    );
    expect(command).toMatchObject({
      type: 'APPROVE_ITEM',
      payload: {
        itemId: 'one',
        destinationKey: 'PROPOSALS',
        operatorLabel: 'reviewer',
        observedBoxFileId: 'box-one',
        observedSha1: 'digest',
        observedVersionId: 'version-1',
        finalName: '契約書 (2).pdf',
        metadata: { documentType: '修正した種別' },
      },
    });
    expect(commandFor(row, draftFor(row), 'reviewer').payload.finalName).toBeNull();
  });
  it('searches Japanese paths, reasons and width/case variants without merging same-name files', () => {
    const rows = [item('ＡＢＣ'), item('other')];
    expect(rows.filter((entry) => matchesReviewSearch(entry, 'abc'))).toEqual([rows[0]]);
    expect(rows.filter((entry) => matchesReviewSearch(entry, '契約書'))).toHaveLength(2);
    expect(matchesReviewSearch(rows[0]!, '内容が一致')).toBe(true);
    expect(matchesReviewSearch(rows[0]!, '見積書')).toBe(false);
  });
});

it('places only the selected eligible document when workspace commands reach the worker', async () => {
  const { createHarness, runUntilIdle } = await import('./harness');
  const harness = await createHarness();
  try {
    harness.writeSource(
      'one/契約書.txt',
      '業務委託契約書 契約番号 LEG-2026-0042 甲乙は契約を締結する。',
    );
    harness.writeSource(
      'two/契約書.txt',
      '業務委託契約書 契約番号 LEG-2026-0043 甲乙は契約を締結する。',
    );
    const profile = harness.createProfile();
    const job = harness.store.createJob({ profileId: profile.id, operatorLabel: 'tester' });
    harness.store.enqueueCommand(job.id, 'START_JOB');
    await runUntilIdle(harness);
    const staged = harness.store.listItems(job.id);
    const views = staged.map((source, index) =>
      item(source.id, {
        jobId: job.id,
        sourceFileName: source.sourceFileName,
        sourceRelativePath: source.sourceRelativePath,
        boxFileId: source.boxFileId,
        boxSha1: source.boxSha1,
        boxVersionId: source.boxFileVersionId,
        suggestedDestinationKey: index === 0 ? 'LEGAL_CONTRACTS' : 'NEEDS_REVIEW',
        hasRoutingDecision: index === 0,
      }),
    );
    const selected = new Map(views.map((entry) => [entry.itemId, reviewRevision(entry)]));
    const targets = bulkReviewItems(
      views,
      selected,
      draftFor,
      harness.catalog.entries,
      harness.catalog.needsReviewKey,
    );
    expect(targets).toHaveLength(1);
    for (const target of targets) {
      const command = commandFor(target, draftFor(target), 'reviewer');
      harness.store.enqueueCommand(job.id, command.type, command.payload);
    }
    await runUntilIdle(harness);
    const placed = harness.store.getItem(staged[0]!.id)!;
    expect(placed.state).toBe('COMPLETED');
    expect(placed.boxFileId).toBe(staged[0]!.boxFileId);
    expect(harness.store.getItem(staged[1]!.id)!.state).toBe('REVIEW_REQUIRED');
    expect(harness.store.getItem(staged[1]!.id)!.finalFolderId).toBeNull();
    expect(harness.store.getJob(job.id)!.state).not.toBe('COMPLETED');
  } finally {
    harness.cleanup();
  }
});

it('groups a manually changed file under the destination that will actually receive it', () => {
  const source = item('changed');
  const draft = (entry: ReviewItemView) => ({ ...draftFor(entry), destinationKey: 'PROPOSALS' });
  const result = groupReviewItems([source], destinations, 'NEEDS_REVIEW', draft);
  expect(result.groups.map((group) => group.destination.key)).toEqual(['PROPOSALS']);
});

it('requires selecting a new document snapshot again after a worker refresh', () => {
  const before = item('changed');
  const after = item('changed', {
    boxVersionId: 'version-2',
    suggestedDestinationKey: 'PROPOSALS',
  });
  const selected = new Map([[before.itemId, reviewRevision(before)]]);
  expect(bulkReviewItems([after], selected, draftFor, destinations, 'NEEDS_REVIEW')).toEqual([]);
});

it('restores pending locks after reload and releases rejected or completed commands', () => {
  const receipt = {
    id: 'command-1',
    state: 'PENDING' as const,
    rejectionReason: null,
    createdAt: '2026-09-22T00:00:01.000Z',
  };
  const source = item('one');
  expect(isReviewPending(source, receipt)).toBe(true);
  for (const state of ['PENDING', 'CLAIMED'] as const) {
    const pending = { ...source, reviewCommand: { ...receipt, state } };
    expect(isReviewPending(pending)).toBe(true);
    expect(
      bulkReviewItems(
        [pending],
        new Map([[source.itemId, reviewRevision(source)]]),
        draftFor,
        destinations,
        'NEEDS_REVIEW',
      ),
    ).toEqual([]);
  }
  for (const state of ['REJECTED', 'DONE'] as const) {
    const returned = { ...source, reviewCommand: { ...receipt, state } };
    expect(isReviewPending(returned, receipt)).toBe(false);
    // Receipt-only updates do not discard metadata corrections.
    expect(reviewRevision(returned)).toBe(reviewRevision(source));
  }
  expect(
    isReviewPending(
      {
        ...source,
        reviewCommand: {
          ...receipt,
          id: 'older',
          state: 'REJECTED',
          createdAt: '2026-09-22T00:00:00.000Z',
        },
      },
      receipt,
    ),
  ).toBe(true);
});

it('reloads a rejected command from the store, then allows a corrected approval', async () => {
  const { createHarness, runUntilIdle } = await import('./harness');
  const { processCommands } = await import('../apps/worker/src/commands');
  const harness = await createHarness();
  try {
    harness.writeSource(
      '契約書.txt',
      '業務委託契約書 契約番号 LEG-2026-0042 甲乙は契約を締結する。',
    );
    const profile = harness.createProfile();
    const job = harness.store.createJob({ profileId: profile.id, operatorLabel: 'reviewer' });
    harness.store.enqueueCommand(job.id, 'START_JOB');
    await runUntilIdle(harness);
    const staged = harness.store.listItems(job.id)[0]!;
    const source = item(staged.id, {
      jobId: job.id,
      sourceFileName: staged.sourceFileName,
      boxFileId: staged.boxFileId,
      boxSha1: staged.boxSha1,
      boxVersionId: staged.boxFileVersionId,
      suggestedDestinationKey: 'LEGAL_CONTRACTS',
    });
    const invalid = commandFor(
      source,
      { ...draftFor(source), documentType: '長'.repeat(121) },
      'reviewer',
    );
    const receipt = harness.store.enqueueCommand(job.id, invalid.type, invalid.payload);
    expect(
      isReviewPending({
        ...source,
        reviewCommand: harness.store.latestReviewCommand(job.id, staged.id),
      }),
    ).toBe(true);
    await processCommands(harness.ctx);
    // This cannot rely on the generic command endpoint's 50-record window.
    for (let index = 0; index < 55; index += 1) {
      const noise = harness.store.enqueueCommand(job.id, 'GENERATE_REPORT');
      harness.store.completeCommand(noise.id);
    }
    const rejected = harness.store.latestReviewCommand(job.id, staged.id)!;
    expect(rejected.state).toBe('REJECTED');
    expect(rejected.rejectionReason).toContain('APPROVAL_INVALID');
    expect(isReviewPending({ ...source, reviewCommand: rejected }, receipt)).toBe(false);
    expect(harness.store.getItem(staged.id)!.state).toBe('REVIEW_REQUIRED');
    const corrected = commandFor(source, draftFor(source), 'reviewer');
    const retry = harness.store.enqueueCommand(job.id, corrected.type, corrected.payload);
    expect(harness.store.latestReviewCommand(job.id, staged.id)!.id).toBe(retry.id);
    expect(isReviewPending({ ...source, reviewCommand: retry }, receipt)).toBe(true);
    expect(harness.store.latestReviewCommand('another-job', staged.id)).toBeNull();
    await runUntilIdle(harness);
    expect(harness.store.getItem(staged.id)!.state).toBe('COMPLETED');
    expect(harness.store.getItem(staged.id)!.boxFileId).toBe(staged.boxFileId);
  } finally {
    harness.cleanup();
  }
});
