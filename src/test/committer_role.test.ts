import { describe, it, beforeAll, expect, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { initializeWorkspace, getGitSandbox, getWorkspaceRoot } from '../workspace';
import { db } from '../db/index';
import { saveTask, saveSpec } from '../db/taskStore';

describe('Committer Role and Conventional Commits', () => {
  beforeAll(async () => {
    await initializeWorkspace();
  });

  it('should call committer LLM model and commit with generated message', async () => {
    const sandbox = getGitSandbox();
    const taskId = 'test-committer-task-123';

    // Register spec to satisfy Foreign Key constraint
    saveSpec({
      specId: 'spec-test-committer',
      filePath: 'architecture-spec.md',
      version: 'v1',
      createdAt: Date.now()
    });

    saveTask({
      taskId,
      specId: 'spec-test-committer',
      specVersion: 'v1',
      title: 'Fix auth crash',
      description: 'Resolve NPE in session verification middleware',
      status: 'pending',
      touches: null,
      dependsOn: null,
      branchName: null,
      blockedReason: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // 1. Checkout the task branch
    await sandbox.checkoutTaskBranch(taskId);

    // 2. Create some changes
    const testFile = path.join(getWorkspaceRoot(), 'src-auth-fix.txt');
    fs.writeFileSync(testFile, 'fix(auth): prevent crash when session header is missing', 'utf8');

    // 3. Create mock registry and client
    const mockExecutionConfig = {
      model: 'gemini-3.1-flash-lite',
      providerType: 'gemini',
      provider: {}
    };

    const mockRegistry = {
      getExecutionConfig: vi.fn().mockReturnValue(mockExecutionConfig)
    };

    let sessionOnCallback: ((event: any) => void) | null = null;

    const mockSession = {
      on: vi.fn().mockImplementation((eventHandler) => {
        sessionOnCallback = eventHandler;
        return () => {};
      }),
      sendAndWait: vi.fn().mockImplementation(async (options) => {
        // Simulate LLM response
        if (sessionOnCallback) {
          sessionOnCallback({
            type: 'assistant.message',
            data: { content: 'fix: prevent NPE on missing session header' }
          });
        }
      }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };

    const mockClient = {
      createSession: vi.fn().mockResolvedValue(mockSession)
    };

    // 4. Park the task branch with mocks passed in
    await sandbox.parkTaskBranch(taskId, mockClient, mockRegistry);

    // 5. Assertions
    expect(mockRegistry.getExecutionConfig).toHaveBeenCalledWith('committer');
    expect(mockClient.createSession).toHaveBeenCalledWith({
      model: 'gemini-3.1-flash-lite',
      provider: 'gemini',
      autoApproveAll: true
    });
    expect(mockSession.sendAndWait).toHaveBeenCalled();
    expect(mockSession.disconnect).toHaveBeenCalled();

    // Check git log of the parked branch to ensure the generated commit message was applied
    await sandbox.resumeTaskBranch(taskId);
    const logOutput = await (sandbox as any).git(['log', '-1', '--pretty=%B']);
    expect(logOutput.trim()).toBe('fix: prevent NPE on missing session header');

    // Cleanup
    await sandbox.parkTaskBranch(taskId);
    db.prepare('DELETE FROM tasks WHERE taskId = ?').run(taskId);
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  });
});
