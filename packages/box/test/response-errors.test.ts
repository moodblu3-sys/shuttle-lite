import { describe, expect, it } from 'vitest';
import { mapResponseError } from '@shuttle-lite/box';

const body = JSON.stringify({
  code: 'precondition_failed',
  message: 'The resource has been modified. Please retrieve the resource again and retry',
  request_id: 'test-request',
});

describe('412 responses by operation', () => {
  it.each([
    ['POST', 'https://api.box.com/2.0/ai/extract_structured', 'AI_NOT_READY'],
    ['POST', 'https://box.invalid/2.0/ai/extract_structured?test=true', 'AI_NOT_READY'],
    ['PUT', 'https://upload.box.com/api/2.0/files/upload_sessions/session', 'UPLOAD_PART_MISMATCH'],
    ['GET', 'https://upload.box.com/api/2.0/files/upload_sessions/session', 'BOX_PRECONDITION'],
    [
      'POST',
      'https://upload.box.com/api/2.0/files/upload_sessions/session/commit',
      'BOX_PRECONDITION',
    ],
    ['PUT', 'https://api.box.com/2.0/files/file', 'BOX_PRECONDITION'],
    ['DELETE', 'https://api.box.com/2.0/files/file', 'BOX_PRECONDITION'],
    ['POST', 'https://api.box.com/2.0/ai/extract_structured/other', 'BOX_PRECONDITION'],
    ['POST', 'not-a-url', 'BOX_PRECONDITION'],
  ])('maps %s %s to %s', (method, url, category) => {
    const error = mapResponseError(412, {}, body, { method, url });
    expect(error).toMatchObject({ category, status: 412, requestId: 'test-request' });
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('precondition_failed');
    if (category !== 'UPLOAD_PART_MISMATCH') expect(error.operatorAction).not.toContain('Part');
    if (category === 'AI_NOT_READY') expect(error.retryAfterMs).toBe(5000);
  });

  it('does not guess an operation when request context is missing', () => {
    expect(mapResponseError(412, {}, body).category).toBe('BOX_PRECONDITION');
  });

  it.each(['12', '0'])('honours Retry-After %s for AI extraction', (retryAfter) => {
    const error = mapResponseError(412, { 'retry-after': retryAfter }, body, {
      method: 'POST',
      url: 'https://api.box.com/2.0/ai/extract_structured',
    });
    expect(error.retryAfterMs).toBe(Number(retryAfter) * 1000);
  });
});
