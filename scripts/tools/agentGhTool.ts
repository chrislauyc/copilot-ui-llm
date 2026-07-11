import { execFileSync } from 'node:child_process';
import { defineTool } from '../../src/copilotSdk/boundary';
import type { Tool } from '../../src/copilotSdk/boundary';

/**
 * The only `gh` subcommands the issue-task agent is allowed to invoke.
 * Each entry is the `<noun> <verb>` pair (e.g. "issue comment"), matched
 * against the first two positional args the model supplies.
 *
 * Deliberately conservative for Phase 1: no `repo`, no `workflow`, no
 * `release`, nothing that can delete/merge/close destructively, and
 * nothing that shells out further (e.g. `gh api`, `gh ssh`). Expand this
 * list only alongside explicit product review.
 */
export const ALLOWED_GH_COMMANDS: readonly string[] = [
  'issue view',
  'issue comment',
  'pr view',
  'pr diff',
  'pr comment',
  'label list',
];

export const RUN_GH_COMMAND_TOOL_NAME = 'run_gh_command';

export interface RunGhCommandArgs {
  /**
   * Full gh CLI argument vector, WITHOUT the leading "gh" itself, e.g.
   * ["issue", "comment", "42", "--body", "Thanks for the report!"].
   */
  args: string[];
}

export interface RunGhCommandResult {
  output?: string;
  error?: string;
}

function subcommandOf(args: string[]): string {
  return args.slice(0, 2).join(' ');
}

/**
 * True only if the first two positional args exactly match an allowlisted
 * "<noun> <verb>" pair. Deliberately strict (no prefix/substring matching)
 * so e.g. "issue delete" can never sneak in under "issue".
 */
export function isAllowedGhCommand(args: string[]): boolean {
  if (!Array.isArray(args) || args.length < 2) return false;
  return ALLOWED_GH_COMMANDS.includes(subcommandOf(args));
}

function extractTargetId(arg: string | undefined): string | null {
  if (!arg) return null;
  const match = arg.match(/\/(\d+)$/);
  return match ? match[1] : arg;
}

let cachedPrNumbers: string[] | null = null;

function getAllowedPrNumbers(triggeringIssueNumber: string): string[] {
  if (cachedPrNumbers !== null) return cachedPrNumbers;
  try {
    const raw = execFileSync('gh', ['pr', 'list', '--json', 'number,headRefName'], {
      encoding: 'utf-8',
      timeout: 15000,
    });
    const prs = JSON.parse(raw) as Array<{ number: number; headRefName: string }>;
    const allowed = prs
      .filter((pr) => {
        const ref = pr.headRefName || '';
        return (
          ref === `issue/${triggeringIssueNumber}` ||
          ref.startsWith(`issue/${triggeringIssueNumber}-`) ||
          ref === `issue-${triggeringIssueNumber}` ||
          ref.startsWith(`issue-${triggeringIssueNumber}-`) ||
          ref.includes(`/${triggeringIssueNumber}`) ||
          ref.includes(`-${triggeringIssueNumber}`)
        );
      })
      .map((pr) => String(pr.number));
    cachedPrNumbers = allowed;
    return cachedPrNumbers;
  } catch (err) {
    console.warn(`[agentGhTool] Failed to fetch allowed PRs for issue #${triggeringIssueNumber}:`, err);
    return [];
  }
}

/**
 * Builds the `run_gh_command` SDK tool. The handler never throws for a
 * disallowed subcommand -- it returns a rejection as normal tool output so
 * the model can see why it failed and try an allowed alternative instead of
 * the whole session crashing. It only throws (propagates) for genuinely
 * unexpected failures, which the caller's session error handling covers.
 */
