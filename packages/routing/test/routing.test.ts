import { describe, expect, it } from 'vitest';
import {
  buildProvenanceMetadata,
  buildRoutingMetadata,
  checkApprovalFreshness,
  hasRoutingDecision,
  missingProvenanceKeys,
  normalizeExtraction,
  parseApprovalRequest,
  routingOutcome,
  type ApprovalSnapshot,
} from '@shuttle-lite/routing';

const KEYS = ['LEGAL_CONTRACTS', 'FINANCE_INVOICES', 'NEEDS_REVIEW'];

const sha1 = 'a'.repeat(40);

describe('extraction normalisation', () => {
  it('accepts a catalog key and tidies the other fields', () => {
    const result = normalizeExtraction(
      {
        provider: 'box-ai',
        fields: {
          documentType: ' Contract ',
          businessDomain: 'Legal',
          businessIdentifier: 'LEG-2026-0042',
          effectiveDate: '2026-04-01T00:00:00Z',
          suggestedDestinationKey: 'legal-contracts',
          suggestedTags: 'contract, legal, contract',
          reason: '契約書のため',
        },
        confidence: 0.81,
        references: ['甲および乙'],
      },
      KEYS,
    );
    expect(result.suggestedDestinationKey).toBe('LEGAL_CONTRACTS');
    expect(result.rejectedDestinationKey).toBeNull();
    expect(result.documentType).toBe('Contract');
    expect(result.effectiveDate).toBe('2026-04-01');
    expect(result.suggestedTags).toEqual(['contract', 'legal']);
    expect(result.confidence).toBe(0.81);
  });

  it('records but never uses a key outside the catalog', () => {
    const result = normalizeExtraction(
      {
        provider: 'box-ai',
        fields: { suggestedDestinationKey: 'FINANCE_SECRET_VAULT', reason: 'なんとなく' },
        confidence: null,
        references: [],
      },
      KEYS,
    );
    expect(result.suggestedDestinationKey).toBeNull();
    expect(result.rejectedDestinationKey).toBe('FINANCE_SECRET_VAULT');
    expect(routingOutcome(result)).toEqual({
      kind: 'NEEDS_INPUT',
      reason: 'catalogに存在しないdestination keyが返されました: FINANCE_SECRET_VAULT',
    });
  });

  it('never invents a confidence score', () => {
    const result = normalizeExtraction(
      {
        provider: 'box-ai',
        fields: { suggestedDestinationKey: 'LEGAL_CONTRACTS' },
        confidence: null,
        references: [],
      },
      KEYS,
    );
    expect(result.confidence).toBeNull();
  });

  it('drops an unparseable date instead of guessing', () => {
    const result = normalizeExtraction(
      {
        provider: 'box-ai',
        fields: { effectiveDate: '来年の春', suggestedDestinationKey: 'LEGAL_CONTRACTS' },
        confidence: null,
        references: [],
      },
      KEYS,
    );
    expect(result.effectiveDate).toBeNull();
  });

  it('rejects an answer whose shape is wrong', () => {
    expect(() =>
      normalizeExtraction(
        { provider: 'box-ai', fields: { documentType: 42 }, confidence: null, references: [] },
        KEYS,
      ),
    ).toThrowError(/schemaに一致しません/);
  });

  it('sends an abstaining answer to manual input', () => {
    const result = normalizeExtraction(
      {
        provider: 'box-ai',
        fields: { suggestedDestinationKey: null, reason: '手掛かりがありません' },
        confidence: null,
        references: [],
      },
      KEYS,
    );
    expect(routingOutcome(result)).toEqual({
      kind: 'NEEDS_INPUT',
      reason: '手掛かりがありません',
    });
  });
});

describe('approval validation', () => {
  const valid = {
    itemId: 'it_' + '0'.repeat(24),
    destinationKey: 'legal_contracts',
    operatorLabel: 'demo-operator (local)',
    observedBoxFileId: 'fil1001',
    observedSha1: sha1,
    observedVersionId: 'ver1',
    metadata: { documentType: 'Contract', effectiveDate: '2026-04-01' },
  };

  it('normalises the destination key and keeps the operator label', () => {
    const parsed = parseApprovalRequest(valid, KEYS);
    expect(parsed.destinationKey).toBe('LEGAL_CONTRACTS');
    expect(parsed.operatorLabel).toBe('demo-operator (local)');
  });

  it('refuses a destination outside the catalog', () => {
    expect(() => parseApprovalRequest({ ...valid, destinationKey: 'ANYWHERE' }, KEYS)).toThrowError(
      /catalogに存在しないdestination/,
    );
  });

  it('treats a blank rename as "use the source name"', () => {
    expect(parseApprovalRequest(valid, KEYS).finalName).toBeNull();
    expect(parseApprovalRequest({ ...valid, finalName: '   ' }, KEYS).finalName).toBeNull();
    expect(parseApprovalRequest({ ...valid, finalName: ' nda (2).pdf ' }, KEYS).finalName).toBe(
      'nda (2).pdf',
    );
  });

  it('refuses a rename Box cannot store', () => {
    expect(() => parseApprovalRequest({ ...valid, finalName: 'a/b.pdf' }, KEYS)).toThrowError(
      /Boxで利用できないfile名/,
    );
  });

  it('refuses a malformed digest or date', () => {
    expect(() => parseApprovalRequest({ ...valid, observedSha1: 'nope' }, KEYS)).toThrowError(
      /承認内容の検証に失敗/,
    );
    expect(() =>
      parseApprovalRequest({ ...valid, metadata: { effectiveDate: '2026/04/01' } }, KEYS),
    ).toThrowError(/承認内容の検証に失敗/);
  });
});

