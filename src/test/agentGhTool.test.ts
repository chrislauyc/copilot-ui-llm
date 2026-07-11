import { describe, it } from 'vitest';
import assert from 'node:assert';
import {
  isAllowedGhCommand,
  isBranchNameAssociatedWithIssue,
  extractTargetId,
} from '../../scripts/tools/agentGhTool';

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
      assert.strictEqual(isAllowedGhCommand(null as any), false);
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
});
