import { openSync, readSync, closeSync } from 'node:fs';

export interface FakeClassification {
  readonly documentType: string | null;
  readonly businessDomain: string | null;
  readonly businessIdentifier: string | null;
  readonly effectiveDate: string | null;
  readonly suggestedDestinationKey: string | null;
  readonly suggestedTags: readonly string[];
  readonly reason: string;
  readonly confidence: number | null;
  readonly references: readonly string[];
}

interface Rule {
  readonly destinationKey: string;
  readonly documentType: string;
  readonly businessDomain: string;
  readonly patterns: readonly RegExp[];
  readonly tags: readonly string[];
}

const RULES: readonly Rule[] = [
  {
    destinationKey: 'LEGAL_CONTRACTS',
    documentType: 'Contract',
    businessDomain: 'Legal',
    patterns: [/契約/, /\bmsa\b/i, /\bnda\b/i, /業務委託/, /\bcontract\b/i, /甲.{0,4}乙/],
    tags: ['contract', 'legal'],
  },
  {
    destinationKey: 'FINANCE_INVOICES',
    documentType: 'Invoice',
    businessDomain: 'Finance',
    patterns: [/請求/, /\binvoice\b/i, /支払期限/, /\bamount due\b/i, /消費税/],
    tags: ['invoice', 'finance'],
  },
  {
    destinationKey: 'HR_RECORDS',
    documentType: 'Employee record',
    businessDomain: 'HR',
    patterns: [/従業員/, /社員番号/, /\bemployee\b/i, /人事評価/, /入社/, /\bpayroll\b/i],
    tags: ['hr', 'employee'],
  },
  {
    destinationKey: 'IT_RUNBOOKS',
    documentType: 'Runbook',
    businessDomain: 'IT',
    patterns: [/手順/, /\brunbook\b/i, /障害対応/, /\bincident\b/i, /\bdeploy\b/i, /監視/],
    tags: ['runbook', 'operations'],
  },
  {
    destinationKey: 'SALES_PROPOSALS',
    documentType: 'Proposal',
    businessDomain: 'Sales',
    patterns: [/提案/, /\bproposal\b/i, /\bsow\b/i, /見積/, /\bpricing\b/i],
    tags: ['proposal', 'sales'],
  },
];

const IDENTIFIER_PATTERNS: readonly RegExp[] = [
  /(?:契約番号|請求番号|社員番号|文書番号)[:：\s]*([A-Za-z0-9-]+)/,
  /\b(?:contract|invoice|document|employee)\s*(?:no\.?|number|id)[:\s]*([A-Za-z0-9-]+)/i,
  /\b([A-Z]{2,5}-\d{4}-\d{2,5})\b/,
];

const DATE_PATTERNS: readonly RegExp[] = [
  /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/,
  /\b(\d{4})-(\d{2})-(\d{2})\b/,
];

export function readTextHead(path: string, maxBytes = 64 * 1024): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(maxBytes);
    const read = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Deterministic stand-in for Box AI Structured Extract. It only produces
 * destination keys from the allowlist it is given, and returns no suggestion
 * at all when the evidence is thin, so the manual review path stays reachable.
 */
export function classifyText(
  text: string,
  fileName: string,
  allowedKeys: readonly string[],
): FakeClassification {
  const haystack = `${fileName}\n${text}`;
  const scored = RULES.map((rule) => ({
    rule,
    hits: rule.patterns.filter((pattern) => pattern.test(haystack)),
  }))
    .filter((entry) => entry.hits.length > 0 && allowedKeys.includes(entry.rule.destinationKey))
    .sort((a, b) => b.hits.length - a.hits.length);

  const identifier = IDENTIFIER_PATTERNS.map((pattern) => haystack.match(pattern)?.[1]).find(
    (value): value is string => Boolean(value),
  );
  const dateMatch = DATE_PATTERNS.map((pattern) => haystack.match(pattern)).find(
    (match): match is RegExpMatchArray => Boolean(match),
  );
  const effectiveDate =
    dateMatch && dateMatch[1] && dateMatch[2] && dateMatch[3]
      ? `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`
      : null;

  const best = scored[0];
  if (!best) {
    return {
      documentType: null,
      businessDomain: null,
      businessIdentifier: identifier ?? null,
      effectiveDate,
      suggestedDestinationKey: null,
      suggestedTags: [],
      reason: '既知のdocument typeに一致する手掛かりが見つかりませんでした。',
      confidence: null,
      references: [],
    };
  }

  const runnerUp = scored[1];
  const ambiguous = runnerUp !== undefined && runnerUp.hits.length === best.hits.length;
  const references = best.hits
    .map((pattern) => haystack.match(pattern)?.[0])
    .filter((value): value is string => Boolean(value))
    .slice(0, 3);

  if (ambiguous) {
    return {
      documentType: best.rule.documentType,
      businessDomain: best.rule.businessDomain,
      businessIdentifier: identifier ?? null,
      effectiveDate,
      suggestedDestinationKey: null,
      suggestedTags: best.rule.tags,
      reason: `${best.rule.destinationKey} と ${runnerUp.rule.destinationKey} の両方に一致し、判断できませんでした。`,
      confidence: null,
      references,
    };
  }

  return {
    documentType: best.rule.documentType,
    businessDomain: best.rule.businessDomain,
    businessIdentifier: identifier ?? null,
    effectiveDate,
    suggestedDestinationKey: best.rule.destinationKey,
    suggestedTags: best.rule.tags,
    reason: `${references.join(' / ') || best.rule.documentType} を根拠に ${best.rule.destinationKey} を提案します。`,
    // Reported only when the matcher had more than one independent hit.
    confidence: best.hits.length >= 2 ? Math.min(0.95, 0.55 + 0.1 * best.hits.length) : null,
    references,
  };
}

const UNSUPPORTED_EXTENSIONS = new Set(['.bin', '.zip', '.exe', '.dmg', '.iso', '.gz']);

export function isUnsupportedForAi(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return false;
  return UNSUPPORTED_EXTENSIONS.has(fileName.slice(dot).toLowerCase());
}
