import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import { serverHarness } from './harness/ServerHarness';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('Human Escalation Missing Input Tests', () => {
  beforeAll(async () => {
    await serverHarness.start();
  });

  afterAll(async () => {
    await serverHarness.stop();
  });

  it('handles gate-resume request gracefully when the input field is missing', { timeout: 60000 }, async () => {
    const { serverPort, proxy } = serverHarness;
    assert.ok(proxy);

    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'human-escalation-'));
    fs.writeFileSync(path.join(tempCwd, '.git'), 'gitdir: /fake/path');
    
    // Setup escalation: force fail runLint
    await proxy.setOverrides({ taskType: 'feature' });
    const snapshotPath = path.resolve(tempCwd, 'missing_input_test.yaml');
    fs.writeFileSync(snapshotPath, `conversations:
  - messages: # Initial Executor Attempt (fails)
      - role: assistant
        tool_calls: [{ id: "c1", type: "function", function: { name: "run_terminal_docker", arguments: "{\\"command\\":\\"ls\\"}" } }]
  - messages: # After resume (success)
      - role: assistant
        content: Proceeding based on default resume pathway without custom feedback.
`);
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tempCwd });

    // Make lint fail initially
    fs.writeFileSync(path.join(tempCwd, 'package.json'), JSON.stringify({
      name: 'mock-human-escalation-workspace',
      scripts: { lint: 'exit 1' }
    }, null, 2));

    try {
      const sessionId = 'test-human-escalation-session-' + Math.random().toString(36).substring(2, 8);

      // 1. Establish an initial session and reach the human escalation state
      const runRes = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Please check this project.',
          model: 'gemini-3.1-flash-lite',
          cwd: tempCwd,
          sessionId,
          gates: ['runLint'],
          maxRetries: 0
        })
      });

      const reader = runRes.body?.getReader();
      let escalated = false;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const data = Buffer.from(value).toString('utf-8');
          if (data.includes('loop.escalate_human')) {
            escalated = true;
          }
        }
      }
      assert.ok(escalated, 'Should have reached human escalation state');

      // 2. Call gate-resume route simulating human resumption but deliberately omitting the "input" field
      const resumeRes = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Please check this project.',
          model: 'gemini-3.1-flash-lite',
          cwd: tempCwd,
          sessionId,
          gates: ['runLint'],
          maxRetries: 0
          // Omit input field to test graceful fallback
        })
      });

      assert.strictEqual(resumeRes.status, 200, 'Resume response should return 200 and not crash on missing input field');
      
      const reader2 = resumeRes.body?.getReader();
      let streamedData = '';
      if (reader2) {
        while (true) {
          const { done, value } = await reader2.read();
          if (done) break;
          streamedData += Buffer.from(value).toString('utf-8');
        }
      }

      assert.ok(streamedData.includes('Proceeding based on default resume pathway'), 'Should fallback gracefully and proceed with default resume text');
    } finally {
      if (fs.existsSync(tempCwd)) {
        fs.rmSync(tempCwd, { recursive: true, force: true });
      }
    }
  });
});
