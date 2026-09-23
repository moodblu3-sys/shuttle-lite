import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { BusinessMetadataFields } from '../src/components/business-metadata-fields';
import { demoBusinessTemplates } from '../../../packages/box/src/fake/business-templates';

it('renders template fields using their Japanese names and correct input types', () => {
  const html = renderToStaticMarkup(
    createElement(BusinessMetadataFields, {
      template: demoBusinessTemplates[1]!,
      values: { vendor: '青葉商事', amount: 1500, dueDate: '2026-09-30T00:00:00Z' },
      onChange: vi.fn(),
    }),
  );
  expect(html).toContain('請求元');
  expect(html).toContain('青葉商事');
  expect(html).toContain('type="number"');
  expect(html).toContain('type="date"');
  expect(html).toContain('value="2026-09-30"');
  expect(html).not.toContain('Migration');
  expect(html).not.toContain('routingReason');
});

it('renders an enum as the template’s choices', () => {
  const html = renderToStaticMarkup(
    createElement(BusinessMetadataFields, {
      template: {
        ...demoBusinessTemplates[0]!,
        fields: [
          { key: 'kind', displayName: '契約種別', type: 'enum', options: ['業務委託', '秘密保持'] },
        ],
      },
      values: { kind: '秘密保持' },
      onChange: vi.fn(),
    }),
  );
  expect(html).toContain('<select');
  expect(html).toContain('value="秘密保持" selected=""');
});
