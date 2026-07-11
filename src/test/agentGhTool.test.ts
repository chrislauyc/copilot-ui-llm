import { describe, it, vi, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
  isAllowedGhCommand,
  isBranchNameAssociatedWithIssue,
  extractTargetId,
  extractTargetIdFromArgs,
  isPrLinkedToIssue,
  createRunGhCommandTool,
  cachedPrNumbersByIssue,
  cachedPrLinkedStatus,
  type RunGhCommandResult,
} from '../../scripts/tools/agentGhTool';

vi.mock('node:child_process', () => {
  return {
    execFileSync: vi.fn(),
  };
});

type HandlerContext = Parameters<NonNullable<ReturnType<typeof createRunGhCommandTool>['handler']>>[1];
const mockContext = {} as unknown as HandlerContext;

describe('GitHub CLI Agent Tool (agentGhTool) Verification Tests', () => {
  describe('isAllowedGhCommand', () => {
    it('should permit allowed subcommands', () => {
      assert.strictEqual(isAllowedGhCommand(['issue', 'view', '42']), true);
      assert.strictEqual(isAllowedGhCommand(['issue', 'comment', '42', '--body', 'Test']), true);
      assert.strictEqual(isAllowedGhCommand(['pr', 'view', '101']), true);
      assert.strictEqual(isAllowedGhCommand(['pr', 'diff', '101']), true);
      assert.strictEqual(isAllowedGhCommand(['pr', 'comment', '101', '--body', 'Fix']), true);
      assert.strictEqual(isAllowedGhCommand(['label', 'list']), true);
    });

    it('should reject disallowed subcommands', () => {
      assert.strictEqual(isAllowedGhCommand(['issue', 'delete', '42']), false);
      assert.strictEqual(isAllowedGhCommand(['repo', 'delete', 'my-repo']), false);
      assert.strictEqual(isAllowedGhCommand(['api', 'graphql']), false);
      assert.strictEqual(isAllowedGhCommand(['ssh-key', 'add']), false);
    });

    it('should handle malformed or short inputs gracefully', () => {
      assert.strictEqual(isAllowedGhCommand([]), false);
      assert.strictEqual(isAllowedGhCommand(['issue']), false);
      assert.strictEqual(isAllowedGhCommand(null as unknown as string[]), false);
    });
  });

  describe('isBranchNameAssociatedWithIssue', () => {
    it('should correctly match associated branches for issue #5', () => {
      const issueNum = '5';
      assert.strictEqual(isBranchNameAssociatedWithIssue('issue/5', issueNum), true);
      assert.strictEqual(isBranchNameAssociatedWithIssue('issue-5', issueNum), true);
      assert.strictEqual(isBranchNameAssociatedWithIssue('issue/5-fix', issueNum), true);
      assert.strictEqual(isBranchNameAssociatedWithIssue('fix/issue-5-bug', issueNum), true);
      assert.strictEqual(isBranchNameAssociatedWithIssue('issue-5-something', issueNum), true);
      assert.strictEqual(isBranchNameAssociatedWithIssue('issue/5/something', issueNum), true);
    });

    it('should reject unrelated branches for issue #5 (preventing over-broad substring matching)', () => {
      const issueNum = '5';
      assert.strictEqual(isBranchNameAssociatedWithIssue('bug/50-fix', issueNum), false);
      assert.strictEqual(isBranchNameAssociatedWithIssue('feature-555', issueNum), false);
      assert.strictEqual(isBranchNameAssociatedWithIssue('issue/55', issueNum), false);
      assert.strictEqual(isBranchNameAssociatedWithIssue('issue-55', issueNum), false);
      assert.strictEqual(isBranchNameAssociatedWithIssue('some5text', issueNum), false);
    });

    it('should correctly match for multi-digit issue #50', () => {
      const issueNum = '50';
      assert.strictEqual(isBranchNameAssociatedWithIssue('issue/50', issueNum), true);
      assert.strictEqual(isBranchNameAssociatedWithIssue('issue-50', issueNum), true);
      assert.strictEqual(isBranchNameAssociatedWithIssue('issue/50-fix', issueNum), true);
      assert.strictEqual(isBranchNameAssociatedWithIssue('issue/5', issueNum), false);
      assert.strictEqual(isBranchNameAssociatedWithIssue('issue-5', issueNum), false);
    });

    it('should handle regex metacharacters in triggeringIssueNumber safely', () => {
      assert.strictEqual(isBranchNameAssociatedWithIssue('issue/5', '5*'), false);
      assert.strictEqual(isBranchNameAssociatedWithIssue('issue/5', '5.'), false);
    });
  });

  describe('extractTargetId', () => {
    it('should extract correct issue/PR ID from args', () => {
      assert.strictEqual(extractTargetId('42'), '42');
      assert.strictEqual(extractTargetId('https://github.com/owner/repo/issues/42'), '42');
      assert.strictEqual(extractTargetId('https://github.com/owner/repo/pull/101'), '101');
    });

    it('should return null or arg fallback appropriately', () => {
      assert.strictEqual(extractTargetId(undefined), null);
      assert.strictEqual(extractTargetId(''), null);
    });
  });

  describe('extractTargetIdFromArgs', () => {
    it('should extract target ID while skipping options and flags', () => {
      assert.strictEqual(extractTargetIdFromArgs(['pr', 'view', '--json', 'title,number', '101']), '101');
      assert.strictEqual(extractTargetIdFromArgs(['pr', 'view', '101', '--json', 'title']), '101');
      assert.strictEqual(extractTargetIdFromArgs(['issue', 'comment', '--body', 'test comment', '42']), '42');
      assert.strictEqual(extractTargetIdFromArgs(['issue', 'comment', '42', '--body', 'test comment']), '42');
    });

    it('should return null if no valid target ID is found', () => {
      assert.strictEqual(extractTargetIdFromArgs(['pr', 'list']), null);
      assert.strictEqual(extractTargetIdFromArgs(['issue', 'view', '--json', 'title']), null);
    });
  });

  describe('isPrLinkedToIssue', () => {
    beforeEach(() => {
      for (const key in cachedPrLinkedStatus) {
        delete cachedPrLinkedStatus[key];
      }
      vi.clearAllMocks();
    });

    it('should return true when git remote and gh api match', () => {
      vi.mocked(execFileSync).mockImplementation((cmd, args) => {
        if (cmd === 'git') {
          return 'https://github.com/owner/repo.git\n';
        }
        if (cmd === 'gh' && args?.[0] === 'api') {
          return JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  closingIssuesReferences: {
                    nodes: [{ number: 42 }]
                  }
                }
              }
            }
          });
        }
        return '';
      });

      const result = isPrLinkedToIssue('101', '42');
      assert.strictEqual(result, true);
    });

    it('should cache results to prevent redundant calls', () => {
      let callCount = 0;
      vi.mocked(execFileSync).mockImplementation((cmd, args) => {
        if (cmd === 'git') {
          return 'https://github.com/owner/repo.git\n';
        }
        if (cmd === 'gh' && args?.[0] === 'api') {
          callCount++;
          return JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  closingIssuesReferences: {
                    nodes: [{ number: 42 }]
                  }
                }
              }
            }
          });
        }
        return '';
      });

      const first = isPrLinkedToIssue('101', '42');
      const second = isPrLinkedToIssue('101', '42');
      assert.strictEqual(first, true);
      assert.strictEqual(second, true);
      assert.strictEqual(callCount, 1); // Second call should be cached
    });

    it('should return false if git remote fails', () => {
      vi.mocked(execFileSync).mockImplementation((cmd) => {
        if (cmd === 'git') {
          throw new Error('git fail');
        }
        return '';
      });

      const result = isPrLinkedToIssue('101', '42');
      assert.strictEqual(result, false);
    });

    it('should return false if gh api fails', () => {
      vi.mocked(execFileSync).mockImplementation((cmd) => {
        if (cmd === 'git') {
          return 'https://github.com/owner/repo.git\n';
        }
        if (cmd === 'gh') {
          throw new Error('gh fail');
        }
        return '';
      });

      const result = isPrLinkedToIssue('101', '42');
      assert.strictEqual(result, false);
    });
  });

  describe('createRunGhCommandTool handler checks', () => {
    let originalIssueNumber: string | undefined;

    beforeEach(() => {
      originalIssueNumber = process.env.ISSUE_NUMBER;
      process.env.ISSUE_NUMBER = '42';
      // Clear the PR cache
      for (const key in cachedPrNumbersByIssue) {
        delete cachedPrNumbersByIssue[key];
      }
      for (const key in cachedPrLinkedStatus) {
        delete cachedPrLinkedStatus[key];
      }
      vi.clearAllMocks();
    });

    afterEach(() => {
      process.env.ISSUE_NUMBER = originalIssueNumber;
    });

    it('should enforce success and attempt budgets', async () => {
      const tool = createRunGhCommandTool();
      vi.mocked(execFileSync).mockReturnValue('mock success output');

      // Call 10 times successfully
      for (let i = 0; i < 10; i++) {
        const res = await tool.handler!({ args: ['issue', 'view', '42'] }, mockContext) as RunGhCommandResult;
        assert.strictEqual(res.output, 'mock success output');
        assert.strictEqual(res.error, undefined);
      }

      // 11th call should be rejected on success budget
      const res = await tool.handler!({ args: ['issue', 'view', '42'] }, mockContext) as RunGhCommandResult;
      assert.strictEqual(res.output, undefined);
      assert.match(res.error || '', /maximum tool call success budget of 10 exceeded/);
    });

    it('should enforce attempt budget even for rejected calls', async () => {
      const tool = createRunGhCommandTool();
      vi.mocked(execFileSync).mockReturnValue('mock success');

      // Make 20 failed/rejected attempts (e.g. disallowed subcommand)
      for (let i = 0; i < 20; i++) {
        const res = await tool.handler!({ args: ['issue', 'delete', '42'] }, mockContext) as RunGhCommandResult;
        assert.strictEqual(res.output, undefined);
        assert.match(res.error || '', /not on the allowlist/);
      }

      // 21st attempt should be rejected due to overall attempts budget
      const res = await tool.handler!({ args: ['issue', 'view', '42'] }, mockContext) as RunGhCommandResult;
      assert.strictEqual(res.output, undefined);
      assert.match(res.error || '', /maximum tool call attempt budget of 20 exceeded/);
    });

    it('should reject malformed or too short arguments', async () => {
      const tool = createRunGhCommandTool();
      const res = await tool.handler!({ args: ['issue'] }, mockContext) as RunGhCommandResult;
      assert.strictEqual(res.output, undefined);
      assert.match(res.error || '', /must include at least a resource and an action/);
    });

    it('should reject disallowed subcommands', async () => {
      const tool = createRunGhCommandTool();
      const res = await tool.handler!({ args: ['issue', 'delete', '42'] }, mockContext) as RunGhCommandResult;
      assert.strictEqual(res.output, undefined);
      assert.match(res.error || '', /not on the allowlist/);
    });

    it('should reject commands containing --repo or -R flags', async () => {
      const tool = createRunGhCommandTool();
      const res1 = await tool.handler!({ args: ['issue', 'view', '42', '--repo', 'other/repo'] }, mockContext) as RunGhCommandResult;
      assert.strictEqual(res1.output, undefined);
      assert.match(res1.error || '', /cross-repo access is forbidden/);

      const res2 = await tool.handler!({ args: ['issue', 'view', '42', '-R', 'other/repo'] }, mockContext) as RunGhCommandResult;
      assert.strictEqual(res2.output, undefined);
      assert.match(res2.error || '', /cross-repo access is forbidden/);

      const res3 = await tool.handler!({ args: ['issue', 'view', '42', '--repo=other/repo'] }, mockContext) as RunGhCommandResult;
      assert.strictEqual(res3.output, undefined);
      assert.match(res3.error || '', /cross-repo access is forbidden/);
    });

    it('should reject commands containing --body-file or -F flags', async () => {
      const tool = createRunGhCommandTool();
      const res1 = await tool.handler!({ args: ['issue', 'comment', '42', '--body-file', 'path/to/file'] }, mockContext) as RunGhCommandResult;
      assert.strictEqual(res1.output, undefined);
      assert.match(res1.error || '', /reading from files via --body-file\/-F is forbidden/);

      const res2 = await tool.handler!({ args: ['issue', 'comment', '42', '-F', 'path/to/file'] }, mockContext) as RunGhCommandResult;
      assert.strictEqual(res2.output, undefined);
      assert.match(res2.error || '', /reading from files via --body-file\/-F is forbidden/);

      const res3 = await tool.handler!({ args: ['issue', 'comment', '42', '--body-file=path/to/file'] }, mockContext) as RunGhCommandResult;
      assert.strictEqual(res3.output, undefined);
      assert.match(res3.error || '', /reading from files via --body-file\/-F is forbidden/);
    });

    it('should reject comments exceeding maximum length', async () => {
      const tool = createRunGhCommandTool();
      const longComment = 'a'.repeat(10001);
      const res = await tool.handler!({ args: ['issue', 'comment', '42', '--body', longComment] }, mockContext) as RunGhCommandResult;
      assert.strictEqual(res.output, undefined);
      assert.match(res.error || '', /comment body is too long/);
    });

    it('should reject comments containing HTML script/iframe injections', async () => {
      const tool = createRunGhCommandTool();
      const maliciousComment = 'Hello <script>alert(1)</script> world';
      const res = await tool.handler!({ args: ['issue', 'comment', '42', '--body', maliciousComment] }, mockContext) as RunGhCommandResult;
      assert.strictEqual(res.output, undefined);
      assert.match(res.error || '', /contains potential HTML script\/iframe injections/);
    });

    it('should enforce target issue ID matches triggering issue number', async () => {
      const tool = createRunGhCommandTool();
      // Target issue #42 is allowed (matches triggering issue #42)
      vi.mocked(execFileSync).mockReturnValue('mock view success');
      const resAllowed = await tool.handler!({ args: ['issue', 'view', '42'] }, mockContext) as RunGhCommandResult;
      assert.strictEqual(resAllowed.output, 'mock view success');

      // Target issue #43 is rejected
      const resRejected = await tool.handler!({ args: ['issue', 'view', '43'] }, mockContext) as RunGhCommandResult;
      assert.strictEqual(resRejected.output, undefined);
      assert.match(resRejected.error || '', /does not match triggering issue #42/);
    });

    it('should permit PR if associated branch name matches triggering issue', async () => {
      const tool = createRunGhCommandTool();
      // Mock "gh pr list" to return a PR with matching branch
      vi.mocked(execFileSync).mockImplementation((cmd, args) => {
        if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'list') {
          return JSON.stringify([{ number: 101, headRefName: 'issue/42-fix' }]);
        }
        return 'mock pr output';
      });

      const res = await tool.handler!({ args: ['pr', 'view', '101'] }, mockContext) as RunGhCommandResult;
      assert.strictEqual(res.output, 'mock pr output');
    });

    it('should permit PR if linked directly to triggering issue', async () => {
      const tool = createRunGhCommandTool();
      vi.mocked(execFileSync).mockImplementation((cmd, args) => {
        if (cmd === 'git') {
          return 'https://github.com/owner/repo.git\n';
        }
        if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'list') {
          return JSON.stringify([]); // No PRs found via branch name
        }
        if (cmd === 'gh' && args?.[0] === 'api') {
          return JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  closingIssuesReferences: {
                    nodes: [{ number: 42 }]
                  }
                }
              }
            }
          });
        }
        if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'view' && args?.[2] === '101') {
          return 'mock pr view output';
        }
        return '';
      });

      const res = await tool.handler!({ args: ['pr', 'view', '101'] }, mockContext) as RunGhCommandResult;
      assert.strictEqual(res.output, 'mock pr view output');
    });

    it('should reject PR if neither branch name matches nor linked directly', async () => {
      const tool = createRunGhCommandTool();
      vi.mocked(execFileSync).mockImplementation((cmd, args) => {
        if (cmd === 'git') {
          return 'https://github.com/owner/repo.git\n';
        }
        if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'list') {
          return JSON.stringify([]);
        }
        if (cmd === 'gh' && args?.[0] === 'api') {
          return JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  closingIssuesReferences: {
                    nodes: [{ number: 999 }]
                  }
                }
              }
            }
          });
        }
        return '';
      });

      const res = await tool.handler!({ args: ['pr', 'view', '101'] }, mockContext) as RunGhCommandResult;
      assert.strictEqual(res.output, undefined);
      assert.match(res.error || '', /is not linked or associated with triggering issue #42/);
    });
  });
});
