import type { BusinessTemplate } from '@shuttle-lite/core';

/** Synthetic templates for fake Box only. Real enterprises supply their own definitions. */
export const demoBusinessTemplates: readonly BusinessTemplate[] = [
  {
    scope: 'enterprise_123',
    templateKey: 'shuttleLiteContract',
    displayName: '契約書管理',
    fields: [
      { key: 'counterparty', displayName: '契約先', type: 'string' },
      { key: 'contractType', displayName: '契約種別', type: 'string' },
      { key: 'signedDate', displayName: '締結日', type: 'date' },
      { key: 'expirationDate', displayName: '契約終了日', type: 'date' },
    ],
  },
  {
    scope: 'enterprise_123',
    templateKey: 'shuttleLiteInvoice',
    displayName: '請求書管理',
    fields: [
      { key: 'vendor', displayName: '請求元', type: 'string' },
      { key: 'invoiceNumber', displayName: '請求番号', type: 'string' },
      { key: 'invoiceDate', displayName: '請求日', type: 'date' },
      { key: 'amount', displayName: '金額', type: 'float' },
      { key: 'currency', displayName: '通貨', type: 'string' },
      { key: 'dueDate', displayName: '支払期限', type: 'date' },
    ],
  },
];
