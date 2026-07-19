import { describe, it, beforeEach, expect, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { db } from '../db/index';
import { saveSpec, saveTask, getTask, getTasksForPbi } from '../db/taskStore';
import { savePbi, getPbi } from '../db/pbiStore';
import { getGitSandbox, getWorkspaceRoot, initializeWorkspace } from '../workspace';

vi.mock('../utils/auditorHelper', async () => {
  const actual = await vi.importActual<typeof import('../utils/auditorHelper')>('../utils/auditorHelper');
  return {
    ...actual,
    getAuditorExecutionConfig: () => ({ model: 'mock-model', provider: undefined }),
    executeAuditSession: vi.fn(),
  };
});

import { executeAuditSession } from '../utils/auditorHelper';
import {
  runComplianceAudit,
  shouldTriggerComplianceAudit,
  getPeriodicAuditIntervalTasks,
} from '../gates/complianceAudit';

const mockedExecuteAuditSession = executeAuditSession as unknown as ReturnType<typeof vi.fn>;

describe('Compliance-audit operation (Issue 82 / RM-REQ-010/011/012/013)', () => {
  const specId = 'spec-compliance-test';

  beforeEach(async () => {
    await initializeWorkspace();
    db.prepare('DELETE FROM tasks').run();
    db.prepare('DELETE FROM pbis').run();
    db.prepare('DELETE FROM specs').run();
    mockedExecuteAuditSession.mockReset();
    delete process.env.PBI_COMPLIANCE_AUDIT_PERIODIC_N;

    saveSpec({ specId, filePath: 'architecture-spec.md', version: 'v1', createdAt: Date.now() });
  });

  function registerPbi(pbiId: string) {
    savePbi({
      pbiId,
      specId,
      title: `PBI ${pbiId}`,
      description: 'Test PBI for compliance audit',
      status: 'in_progress',
      dependsOn: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  it('throws when the pbiId does not exist', async () => {
    await expect(runComplianceAudit(getWorkspaceRoot(), 'pbi-does-not-exist')).rejects.toThrow(/No PBI found/);
    expect(mockedExecuteAuditSession).not.toHaveBeenCalled();
  });

  it('short-circuits with pass=true and no model call when pbi/<pbiId> has no diff against trunk', async () => {
    const pbiId = 'pbi-empty-diff';
    registerPbi(pbiId);
    await getGitSandbox().ensurePbiBranch(pbiId);

    const result = await runComplianceAudit(getWorkspaceRoot(), pbiId);

    expect(result.pass).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(mockedExecuteAuditSession).not.toHaveBeenCalled();

    // Empty diff is not the same claim as "satisfies the spec" -- must not
    // mark the PBI done off an empty diff.
    expect(getPbi(pbiId)?.status).toBe('in_progress');
  });

  it('marks the PBI done on a clean audit (no findings)', async () => {
    const pbiId = 'pbi-clean-pass';
    const taskId = 'task-clean-pass';
    registerPbi(pbiId);
    saveTask({
      taskId, specId, specVersion: 'v1', title: 'Do work', description: null,
      status: 'done', touches: null, dependsOn: null, branchName: `task/${taskId}`,
      blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
    });

    const sandbox = getGitSandbox();
    await sandbox.checkoutTaskBranch(taskId, pbiId);
    fs.writeFileSync(path.join(getWorkspaceRoot(), 'clean-pass-output.txt'), 'work', 'utf8');
    await sandbox.commitAllChangesAsync('Do work');
    await sandbox.mergeTaskIntoPbi(taskId, pbiId);

    mockedExecuteAuditSession.mockResolvedValue({ pass: true, findings: [] });

    const result = await runComplianceAudit(getWorkspaceRoot(), pbiId);

    expect(result.pass).toBe(true);
    expect(result.remediationTaskIds).toHaveLength(0);
    expect(getPbi(pbiId)?.status).toBe('done');

    // Confirms the forced-tool-call discipline, mirroring the Auditor/Reviewer/
    // PBI-derivation pattern.
    const [, , , tool] = mockedExecuteAuditSession.mock.calls[0] as unknown[];
    expect((tool as { function: { name: string } }).function.name).toBe('submit_compliance_audit');
  });

  it('creates remediation tasks via structured result and marks the PBI not-yet-satisfied on findings', async () => {
    const pbiId = 'pbi-with-findings';
    const taskId = 'task-with-findings';
    registerPbi(pbiId);
    saveTask({
      taskId, specId, specVersion: 'v1', title: 'Do work', description: null,
      status: 'done', touches: null, dependsOn: null, branchName: `task/${taskId}`,
      blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
    });

    const sandbox = getGitSandbox();
    await sandbox.checkoutTaskBranch(taskId, pbiId);
    fs.writeFileSync(path.join(getWorkspaceRoot(), 'with-findings-output.txt'), 'incomplete work', 'utf8');
    await sandbox.commitAllChangesAsync('Do incomplete work');
    await sandbox.mergeTaskIntoPbi(taskId, pbiId);

    mockedExecuteAuditSession.mockResolvedValue({
      pass: false,
      findings: [
        { title: 'Missing error handling', description: 'The spec requires a try/catch around the write.' },
        { title: 'Missing test coverage', description: 'No test exercises the failure path.' },
      ],
    });

    const result = await runComplianceAudit(getWorkspaceRoot(), pbiId);

    expect(result.pass).toBe(false);
    expect(result.remediationTaskIds).toHaveLength(2);

    // RM-REQ-013: tasks created programmatically from the structured result,
    // not by writing prose into architecture-spec.md.
    const remediationTasks = getTasksForPbi(pbiId).filter((t) => t.taskId !== taskId);
    expect(remediationTasks).toHaveLength(2);
    expect(remediationTasks.map((t) => t.title).sort()).toEqual(
      ['Missing error handling', 'Missing test coverage'].sort()
    );
    expect(remediationTasks.every((t) => t.status === 'pending')).toBe(true);
    expect(remediationTasks.every((t) => t.pbiId === pbiId)).toBe(true);

    // RM-REQ-013: PBI's completion state marked not-yet-satisfied.
    expect(getPbi(pbiId)?.status).toBe('in_progress');
  });

  it('throws when the model never returns a valid submit_compliance_audit tool call', async () => {
    const pbiId = 'pbi-bad-tool-call';
    const taskId = 'task-bad-tool-call';
    registerPbi(pbiId);
    saveTask({
      taskId, specId, specVersion: 'v1', title: 'Do work', description: null,
      status: 'done', touches: null, dependsOn: null, branchName: `task/${taskId}`,
      blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
    });
    const sandbox = getGitSandbox();
    await sandbox.checkoutTaskBranch(taskId, pbiId);
    fs.writeFileSync(path.join(getWorkspaceRoot(), 'bad-tool-call-output.txt'), 'work', 'utf8');
    await sandbox.commitAllChangesAsync('Do work');
    await sandbox.mergeTaskIntoPbi(taskId, pbiId);

    mockedExecuteAuditSession.mockResolvedValue(null);

    await expect(runComplianceAudit(getWorkspaceRoot(), pbiId)).rejects.toThrow(
      /did not return a proper submit_compliance_audit/
    );
  });

  describe('shouldTriggerComplianceAudit (RM-REQ-011/012)', () => {
    it('triggers end-of-pbi when all tasks are done, taking precedence over periodic', () => {
      process.env.PBI_COMPLIANCE_AUDIT_PERIODIC_N = '2';
      const pbiId = 'pbi-trigger-all-done';
      registerPbi(pbiId);
      for (let i = 0; i < 2; i++) {
        saveTask({
          taskId: `${pbiId}-t${i}`, specId, specVersion: 'v1', title: `t${i}`, description: null,
          status: 'done', touches: null, dependsOn: null, branchName: null,
          blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
        });
      }
      const decision = shouldTriggerComplianceAudit(pbiId);
      expect(decision).toEqual({ trigger: true, reason: 'end-of-pbi' });
    });

    it('triggers periodic when configured and done-count hits the interval, with tasks still pending', () => {
      process.env.PBI_COMPLIANCE_AUDIT_PERIODIC_N = '2';
      const pbiId = 'pbi-trigger-periodic';
      registerPbi(pbiId);
      saveTask({
        taskId: `${pbiId}-t0`, specId, specVersion: 'v1', title: 't0', description: null,
        status: 'done', touches: null, dependsOn: null, branchName: null,
        blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
      });
      saveTask({
        taskId: `${pbiId}-t1`, specId, specVersion: 'v1', title: 't1', description: null,
        status: 'done', touches: null, dependsOn: null, branchName: null,
        blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
      });
      saveTask({
        taskId: `${pbiId}-t2`, specId, specVersion: 'v1', title: 't2', description: null,
        status: 'pending', touches: null, dependsOn: null, branchName: null,
        blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
      });
      const decision = shouldTriggerComplianceAudit(pbiId);
      expect(decision).toEqual({ trigger: true, reason: 'periodic' });
    });

    it('does not trigger when neither condition is met', () => {
      process.env.PBI_COMPLIANCE_AUDIT_PERIODIC_N = '5';
      const pbiId = 'pbi-no-trigger';
      registerPbi(pbiId);
      saveTask({
        taskId: `${pbiId}-t0`, specId, specVersion: 'v1', title: 't0', description: null,
        status: 'done', touches: null, dependsOn: null, branchName: null,
        blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
      });
      saveTask({
        taskId: `${pbiId}-t1`, specId, specVersion: 'v1', title: 't1', description: null,
        status: 'pending', touches: null, dependsOn: null, branchName: null,
        blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
      });
      expect(shouldTriggerComplianceAudit(pbiId)).toEqual({ trigger: false, reason: null });
    });

    it('does not periodic-trigger when the interval env var is unset (disabled by default)', () => {
      const pbiId = 'pbi-periodic-disabled';
      registerPbi(pbiId);
      saveTask({
        taskId: `${pbiId}-t0`, specId, specVersion: 'v1', title: 't0', description: null,
        status: 'done', touches: null, dependsOn: null, branchName: null,
        blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
      });
      saveTask({
        taskId: `${pbiId}-t1`, specId, specVersion: 'v1', title: 't1', description: null,
        status: 'pending', touches: null, dependsOn: null, branchName: null,
        blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
      });
      expect(getPeriodicAuditIntervalTasks()).toBe(0);
      expect(shouldTriggerComplianceAudit(pbiId)).toEqual({ trigger: false, reason: null });
    });
  });
});
