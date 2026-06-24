import { describe, it, beforeAll, afterAll, expect, beforeEach } from 'vitest';
import { serverHarness } from './harness/ServerHarness';
import * as http from 'http';

describe('Concurrent Requests & SDK Lock Handling', () => {
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

  it('should return 409 Conflict if a second request tries to run while one is active', { timeout: 30000 }, async () => {
    const { serverPort, proxy, serverModule } = serverHarness;
    const activeSessions = serverModule.activeSessions;
    const db = serverModule.db;


    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'concur-'));
    const snapPath = path.join(tempDir, 'snap.yaml');
    fs.writeFileSync(snapPath, `conversations:\n  - messages:\n      - role: assistant\n        content: "I am taking my time"`);
    await proxy!.updateConfig({ filePath: snapPath, workDir: tempDir });

    const sessionId = 'test-concur-session-1';

    const postData = JSON.stringify({ prompt: 'Please write a long story', sessionId });
    const options = {
      hostname: 'localhost',
      port: serverPort,
      path: '/api/copilot/gate-run',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    let req1: http.ClientRequest;
    const req1Promise = new Promise<void>((resolve) => {
      req1 = http.request(options, (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      });
      req1.write(postData);
      req1.end();
    });

    // Wait until activeSessions has the item
    for (let i = 0; i < 40; i++) {
      if (activeSessions.has(sessionId)) {
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    expect(activeSessions.has(sessionId)).toBeTruthy();

    // Fire a second request for the same session
    const req2 = await fetch(`http://localhost:${serverPort}/api/copilot/gate-resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'continue', sessionId }),
    });

    // Should be rejected with 409
    expect(req2.status).toBe(409);
    
    const req2Body = await req2.json();
    expect(req2Body.error).toContain('is currently busy');

    // Clean up
    req1!.destroy();
  });
});
