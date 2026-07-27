import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { selectAndAdvanceAuditorRotation } from '../orchestrator/gateLoop';
import { activeSessions, lastRunLog } from '../orchestrator/sessionState';
import { SessionRecord } from '../types/session';

/**
 * Exercises selectAndAdvanceAuditorRotation -- the actual gateLoop.ts wiring
 * used by both the runAudit and runSpecAudit gate call sites -- rather than
 * just the pure building blocks it composes (selectRotatingAuditorConfig,
 * parseAuditorPoolEnv, etc., already covered by auditor_pool_rotation.test.ts).
 *
 * Confirms Issue 79 / RM-REQ-031/032 end-to-end through the real session-state
 * plumbing: the rotation index is actually read from and persisted back into
 * activeSessions' StateSnapshot across successive gate attempts, and both
 * required non-blocking warnings are actually logged (not just computed).
 */
describe('selectAndAdvanceAuditorRotation (gateLoop wiring, Issue 79 / RM-REQ-031/032)', () => {
  const ORIGINAL_ENV = { ...process.env };
  const sessionId = 'wiring-test-session';

  function makeSessionRecord(auditorRotationIndex?: number): SessionRecord {
    return {
      sessionId,
      copilotSession: null,
      currentModel: 'gemini-3.1-flash-lite',
      cwd: '/tmp',
      lastUsedAt: Date.now(),
      stateSnapshot: {
        isRunning: true,
        retryCount: 0,
        currentTier: 'gemini-3.1-flash-lite',
        activeGate: undefined,
        hasFailureState: false,
        awaitingHuman: false,
        ...(auditorRotationIndex !== undefined ? { auditorRotationIndex } : {}),
      },
      conversationHistory: [],
      turns: [],
    };
  }

  beforeEach(() => {
    delete process.env.AUDITOR_POOL;
    delete process.env.AUDITOR_PROVIDER;
    delete process.env.AUDITOR_MODEL;
    process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
    activeSessions.delete(sessionId);
    lastRunLog.length = 0;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    activeSessions.delete(sessionId);
  });

  it('reads the rotation index from session state and persists the advanced index back', () => {
    process.env.AUDITOR_POOL = 'gemini:gemini-3.1-flash-lite,gemini:gemini-3.5-flash';
    activeSessions.set(sessionId, makeSessionRecord(0));

    const first = selectAndAdvanceAuditorRotation(sessionId, undefined, 'test-key');
    expect(first.executionConfig.model).toBe('gemini-3.1-flash-lite');
    expect(activeSessions.get(sessionId)!.stateSnapshot.auditorRotationIndex).toBe(1);

    const second = selectAndAdvanceAuditorRotation(sessionId, undefined, 'test-key');
    expect(second.executionConfig.model).toBe('gemini-3.5-flash');
    expect(activeSessions.get(sessionId)!.stateSnapshot.auditorRotationIndex).toBe(2);

    // Round-robin wraps: a third attempt returns to the first model.
    const third = selectAndAdvanceAuditorRotation(sessionId, undefined, 'test-key');
    expect(third.executionConfig.model).toBe('gemini-3.1-flash-lite');
  });

  it('defaults to rotation index 0 for a session with no prior auditor attempts', () => {
    process.env.AUDITOR_POOL = 'gemini:gemini-3.1-flash-lite,gemini:gemini-3.5-flash';
    activeSessions.set(sessionId, makeSessionRecord(undefined));

    const selection = selectAndAdvanceAuditorRotation(sessionId, undefined, 'test-key');
    expect(selection.executionConfig.model).toBe('gemini-3.1-flash-lite');
    expect(activeSessions.get(sessionId)!.stateSnapshot.auditorRotationIndex).toBe(1);
  });

  it('logs a non-blocking warning when the pool has only one model, without throwing', () => {
    // AUDITOR_POOL unset -> default single-entry pool.
    activeSessions.set(sessionId, makeSessionRecord(0));

    const selection = selectAndAdvanceAuditorRotation(sessionId, undefined, 'test-key');

    expect(selection.singleModelPool).toBe(true);
    expect(lastRunLog.some((line) => line.includes('only a single model configured'))).toBe(true);
  });

  it('logs a non-blocking warning when the selected auditor matches the Implementor model', () => {
    process.env.AUDITOR_POOL = 'gemini:gemini-3.1-flash-lite,gemini:gemini-3.5-flash';
    activeSessions.set(sessionId, makeSessionRecord(0));

    // rotationIndex 0 selects gemini-3.1-flash-lite -- pass that as the
    // Implementor's model for this task to trigger the decorrelation warning.
    const selection = selectAndAdvanceAuditorRotation(sessionId, 'gemini-3.1-flash-lite', 'test-key');

    expect(selection.executionConfig.model).toBe('gemini-3.1-flash-lite');
    expect(
      lastRunLog.some((line) => line.includes('matches the Implementor\'s model'))
    ).toBe(true);
  });

  it('does not log the decorrelation warning when the Implementor model differs', () => {
    process.env.AUDITOR_POOL = 'gemini:gemini-3.1-flash-lite,gemini:gemini-3.5-flash';
    activeSessions.set(sessionId, makeSessionRecord(0));

    selectAndAdvanceAuditorRotation(sessionId, 'gemini-3.1-pro-preview', 'test-key');

    expect(
      lastRunLog.some((line) => line.includes('matches the Implementor\'s model'))
    ).toBe(false);
  });

  it('still returns a selection when no sessionId is available, without persisting anything', () => {
    process.env.AUDITOR_POOL = 'gemini:gemini-3.1-flash-lite,gemini:gemini-3.5-flash';

    const selection = selectAndAdvanceAuditorRotation(undefined, undefined, 'test-key');

    expect(selection.executionConfig.model).toBe('gemini-3.1-flash-lite');
    expect(activeSessions.has(sessionId)).toBe(false);
  });
});
