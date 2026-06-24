import { describe, it } from 'vitest';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { runTests, runWithTimeout } from '../gates';
import { cleanupWorkspaceDir } from '../utils/workspace';

describe('runTests Gate Unit Tests', () => {
  it('runTests returns success true for a workspace with a passing test script', async () => {
    const tempDir = path.resolve(process.cwd(), 'tmp-test-passing-workspace');
    if (fs.existsSync(tempDir)) {
      cleanupWorkspaceDir(tempDir);
    }
    fs.mkdirSync(tempDir, { recursive: true });

    // Write a package.json with a passing test script
    const pkgJson = {
      name: 'temp-passing-pkg',
      scripts: {
        test: 'echo "All tests passed successfully!" && exit 0'
      }
    };
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

    try {
      const res = await runTests(tempDir);
      assert.strictEqual(res.success, true);
      assert.match(res.output, /All tests passed successfully!/);
    } finally {
      if (fs.existsSync(tempDir)) {
        cleanupWorkspaceDir(tempDir);
      }
    }
  });

  it('runTests returns success false for a workspace with a failing test script', async () => {
    const tempDir = path.resolve(process.cwd(), 'tmp-test-failing-workspace');
    if (fs.existsSync(tempDir)) {
      cleanupWorkspaceDir(tempDir);
    }
    fs.mkdirSync(tempDir, { recursive: true });

    // Write a package.json with a failing test script
    const pkgJson = {
      name: 'temp-failing-pkg',
      scripts: {
        test: 'echo "FAIL: 1 test failed" && exit 1'
      }
    };
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

    try {
      const res = await runTests(tempDir);
      assert.strictEqual(res.success, false);
      assert.match(res.output, /FAIL: 1 test failed/);
    } finally {
      if (fs.existsSync(tempDir)) {
        cleanupWorkspaceDir(tempDir);
      }
    }
  });

  it('runWithTimeout does NOT trigger mock failure for git-worktree substring when process.env.VITEST is not true', async () => {
    const savedVitest = process.env.VITEST;
    try {
      process.env.VITEST = 'false';
      const result = await runWithTimeout('echo "success"', 5000, 'my-git-worktree-project');
      // Since directory does not exist, it should return 'Directory ... does not exist.'
      assert.strictEqual(result.stdout, '');
      assert.match(result.stderr, /Directory my-git-worktree-project does not exist/);
    } finally {
      process.env.VITEST = savedVitest;
    }
  });
});
