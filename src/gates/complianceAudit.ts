import { getAuditorExecutionConfig, executeAuditSession } from '../utils/auditorHelper';
import { submitComplianceAuditTool } from '../config/tools';
import { getGitSandbox, getExecCommand, getWorkspaceRoot } from '../workspace';
import { getPbi, savePbi } from '../db/pbiStore';
import { getTasksForPbi, saveTask, getSpec, TaskRecord } from '../db/taskStore';
import crypto from 'crypto';

export interface ComplianceFinding {
  readonly title: string;
  readonly description: string;
}

export interface ComplianceAuditResult {
  readonly pbiId: string;
  readonly pass: boolean;
  readonly findings: readonly ComplianceFinding[];
  /** taskIds of the remediation tasks created for this audit's findings, if any. */
  readonly remediationTaskIds: readonly string[];
}

interface ComplianceAuditToolResult {
  pass: boolean;
  findings: ComplianceFinding[];
}

const SUBMIT_COMPLIANCE_AUDIT_EXAMPLE = `{
  "pass": false,
  "findings": [
    { "title": "Missing input validation on login endpoint", "description": "The spec requires request-body validation before touching the session store; the current diff calls into sessionStore.create directly with unvalidated input." }
  ]
}`;

const SYSTEM_PROMPT = `You are a strict PBI Compliance Auditor. Unlike the per-task Spec-Gate Auditor, you evaluate the *entire accumulated diff* of a Product Backlog Item (all of its tasks combined) against the subset of the specification relevant to that PBI. Your job is to catch drift or incomplete implementations that individual task-level gates would miss because no single task's diff shows the full picture.

You must not answer conversationally and must strictly invoke 'submit_compliance_audit'.

**How to call the tool:**
Call 'submit_compliance_audit' using your tool-calling capability (a real function/tool call), not as text in your message. Example of correctly-shaped arguments:

${SUBMIT_COMPLIANCE_AUDIT_EXAMPLE}`;

function buildUserPrompt(pbiTitle: string, pbiDescription: string, specContent: string, diff: string): string {
  return `Audit the following PBI's accumulated diff against trunk for compliance with the spec.

PBI TITLE: ${pbiTitle}
PBI DESCRIPTION: ${pbiDescription}

RELEVANT SPEC:
${specContent}

ACCUMULATED DIFF (pbi branch vs trunk):
${diff}`;
}

/**
 * Runs the PBI-level compliance-audit operation (RM-REQ-010): distinct from
 * per-task gates, evaluates the `pbi/<pbiId>` branch's accumulated diff
 * against trunk, checked against the spec.
 *
 * On findings (RM-REQ-013): creates new tasks within the same PBI via this
 * structured tool-call result directly -- NOT by writing prose into
 * architecture-spec.md for decomposeSpecIntoTasks' regex-based parser to
 * reparse -- and marks the PBI as not-yet-satisfied (status reverted to
 * 'in_progress').
 *
 * On a clean pass: marks the PBI 'done'. Per RM-REQ-017 (Issue 83 decision),
 * this does NOT merge pbi/<pbiId> into trunk -- that remains a human PR.
 */