describe('approval freshness', () => {
  const snapshot: ApprovalSnapshot = {
    approvedDestinationKey: 'LEGAL_CONTRACTS',
    approvedBoxFileId: 'fil1001',
    approvedBoxVersionId: 'ver1',
    approvedSha1: sha1,
    operatorLabel: 'demo-operator (local)',
    approvedAt: '2026-09-13T12:00:00.000Z',
  };
  const current = {
    fileId: 'fil1001',
    sha1,
    versionId: 'ver1',
    parentFolderId: 'fld_staging',
  };

  it('passes when nothing changed', () => {
    expect(
      checkApprovalFreshness(snapshot, current, {
        expectedStagingFolderId: 'fld_staging',
        allowedKeys: KEYS,
      }),
    ).toEqual({ fresh: true });
  });

  it('re-opens the decision when the content changed', () => {
    expect(checkApprovalFreshness(snapshot, { ...current, sha1: 'b'.repeat(40) })).toEqual({
      fresh: false,
      reason: 'file内容 (SHA-1) が承認時と異なります',
    });
  });

  it('re-opens the decision when a new version appeared', () => {
    expect(checkApprovalFreshness(snapshot, { ...current, versionId: 'ver2' })).toEqual({
      fresh: false,
      reason: 'file versionが承認時と異なります',
    });
  });

  it('re-opens the decision when the file already left staging', () => {
    expect(
      checkApprovalFreshness(
        snapshot,
        { ...current, parentFolderId: 'fld_elsewhere' },
        {
          expectedStagingFolderId: 'fld_staging',
        },
      ),
    ).toEqual({ fresh: false, reason: 'fileがstaging folderから移動しています' });
  });

  it('re-opens the decision when the destination disappeared from the catalog', () => {
    expect(
      checkApprovalFreshness(snapshot, current, { allowedKeys: ['FINANCE_INVOICES'] }),
    ).toEqual({ fresh: false, reason: '承認したdestinationがcatalogから削除されています' });
  });

  it('re-opens the decision when the file is gone', () => {
    expect(checkApprovalFreshness(snapshot, null).fresh).toBe(false);
  });
});

describe('metadata builders', () => {
  const provenance = {
    migrationJobId: 'job_1',
    migrationItemId: 'it_' + '0'.repeat(24),
    sourceRelativePath: 'legal/msa.pdf',
    sourceFileName: 'msa.pdf',
    sourceModifiedAt: '2026-09-01T00:00:00.000Z',
    sourceSize: 2048,
    sourceSha1: sha1,
    migratedAt: '2026-09-13T12:00:00.000Z',
    migrationStatus: 'VERIFIED' as const,
  };

  it('writes relative paths only', () => {
    const record = buildProvenanceMetadata(provenance);
    expect(record.sourceRelativePath).toBe('legal/msa.pdf');
    expect(() =>
      buildProvenanceMetadata({ ...provenance, sourceRelativePath: '/Users/me/legal/msa.pdf' }),
    ).toThrowError(/絶対path/);
  });

  it('omits empty optional routing fields rather than writing nulls', () => {
    const record = buildRoutingMetadata({
      documentType: 'Contract',
      businessDomain: null,
      businessIdentifier: '',
      effectiveDate: null,
      suggestedTags: 'contract',
      suggestedDestinationKey: 'LEGAL_CONTRACTS',
      routingReason: null,
      approvedDestinationKey: 'LEGAL_CONTRACTS',
      approvedBy: 'demo-operator (local)',
    });
    expect(record).toEqual({
      approvedDestinationKey: 'LEGAL_CONTRACTS',
      approvedBy: 'demo-operator (local)',
      migrationStatus: 'PLACED',
      documentType: 'Contract',
      suggestedTags: 'contract',
      suggestedDestinationKey: 'LEGAL_CONTRACTS',
    });
  });

  it('does not treat the needs-review key as a routing decision', () => {
    // 実Boxで判断できないPDFを通したとき、AIは NEEDS_REVIEW を返した。これは
    // catalogに実在するkeyなので、提案として扱うと「AI提案どおり一括承認」が
    // 誰も判断していない文書を完了させてしまう。
    expect(hasRoutingDecision('LEGAL_CONTRACTS', 'NEEDS_REVIEW')).toBe(true);
    expect(hasRoutingDecision('NEEDS_REVIEW', 'NEEDS_REVIEW')).toBe(false);
    expect(hasRoutingDecision(null, 'NEEDS_REVIEW')).toBe(false);
  });

  it('detects missing provenance so an item cannot be completed', () => {
    expect(missingProvenanceKeys(null)).toContain('migrationJobId');
    expect(missingProvenanceKeys(buildProvenanceMetadata(provenance))).toEqual([]);
    const partial = { ...buildProvenanceMetadata(provenance), sourceSha1: '' };
    expect(missingProvenanceKeys(partial)).toEqual(['sourceSha1']);
  });
});
