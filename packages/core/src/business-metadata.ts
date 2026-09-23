import { ShuttleError } from './errors';

export interface BusinessField {
  readonly key: string;
  readonly displayName: string;
  readonly type: 'string' | 'float' | 'date' | 'enum';
  readonly options?: readonly string[];
}

export interface BusinessTemplate {
  readonly scope: string;
  readonly templateKey: string;
  readonly displayName: string;
  readonly fields: readonly BusinessField[];
}

export interface TemplateMapping {
  /** Retained for settings written before multi-template selection. */
  readonly documentType?: '契約書' | '請求書';
  readonly template: BusinessTemplate;
}

export type BusinessValues = Record<string, string | number>;

export interface BusinessMetadataDraft {
  readonly revision: number;
  readonly templateId: string | null;
  readonly values: BusinessValues;
  readonly extractionStatus?: 'UNSELECTED' | 'EXTRACTED' | 'EMPTY' | 'FAILED' | 'MANUAL';
}

export function templateId(template: Pick<BusinessTemplate, 'scope' | 'templateKey'>): string {
  return `${template.scope}/${template.templateKey}`;
}

/** Initial scope is flat scalar fields. Reject unsupported templates before migration. */
export function assertBusinessTemplate(input: unknown): asserts input is BusinessTemplate {
  const template = input as BusinessTemplate | null;
  const invalid = () => {
    throw new ShuttleError(
      'METADATA_SCHEMA',
      'テンプレートは文字列・数値・日付・単一選択の項目で構成してください。',
    );
  };
  if (
    !template ||
    !/^enterprise(?:_\d+)?$/.test(template.scope) ||
    !/^[A-Za-z][A-Za-z0-9_-]*$/.test(template.templateKey) ||
    !template.displayName ||
    !Array.isArray(template.fields) ||
    template.fields.length === 0 ||
    template.fields.length > 50
  )
    invalid();
  const keys = new Set<string>();
  for (const field of template!.fields) {
    if (
      !/^[A-Za-z][A-Za-z0-9_-]*$/.test(field.key) ||
      keys.has(field.key) ||
      !field.displayName ||
      !['string', 'float', 'date', 'enum'].includes(field.type) ||
      (field.type === 'enum' &&
        (!field.options?.length || !field.options.every((v) => typeof v === 'string')))
    )
      invalid();
    keys.add(field.key);
  }
}

/** Schema identity is frozen with the job; changed fields require a fresh migration. */
export function sameTemplate(a: BusinessTemplate, b: BusinessTemplate): boolean {
  return templateId(a) === templateId(b) && JSON.stringify(a.fields) === JSON.stringify(b.fields);
}

export function normalizeBusinessValues(
  template: BusinessTemplate,
  input: unknown,
  strict = true,
): BusinessValues {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ShuttleError('APPROVAL_INVALID', 'メタデータの値を確認してください。');
  const fields = input as Record<string, unknown>;
  if (strict && Object.keys(fields).some((key) => !template.fields.some((f) => f.key === key)))
    throw new ShuttleError('APPROVAL_INVALID', 'テンプレートにない項目が含まれています。');
  const values: BusinessValues = {};
  for (const field of template.fields) {
    const raw = fields[field.key];
    if (raw === null || raw === undefined || raw === '') continue;
    let value: string | number | null = null;
    if (field.type === 'float') {
      if (
        (typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')) &&
        Number.isFinite(Number(raw))
      )
        value = Number(raw);
    } else if (typeof raw === 'string') {
      const text = raw.trim();
      if (text === '') continue;
      if (field.type === 'date') {
        const date = text.slice(0, 10);
        if (
          /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(text) &&
          Number.isFinite(Date.parse(date)) &&
          new Date(date).toISOString().slice(0, 10) === date
        )
          value = `${date}T00:00:00Z`;
      } else if (field.type === 'enum') {
        if (field.options?.includes(text)) value = text;
      } else if (text.length <= 2000) value = text;
    }
    if (value === null) {
      if (strict)
        throw new ShuttleError('APPROVAL_INVALID', `${field.displayName}の値を確認してください。`);
      continue;
    }
    Object.defineProperty(values, field.key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return values;
}

function documentKind(value: string | null): string | null {
  let name = value?.normalize('NFKC').trim().toLocaleLowerCase('ja').replace(/\s+/g, '') ?? '';
  // Strip administrative suffixes, not customer/project names or field contents.
  name = name.replace(
    /(?:メタデータ|テンプレート|metadata|management|template|管理|情報|台帳)+$/g,
    '',
  );
  if (
    /^(?:契約書?|業務委託契約書?|秘密保持契約書?|売買契約書?|基本契約書?|contracts?|nda|msa)$/.test(
      name,
    )
  )
    return '契約書';
  if (/^(?:請求書|invoices?)$/.test(name)) return '請求書';
  if (/^(?:その他|不明|unknown|other)$/.test(name)) return null;
  return name || null;
}

/** Clear document/template name matches only; ambiguous matches remain manual. */
export function mappingForDocument(
  mappings: readonly TemplateMapping[],
  documentType: string | null,
): TemplateMapping | undefined {
  const kind = documentKind(documentType);
  if (!kind) return;
  const matches = mappings.filter(
    (mapping) => documentKind(mapping.documentType ?? mapping.template.displayName) === kind,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function metadataDocumentTypes(mappings: readonly TemplateMapping[]): string[] {
  return [
    ...new Set([
      '契約書',
      '請求書',
      ...mappings
        .map((mapping) => documentKind(mapping.documentType ?? mapping.template.displayName))
        .filter((kind): kind is string => !!kind),
      'その他',
    ]),
  ];
}
