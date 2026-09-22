import { describe, expect, it } from 'vitest';
import {
  canTransition,
  isTerminal,
  isWorkable,
  nextPipelineState,
  phaseForState,
  type PipelineState,
  PIPELINE_STATES,
} from '@shuttle-lite/core';

describe('item state model', () => {
  it('walks the documented pipeline in order', () => {
    let state: PipelineState = PIPELINE_STATES[0];
    const walked: string[] = [state];
    for (;;) {
      const next = nextPipelineState(state);
      if (!next) break;
      expect(canTransition(state, next)).toBe(true);
      state = next;
      walked.push(state);
    }
    expect(walked.at(-1)).toBe('COMPLETED');
    expect(walked).toHaveLength(PIPELINE_STATES.length);
  });

  it('refuses to skip verification on the way to COMPLETED', () => {
    expect(canTransition('STAGED', 'COMPLETED')).toBe(false);
    expect(canTransition('TRANSFER_VERIFIED', 'COMPLETED')).toBe(false);
    expect(canTransition('APPROVED', 'COMPLETED')).toBe(false);
    expect(canTransition('FINAL_VERIFY', 'COMPLETED')).toBe(true);
  });

  it('never moves an unapproved item into the move phase', () => {
    expect(canTransition('REVIEW_REQUIRED', 'MOVING')).toBe(false);
    expect(canTransition('AI_COMPLETED', 'MOVING')).toBe(false);
    expect(canTransition('APPROVED', 'MOVING')).toBe(true);
  });

  it('sends a stale approval back for another decision', () => {
    expect(canTransition('APPROVED', 'REVIEW_REQUIRED')).toBe(true);
    expect(canTransition('MOVING', 'REVIEW_REQUIRED')).toBe(true);
  });

  it('lets a side state resume anywhere in the pipeline', () => {
    expect(canTransition('UPLOADING', 'UNKNOWN_OUTCOME')).toBe(true);
    expect(canTransition('UNKNOWN_OUTCOME', 'STAGED')).toBe(true);
    expect(canTransition('RETRY_WAIT', 'UPLOADING')).toBe(true);
    expect(canTransition('PAUSED', 'READY')).toBe(true);
  });

  it('treats only COMPLETED, SKIPPED and FAILED as terminal', () => {
    expect(isTerminal('COMPLETED')).toBe(true);
    expect(isTerminal('SKIPPED')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('REVIEW_REQUIRED')).toBe(false);
  });

  it('does not let the worker pick up items waiting for a human', () => {
    expect(isWorkable('REVIEW_REQUIRED')).toBe(false);
    expect(isWorkable('NEEDS_REVIEW')).toBe(false);
    expect(isWorkable('READY')).toBe(true);
  });

  it('reports the phase of the state a side state will resume from', () => {
    expect(phaseForState('RETRY_WAIT', 'UPLOADING')).toBe('UPLOAD');
    expect(phaseForState('NEEDS_REVIEW', 'AI_PENDING')).toBe('AI_EXTRACTION');
  });
});
