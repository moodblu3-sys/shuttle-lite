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
  readonly documentType: '契約書' | '請求書';
  readonly template: BusinessTemplate;
}

export type BusinessValues = Record<string, string | number>;

export interface BusinessMetadataDraft {
  readonly revision: number;
  readonly templateId: string | null;
  readonly values: BusinessValues;
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

/** Auto-selection is limited to known document labels, never a guessed default. */
export function mappingForDocument(
  mappings: readonly TemplateMapping[],
  documentType: string | null,
): TemplateMapping | undefined {
  const kind = documentType?.trim();
  const normalized =
    kind && /^(契約書|業務委託契約書|秘密保持契約書|Contract|NDA|MSA)$/i.test(kind)
      ? '契約書'
      : kind && /^(請求書|invoice)$/i.test(kind)
        ? '請求書'
        : null;
  return mappings.find((mapping) => mapping.documentType === normalized);
}
