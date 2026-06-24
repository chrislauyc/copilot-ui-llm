import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import { serverHarness } from './harness/ServerHarness';
import * as path from 'path';
import * as fs from 'fs';
import { cleanupWorkspaceDir } from '../utils/workspace';

describe('Telemetry Schema and History Validation Tests', () => {
  beforeAll(async () => {
    await serverHarness.start();
  });

  afterAll(async () => {
    await serverHarness.stop();
  });

  it('Issues a hard GET request directly to /api/session/:id mid-run and asserts structural telemetry formats', { timeout: 60000 }, async () => {
    console.log('Starting telemetry_schema_validation integration test...');

    const { serverPort, proxy, proxyUrl } = serverHarness;
    assert.ok(proxy);

    const snapshotPath = path.resolve(process.cwd(), 'src/test/snapshots/gate_loop/telemetry_schema_validation.yaml');
    
    const tempCwd = path.join(process.cwd(), 'tmp-telemetry-validation-workspace');
    if (fs.existsSync(tempCwd)) {
      cleanupWorkspaceDir(tempCwd);
    }
    fs.mkdirSync(tempCwd, { recursive: true });
    fs.writeFileSync(path.join(tempCwd, '.git'), 'gitdir: /fake/path');
    
    // Write package.json with working lint script
    fs.writeFileSync(path.join(tempCwd, 'package.json'), JSON.stringify({
      name: 'mock-workspace',
      scripts: {
        lint: 'echo "Success" && exit 0'
      }
    }, null, 2));

    try {
      await proxy.updateConfig({
        filePath: snapshotPath,
        workDir: tempCwd,
      });

      console.log('Dispatching gate-run POST and parsing stream...');
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: 'Perform validation checks.',
          model: 'claude-sonnet-4.5',
          cwd: tempCwd,
          gates: ['runLint'],
          maxRetries: 1
        })
      });

      // Use streaming reader to capture events and intercept mid-run
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fetchedHistory = false;
      let historyResponse: any = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (dataStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(dataStr);
              
              // On first turn start event, trigger hard GET to the telemetry alias mid-run
              if (parsed.type === 'session.start' && !fetchedHistory) {
                fetchedHistory = true;
                const sessionId = parsed.data.sessionId;

                // Small delay to allow the server logic to populate initial trail events
                await new Promise(r => setTimeout(r, 300));

                const aliasUrl = `http://127.0.0.1:${serverPort}/api/session/${sessionId}`;
                console.log(`Polling history directly from /api/session/:id: ${aliasUrl}`);
                
                const hRes = await fetch(aliasUrl);
                assert.ok(hRes.ok, `GET to ${aliasUrl} must return 200 OK status`);
                
                historyResponse = await hRes.json();
                console.log('Retrieved history payload mid-run:', JSON.stringify(historyResponse));
              }
            } catch (_) {}
          }
        }
      }

      // 3. Explicitly assert the existence of structured endpoints & flat audit trail matching client expectation
      assert.ok(fetchedHistory, 'Should have intercepted sessionId and polled the telemetry history');
      assert.ok(historyResponse, 'Polled history response should be loaded');
      assert.ok(Array.isArray(historyResponse.turns), 'Primary history payload must contain "turns" array');
      assert.ok(Array.isArray(historyResponse.auditTrail), 'Primary history payload must contain flat "auditTrail" array');
      assert.ok(Array.isArray(historyResponse.diagTrail), 'Primary history payload must contain "diagTrail" array');
      
      console.log('✓ Telemetry schema validation verified!');
    } finally {
      if (fs.existsSync(tempCwd)) {
        cleanupWorkspaceDir(tempCwd);
      }
    }
  });
});