export async function runComplianceAudit(
  cwd: string,
  pbiId: string,
  abortSignal?: AbortSignal
): Promise<ComplianceAuditResult> {
  const pbi = getPbi(pbiId);
  if (!pbi) {
    throw new Error(`No PBI found for pbiId "${pbiId}".`);
  }

  const sandbox = getGitSandbox();
  let diff = '';
  try {
    diff = await sandbox.getPbiDiffAsync(pbiId);
  } catch (e: unknown) {
    const errObj = e as Record<string, unknown> | null;
    diff = errObj && 'stdout' in errObj ? String(errObj.stdout) : '';
  }

  if (!diff.trim()) {
    // Nothing accumulated on the PBI branch yet -- nothing to audit.
    // Deliberately does not mark the PBI done: an empty diff is not the
    // same claim as "the diff satisfies the spec".
    return { pbiId, pass: true, findings: [], remediationTaskIds: [] };
  }

  // Spec scoping: the roadmap calls for auditing against "the subset of the
  // spec relevant to that PBI" (RM-REQ-010). There is no separate per-PBI
  // spec-slicing mechanism yet, so the full spec is passed together with the
  // PBI's own title/description as scoping context for the model. Slicing
  // the spec itself is a reasonable follow-up but out of scope here.
  let specContent = '';
  const specRecord = getSpec(pbi.specId);
  if (specRecord) {
    try {
      const execResult = await getExecCommand()(
        `cd '${getWorkspaceRoot()}' && cat '${specRecord.filePath}'`,
        abortSignal
      );
      if (execResult.exitCode === 0) {
        specContent = execResult.stdout;
      }
    } catch (e) {
      // Fall through with an empty spec; the audit prompt below still runs,
      // giving the model the diff and PBI context even without spec text.
    }
  }

  const executionConfig = getAuditorExecutionConfig();
  const userPrompt = buildUserPrompt(pbi.title, pbi.description ?? '', specContent, diff);

  const result = await executeAuditSession<ComplianceAuditToolResult>(
    cwd,
    executionConfig,
    SYSTEM_PROMPT,
    submitComplianceAuditTool,
    userPrompt,
    { toolCallExample: SUBMIT_COMPLIANCE_AUDIT_EXAMPLE },
    abortSignal
  );

  if (!result || typeof result.pass !== 'boolean' || !Array.isArray(result.findings)) {
    throw new Error(
      `Compliance audit for pbiId "${pbiId}" failed: model did not return a proper submit_compliance_audit tool call.`
    );
  }

  if (result.pass && result.findings.length === 0) {
    savePbi({ ...pbi, status: 'done', updatedAt: Date.now() });
    return { pbiId, pass: true, findings: [], remediationTaskIds: [] };
  }

  // RM-REQ-013: findings create new tasks via this structured tool-call
  // result directly, not by writing prose for the regex-based decomposer.
  const existingTasks = getTasksForPbi(pbiId);
  const specVersion = specRecord?.version ?? 'unknown';
  const remediationTaskIds: string[] = [];
  const now = Date.now();

  for (const finding of result.findings) {
    const taskId = `${pbiId}-remediation-${crypto.randomBytes(4).toString('hex')}`;
    const task: TaskRecord = {
      taskId,
      specId: pbi.specId,
      specVersion,
      title: finding.title,
      description: finding.description,
      status: 'pending',
      touches: null,
      dependsOn: null,
      branchName: null,
      blockedReason: null,
      createdAt: now,
      updatedAt: now,
      pbiId,
    };
    saveTask(task);
    remediationTaskIds.push(taskId);
  }

  // RM-REQ-013: mark the PBI's completion state as not-yet-satisfied.
  savePbi({ ...pbi, status: 'in_progress', updatedAt: now });

  return {
    pbiId,
    pass: false,
    findings: result.findings,
    remediationTaskIds,
  };
}

/**
 * Env-configurable periodic drift-check interval (RM-REQ-012): if set to a
 * positive integer N, a standing compliance audit is triggered every N tasks
 * that reach `done` within a PBI, independent of and prior to the
 * end-of-PBI trigger in RM-REQ-011. Unset or <= 0 disables periodic
 * triggering (only the end-of-PBI trigger applies).
 */
export function getPeriodicAuditIntervalTasks(): number {
  const raw = process.env.PBI_COMPLIANCE_AUDIT_PERIODIC_N;
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Decides whether a compliance audit should fire for `pbiId` right now,
 * given the current state of its tasks (RM-REQ-011/012). Called after a
 * task successfully merges into pbi/<pbiId>.
 *
 * Precedence: if all tasks are done, the end-of-PBI trigger (RM-REQ-011)
 * always fires, regardless of the periodic interval -- there is no reason
 * to defer a full-completion audit because a periodic checkpoint hasn't
 * been reached yet. Otherwise, the periodic trigger (RM-REQ-012) fires
 * when the done-count is a positive multiple of the configured interval.
 */
export function shouldTriggerComplianceAudit(
  pbiId: string
): { trigger: boolean; reason: 'end-of-pbi' | 'periodic' | null } {
  const tasks = getTasksForPbi(pbiId);
  if (tasks.length === 0) {
    return { trigger: false, reason: null };
  }
  const doneCount = tasks.filter((t) => t.status === 'done').length;
  const allDone = doneCount === tasks.length;
  if (allDone) {
    return { trigger: true, reason: 'end-of-pbi' };
  }
  const interval = getPeriodicAuditIntervalTasks();
  if (interval > 0 && doneCount > 0 && doneCount % interval === 0) {
    return { trigger: true, reason: 'periodic' };
  }
  return { trigger: false, reason: null };
}