export function createRunGhCommandTool(): Tool<RunGhCommandArgs> {
  let callCount = 0;
  const MAX_CALLS = 10;

  return defineTool<RunGhCommandArgs>(
    RUN_GH_COMMAND_TOOL_NAME,
    'Executes a single whitelisted "gh" (GitHub CLI) subcommand and returns its ' +
      'real stdout/stderr. Only the following subcommands are permitted: ' +
      `${ALLOWED_GH_COMMANDS.join(', ')}. Any other subcommand is rejected and ` +
      'reported back as an error instead of being run -- if that happens, pick ' +
      'a different, allowed way to accomplish the goal rather than retrying the ' +
      'same call.',
    {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description:
            'The gh CLI argument vector, excluding the leading "gh", e.g. ' +
            '["issue", "comment", "42", "--body", "text"].',
        },
      },
      required: ['args'],
    },
    async ({ args }): Promise<RunGhCommandResult> => {
      if (callCount >= MAX_CALLS) {
        const message = `Rejected: maximum tool call budget of ${MAX_CALLS} exceeded for this run.`;
        console.warn(`[agentGhTool] ${message}`);
        return { error: message };
      }
      callCount++;

      if (!Array.isArray(args) || args.length < 2) {
        const message = `Rejected: gh command must include at least a resource and an action (got ${JSON.stringify(args)}).`;
        console.warn(`[agentGhTool] ${message}`);
        return { error: message };
      }
      if (!isAllowedGhCommand(args)) {
        const message =
          `Rejected: "gh ${subcommandOf(args)}" is not on the allowlist. ` +
          `Allowed subcommands: ${ALLOWED_GH_COMMANDS.join(', ')}.`;
        console.warn(`[agentGhTool] Rejected disallowed gh subcommand: "${subcommandOf(args)}" (full args: ${JSON.stringify(args)})`);
        return { error: message };
      }
      const hasRepoArg = args.some((arg) =>
        arg === '--repo' || arg.startsWith('--repo=') || arg.startsWith('-R')
      );
      if (hasRepoArg) {
        const message = 'Rejected: cross-repo access is forbidden. Remove --repo/-R flags.';
        console.warn(`[agentGhTool] ${message}`);
        return { error: message };
      }
      const hasBodyFileArg = args.some((arg) =>
        arg === '--body-file' || arg.startsWith('--body-file=') || arg === '-F' || arg.startsWith('-F')
      );
      if (hasBodyFileArg) {
        const message = 'Rejected: reading from files via --body-file/-F is forbidden. Use --body/-b instead.';
        console.warn(`[agentGhTool] ${message}`);
        return { error: message };
      }

      const triggeringIssueNumber = process.env.ISSUE_NUMBER;
      if (triggeringIssueNumber) {
        const targetId = extractTargetId(args[2]);
        const subcommand = subcommandOf(args);

        if (['issue view', 'issue comment'].includes(subcommand)) {
          if (!targetId || targetId !== triggeringIssueNumber) {
            const message = `Rejected: gh command target issue (${args[2] || 'none'}) does not match triggering issue #${triggeringIssueNumber}.`;
            console.warn(`[agentGhTool] ${message}`);
            return { error: message };
          }
        }

        if (['pr view', 'pr diff', 'pr comment'].includes(subcommand)) {
          const allowedPrs = getAllowedPrNumbers(triggeringIssueNumber);
          if (!targetId || !allowedPrs.includes(targetId)) {
            const message = `Rejected: gh command target PR (${args[2] || 'none'}) is not linked or associated with triggering issue #${triggeringIssueNumber} (allowed PRs: ${allowedPrs.join(', ') || 'none'}).`;
            console.warn(`[agentGhTool] ${message}`);
            return { error: message };
          }
        }
      }

      try {
        console.log(`[agentGhTool] Running: gh ${args.join(' ')}`);
        const output = execFileSync('gh', args, {
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          timeout: 60000,
        });
        return { output };
      } catch (err) {
        const errWithStderr = err as { stderr?: Buffer | string; message?: string };
        const stderr = errWithStderr?.stderr;
        const message = (stderr ? stderr.toString() : null) || errWithStderr?.message || String(err);
        console.error(`[agentGhTool] gh command failed: ${message}`);
        return { error: `gh command failed: ${message}` };
      }
    },
  );
}
