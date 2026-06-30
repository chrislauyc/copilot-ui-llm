import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import { serverHarness } from './harness/ServerHarness';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('Panic Stop REST API Integration Tests', () => {
  beforeAll(async () => {
    await serverHarness.start();
  });

  afterAll(async () => {
    await serverHarness.stop();
  });

  it('Verifies that calling /api/copilot/panic successfully aborts in-flight stream and sets status flags', { timeout: 60000 }, async () => {
    console.log('Starting panic_stop integration test...');
    
    const { serverPort, proxy, proxyUrl } = serverHarness;
    assert.ok(proxy);

    const snapshotPath = path.resolve(process.cwd(), 'src/test/snapshots/gate_loop/panic_stop.yaml');
    
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'panic-'));
    fs.writeFileSync(path.join(tempCwd, '.git'), 'gitdir: /fake/path');
    
    fs.writeFileSync(path.join(tempCwd, 'package.json'), JSON.stringify({
      name: 'mock-panic-workspace',
      scripts: {
        lint: 'echo "Lint Passed" && exit 0'
      }
    }, null, 2));

    try {
      await proxy.updateConfig({
        filePath: snapshotPath,
        workDir: tempCwd,
      });
      
      const sessionId = 'test-panic-session-123';
      console.log(`Sending start request to /api/copilot/gate-run with sessionId: ${sessionId}`);

      // Trigger active stream run
      const runRes = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: 'Help me build a server.',
          model: 'claude-sonnet-4.5',
          cwd: tempCwd,
          sessionId,
          gates: ['runLint'],
          maxRetries: 1
        })
      });

      const reader = runRes.body?.getReader();
      let receivedData = '';
      let panicTriggered = false;

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunkStr = Buffer.from(value).toString('utf-8');
          receivedData += chunkStr;

          // Trigger panic stop when we receive our first few bytes of response stream
          if (!panicTriggered && receivedData.length > 0) {
            panicTriggered = true;
            console.log('Received first SSE stream feedback. Triggering Panic Stop...');
            
            // Slight delay to ensure activeSession registry transitions successfully
            await new Promise(r => setTimeout(r, 200));

            console.log(`Sending Panic Stop request for sessionId: ${sessionId}`);
            const panicRes = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/panic`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ sessionId })
            });

            const panicData = await panicRes.json();
            console.log('Panic POST response:', panicData);
            assert.strictEqual(panicRes.status, 200, 'Panic endpoint should return 200 OK');
            assert.strictEqual(panicData.success, true, 'Panic response should signal success: true');
          }
        }
      }

      console.log('Streamed run data on abort output:', receivedData);

      // Fetch session history status and assert stateSnapshot properties have manualIntervention=true
      const hystRes = await fetch(`http://127.0.0.1:${serverPort}/api/session/${sessionId}`);
      const hystData = await hystRes.json();
      console.log('Session metadata snapshot:', hystData.stateSnapshot);

      assert.ok(hystData.stateSnapshot, 'State snapshot exists');
      assert.strictEqual(hystData.stateSnapshot.manualIntervention, true, 'manualIntervention state should be set to true');
      assert.strictEqual(hystData.stateSnapshot.isRunning, false, 'isRunning state should be toggled to false');

      console.log('✓ Panic Stop API integration test verified successfully!');
    } finally {
      // Clean up temporary workspace
      if (fs.existsSync(tempCwd)) {
        fs.rmSync(tempCwd, { recursive: true, force: true });
      }
    }
  });
});
