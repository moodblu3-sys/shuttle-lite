import { describe, expect, it } from 'vitest';
import {
  mappingForDocument,
  metadataDocumentTypes,
  type TemplateMapping,
} from '@shuttle-lite/core';

function selected(displayName: string, templateKey = displayName): TemplateMapping {
  return { template: { displayName, templateKey, scope: 'enterprise_123', fields: [] } };
}

describe('enabled metadata template selection', () => {
  it.each(['契約書', '業務委託契約書', '秘密保持契約書', 'NDA', 'Contract'])(
    'automatically selects the sole contract template for %s',
    (kind) => {
      const contract = selected('契約書管理');
      expect(mappingForDocument([contract, selected('請求書管理')], kind)).toBe(contract);
    },
  );
  it('matches other clear document/template names without limiting settings to two types', () => {
    const minutes = selected('議事録管理');
    expect(
      mappingForDocument([minutes, selected('契約書管理'), selected('請求書管理')], '議事録'),
    ).toBe(minutes);
    expect(metadataDocumentTypes([minutes])).toContain('議事録');
  });
  it('does not guess between two matching templates or select a template for an unknown document', () => {
    expect(
      mappingForDocument([selected('契約書管理', 'one'), selected('契約書情報', 'two')], '契約書'),
    ).toBeUndefined();
    expect(mappingForDocument([selected('請求書管理')], '契約書')).toBeUndefined();
    expect(mappingForDocument([selected('その他管理')], 'その他')).toBeUndefined();
    expect(mappingForDocument([selected('A社契約書')], '契約書')).toBeUndefined();
    expect(mappingForDocument([selected('契約書管理')], null)).toBeUndefined();
  });
  it('keeps old explicitly configured document mappings valid', () => {
    const legacy = { ...selected('取引管理'), documentType: '契約書' as const };
    expect(mappingForDocument([legacy], '契約書')).toBe(legacy);
  });
});
