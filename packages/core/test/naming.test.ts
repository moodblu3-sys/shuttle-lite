import { describe, expect, it } from 'vitest';
import {
  checkBoxFileName,
  migrationItemId,
  parseStagingFileName,
  sanitizeFileName,
  stagingFileName,
} from '@shuttle-lite/core';

describe('naming and identity', () => {
  it('derives the same item ID for the same path in the same job', () => {
    const a = migrationItemId('job_1', 'legal/contracts/msa.pdf');
    const b = migrationItemId('job_1', 'legal/contracts/msa.pdf');
    const other = migrationItemId('job_1', 'legal/contracts/nda.pdf');
    const otherJob = migrationItemId('job_2', 'legal/contracts/msa.pdf');
    expect(a).toBe(b);
    expect(a).not.toBe(other);
    expect(a).not.toBe(otherJob);
    expect(a).toMatch(/^it_[0-9a-f]{24}$/);
  });

  it('round-trips a deterministic staging name for reconciliation', () => {
    const itemId = migrationItemId('job_1', 'finance/invoice 2026-04.pdf');
    const staging = stagingFileName(itemId, 'invoice 2026-04.pdf');
    expect(staging).toBe(`${itemId}__invoice 2026-04.pdf`);
    expect(parseStagingFileName(staging)).toEqual({
      itemId,
      originalName: 'invoice 2026-04.pdf',
    });
  });

  it('ignores names that do not carry an item ID', () => {
    expect(parseStagingFileName('invoice__2026.pdf')).toBeNull();
    expect(parseStagingFileName('plain.pdf')).toBeNull();
  });

  it('keeps the staging name inside the Box byte limit', () => {
    const itemId = migrationItemId('job_1', 'deep/name.pdf');
    const staging = stagingFileName(itemId, `${'あ'.repeat(300)}.pdf`);
    expect(Buffer.byteLength(staging, 'utf8')).toBeLessThanOrEqual(255);
    expect(staging.endsWith('.pdf')).toBe(true);
    expect(parseStagingFileName(staging)?.itemId).toBe(itemId);
  });

  it('replaces characters Box rejects', () => {
    expect(sanitizeFileName('a/b:c*d?.pdf')).toBe('a_b_c_d_.pdf');
    expect(sanitizeFileName('   ')).toBe('unnamed');
    expect(sanitizeFileName('trailing...')).toBe('trailing');
  });

  it('classifies unusable names instead of guessing a rename', () => {
    expect(checkBoxFileName('ok name.pdf').valid).toBe(true);
    expect(checkBoxFileName('bad/name.pdf').valid).toBe(false);
    expect(checkBoxFileName('..').valid).toBe(false);
    expect(checkBoxFileName(' leading.pdf').valid).toBe(false);
    expect(checkBoxFileName('trailing.').valid).toBe(false);
  });
});
