import { describe, it, beforeAll, afterAll, expect, beforeEach } from 'vitest';
import { serverHarness } from './harness/ServerHarness';

describe('Escalation Status Transitions', () => {
  beforeAll(async () => {
    await serverHarness.start();
  });

  afterAll(async () => {
    await serverHarness.stop();
  });

  beforeEach(() => {
    if (serverHarness.serverModule) {
      serverHarness.serverModule.db.prepare('DELETE FROM sessions').run();
      serverHarness.serverModule.db.prepare('DELETE FROM escalations').run();
      serverHarness.serverModule.activeSessions.clear();
    }
  });

  it('should transition escalation from pending to resumed on gate-resume', { timeout: 30000 }, async () => {
    const { serverPort, proxy, serverModule } = serverHarness;
    const activeSessions = serverModule.activeSessions;
    const db = serverModule.db;
    const appendEscalation = serverModule.appendEscalation;
    const getPendingEscalation = serverModule.getPendingEscalation;
    const getEscalations = serverModule.getEscalations;


    const sessionId = 'test-esc-session-1';
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-'));
    const snapPath = path.join(tempDir, 'snap.yaml');
    fs.writeFileSync(snapPath, `conversations:\n  - messages:\n      - role: assistant\n        content: "I am ready!"\n  - messages:\n      - role: assistant\n        content: "I am resumed again!"`);
    await proxy!.updateConfig({ filePath: snapPath, workDir: tempDir });

    const createRes = await fetch(`http://localhost:${serverPort}/api/copilot/gate-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'start', sessionId }),
    });
    
    expect(createRes.status).toBe(200);

    if (createRes.body) {
      const reader = createRes.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    const activeSessionRecord = activeSessions.get(sessionId);
    expect(activeSessionRecord).toBeDefined();

    // Append pending escalation manually
    appendEscalation({
      sessionId,
      summary: 'Needs approval',
      failedGate: undefined,
      failedGateFeedback: undefined,
      retryHistory: [],
      stateSnapshot: { isRunning: false, awaitingHuman: true },
      conversationHistory: [],
      turns: [],
      cwd: '/tmp',
      currentModel: 'gemini-3.1-flash-lite'
    });

    const pendingBefore = getPendingEscalation(sessionId);
    expect(pendingBefore).toBeDefined();
    expect(pendingBefore?.status).toBe('pending');

    const response = await fetch(`http://localhost:${serverPort}/api/copilot/gate-resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'go ahead', sessionId }),
    });
    
    expect(response.status).toBe(200);

    // Drain stream
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    const pendingAfter = getPendingEscalation(sessionId);
    expect(pendingAfter).toBeUndefined(); // No longer pending

    const all = getEscalations();
    const theEscalation = all.find((e: any) => e.sessionId === sessionId);
    expect(theEscalation).toBeDefined();
    expect(theEscalation?.status).toBe('resumed');
  });
});

