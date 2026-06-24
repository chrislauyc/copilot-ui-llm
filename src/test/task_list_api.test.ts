import { describe, it, beforeAll, afterAll, expect, beforeEach } from 'vitest';
import { serverHarness } from './harness/ServerHarness';
import { db } from '../db/index';

describe('Task List API', () => {
  beforeAll(async () => {
    await serverHarness.start();
  });

  afterAll(async () => {
    await serverHarness.stop();
  });

  beforeEach(() => {
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM escalations').run();
  });

  it('should return empty escalations and sessions', async () => {
    const { serverPort } = serverHarness;
    const escRes = await fetch(`http://localhost:${serverPort}/api/escalations`);
    expect(escRes.status).toBe(200);
    const escBody = await escRes.json();
    expect(escBody.escalations).toEqual([]);

    const sessRes = await fetch(`http://localhost:${serverPort}/api/sessions`);
    expect(sessRes.status).toBe(200);
    const sessBody = await sessRes.json();
    expect(sessBody.sessions).toEqual([]);
  });

  it('should return escalations correctly serialized', async () => {
    const { serverPort } = serverHarness;

    db.prepare(`
      INSERT INTO escalations (
        id, sessionId, escalatedAt, summary, failedGate, failedGateFeedback,
        retryHistory, status, stateSnapshot, conversationHistory, turns, cwd, currentModel
      ) VALUES (
        'esc-123', 'sess-123', 123456789, 'Need help', 'manual_approval', 'please approve',
        '[]', 'pending', '{"isRunning":false}', '[{"role":"user","content":"help"}]', '[]', '/tmp', 'gemini'
      )
    `).run();

    const escRes = await fetch(`http://localhost:${serverPort}/api/escalations`);
    expect(escRes.status).toBe(200);
    const escBody = await escRes.json();
    expect(escBody.escalations).toHaveLength(1);
    expect(escBody.escalations[0].id).toBe('esc-123');
    expect(escBody.escalations[0].failedGate).toBe('manual_approval');
    expect(escBody.escalations[0].status).toBe('pending');
    expect(escBody.escalations[0].conversationHistory).toHaveLength(1);
  });
});
