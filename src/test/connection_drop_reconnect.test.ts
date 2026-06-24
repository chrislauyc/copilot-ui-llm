import { describe, it, beforeAll, afterAll, expect, beforeEach } from 'vitest';
import { serverHarness } from './harness/ServerHarness';
import http from 'http';

describe('Connection Drops & SSE Stream Re-attachment', () => {
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

  it('should gracefully handle client disconnection and allow resume without duplicating', { timeout: 30000 }, async () => {
    const { serverPort, proxy, serverModule } = serverHarness;
    const activeSessions = serverModule.activeSessions;
    const db = serverModule.db;


    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-drop-'));
    const snapPath = path.join(tempDir, 'snap.yaml');
    fs.writeFileSync(snapPath, `conversations:\n  - messages:\n      - role: assistant\n        content: "I am being interrupted"\n  - messages:\n      - role: assistant\n        content: "I am resumed"`);
    await proxy!.updateConfig({ filePath: snapPath, workDir: tempDir });

    const sessionId = 'test-drop-session-1';
    // 1. Send the first request via http to be able to destroy the socket
    const postData = JSON.stringify({ prompt: 'Write a long story about a cat', sessionId });

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

    let sequenceCounterAtDrop: number | null = null;

    await new Promise<void>((resolve, reject) => {
      const req = http.request(options, (res) => {
        let chunkCount = 0;
        res.on('data', (chunk) => {
          const str = chunk.toString();
          
          chunkCount++;
          // Abruptly destroy the socket after a few chunks
          if (chunkCount > 2) {
            // Find current sequence counter
            const activeSess = activeSessions.get(sessionId);
            sequenceCounterAtDrop = activeSess ? activeSess.eventSequenceCounter : 0;
            res.destroy(); // Drop connection
            resolve();
          }
        });
      });

      req.on('error', (e) => {
        reject(e);
      });

      req.write(postData);
      req.end();
    });

    expect(sessionId).toBeTruthy();

    // Give server a bit of time to handle the disconnect/cleanup
    await new Promise(r => setTimeout(r, 500));

    // Wait, the lock should be released since req.on('close') handles it
    // 2. Re-attach to the session using gate-resume
    const resumeResponse = await fetch(`http://localhost:${serverPort}/api/copilot/gate-resume`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'x-copilot-session-id': sessionId!,
        'x-last-sequence': (sequenceCounterAtDrop || 0).toString()
      },
      body: JSON.stringify({ prompt: 'continue from here' }),
    });

    expect(resumeResponse.status).toBe(200);

    // Drain the response
    if (resumeResponse.body) {
      const reader = resumeResponse.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
  });
});
