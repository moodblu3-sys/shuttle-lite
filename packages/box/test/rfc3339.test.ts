import { describe, expect, it } from 'vitest';
import { toBoxRfc3339 } from '@shuttle-lite/box';

describe('Box upload attributes の日時書式', () => {
  it('ミリ秒を落とし、offsetを明示した形にする', () => {
    // 実Boxはミリ秒付きの値を「not a valid rfc 3339 formatted date」で400にする。
    expect(toBoxRfc3339('2026-09-13T15:24:30.063Z')).toBe('2026-09-13T15:24:30+00:00');
    expect(toBoxRfc3339('2026-09-13T15:24:30Z')).toBe('2026-09-13T15:24:30+00:00');
  });

  it('offset付きの入力をUTCへ正規化する', () => {
    expect(toBoxRfc3339('2026-04-01T09:00:00+09:00')).toBe('2026-04-01T00:00:00+00:00');
  });

  it('解釈できない値は分類されたerrorにする', () => {
    expect(() => toBoxRfc3339('来年の春')).toThrowError(/日時として解釈できません/);
  });
});
