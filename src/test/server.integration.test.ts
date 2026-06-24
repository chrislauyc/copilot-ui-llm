import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import { serverHarness } from './harness/ServerHarness';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('Server End-to-End Integration Tests', () => {
  beforeAll(async () => {
    await serverHarness.start();
  });

  afterAll(async () => {
    await serverHarness.stop();
  });

  it('E2E loop run with SSE streaming results', { timeout: 60000 }, async () => {
    console.log('Starting Integration Test for server.ts...');
    
    const { serverPort, proxy } = serverHarness;
    assert.ok(proxy);

    // Create unique sessionId and tempCwd
    const sessionId = 'session-' + Math.random().toString(36).substring(2, 8);
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'git-worktree-'));
    
    try {
      // 2. Load the Snapshot
      const snapshotPath = path.resolve(process.cwd(), 'src/test/snapshots/gate_loop/single_retry_server_integration.yaml');
      
      // We need to write the snapshot first for this specific scenario
      fs.writeFileSync(snapshotPath, `models:
  - claude-sonnet-4.5
conversations:
  - messages:
      - role: system
        content: \${system}
      - role: user
        content: Run the gate check.
      - role: assistant
        tool_calls:
          - id: toolcall_0
            type: function
            function:
              name: run_tests
              arguments: '{"target":"tests","flags":[]}'
  - messages:
      - role: system
        content: \${system}
      - role: user
        content: Run the gate check.
      - role: assistant
        tool_calls:
          - id: toolcall_0
            type: function
            function:
              name: run_tests
              arguments: '{"target":"tests","flags":[]}'
      - role: tool
        tool_call_id: toolcall_0
        content: |-
          FAIL: 2 tests failed
          gate: failed
      - role: assistant
        content: The gate failed. 2 tests need fixing.
`);

      // Set up a mock git worktree so server.ts validation passes
      fs.writeFileSync(path.join(tempCwd, '.git'), 'gitdir: /fake/path');

      await proxy.updateConfig({
        filePath: snapshotPath,
        workDir: tempCwd,
      });
      
      // 4. Send request to /api/copilot/gate-run
      console.log('Sending request to /api/copilot/gate-run');

      const res = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: 'Run the gate check.',
          model: 'claude-sonnet-4.5',
          cwd: tempCwd,
          gates: ['tests'],
          maxRetries: 1,
          sessionId: sessionId
        })
      });

      const stream = res.body;
      let finalData = '';
      
      if (stream) {
        for await (const chunk of stream as any) {
          finalData += Buffer.from(chunk as ArrayBuffer).toString('utf-8');
          // Look for the assistant's final response
          if (finalData.includes('The gate failed. 2 tests need fixing.')) {
             console.log('Found expected response in SSE stream!');
             break; 
          }
        }
      }
      
      if (!finalData.includes('The gate failed. 2 tests need fixing.')) {
        throw new Error('Did not find expected response. Final Data: ' + finalData);
      }
    } finally {
      try {
        fs.rmSync(tempCwd, { recursive: true, force: true });
      } catch (e) {}
    }
  });
});
