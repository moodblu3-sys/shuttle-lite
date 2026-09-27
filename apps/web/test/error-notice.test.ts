// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ERROR_CATEGORIES } from '@shuttle-lite/core';
import { ErrorNotice } from '../src/components/error-notice';
import { errorPresentation } from '../src/lib/error-presentation';

describe('error presentation', () => {
  it.each(ERROR_CATEGORIES)(
    'presents %s in Japanese without promising a retry after failure',
    (category) => {
      const presentation = errorPresentation(category, 'FAILED');
      expect(presentation.title).toMatch(/[ぁ-んァ-ヶ一-龯]/);
      expect(presentation.title).not.toContain(category);
      expect(presentation.action).not.toContain('自動');
      if (category !== 'UNKNOWN') expect(presentation.title).not.toBe(errorPresentation().title);
    },
  );

  it('uses the current processing state for recovery guidance', () => {
    expect(errorPresentation('AI_NOT_READY', 'RETRY_WAIT').action).toContain('自動で再試行');
    expect(errorPresentation('AI_NOT_READY', 'REVIEW_REQUIRED').action).not.toContain('自動');
    expect(errorPresentation('BOX_TIMEOUT', 'UNKNOWN_OUTCOME').action).toContain('照合');
    expect(errorPresentation('future-category')).toEqual(errorPresentation('UNKNOWN'));
    expect(errorPresentation('constructor')).toEqual(errorPresentation('UNKNOWN'));
  });

  it('keeps diagnostic text collapsed, available and escaped', () => {
    const message = 'Box API 412 precondition_failed request_id=test <img src=x onerror=alert(1)>';
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      createElement(ErrorNotice, { category: 'AI_NOT_READY', message, state: 'RETRY_WAIT' }),
    );
    const details = container.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')!.textContent).toBe('技術情報');
    expect(details.textContent).toContain(message);
    expect(container.querySelector('img')).toBeNull();
    details.open = true;
    expect(details.textContent).toContain('request_id=test');
    details.remove();
    expect(container.textContent).toContain('Box AIが処理を受け付けられませんでした');
    expect(container.textContent).not.toContain('412');
    expect(container.textContent).not.toContain('Part');
    expect(container.textContent).not.toContain('AI_NOT_READY');
  });
});
