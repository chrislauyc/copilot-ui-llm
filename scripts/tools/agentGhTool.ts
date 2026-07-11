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

/**
 * Determines whether a given Git reference/branch name is associated with the triggering issue.
 * Employs exact boundary matching so that triggering issue #5 is associated with branch
 * 'issue/5-fix', 'issue-5', or 'issue_5', but not 'bug/50-fix', 'feature-555', 'issue/55', or 'some5text'.
 */
export function isBranchNameAssociatedWithIssue(ref: string, triggeringIssueNumber: string): boolean {
  const escaped = triggeringIssueNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[/\\-_])${escaped}($|[/\\-_])`);
  return pattern.test(ref);
}

export function extractTargetId(arg: string | undefined): string | null {
  if (!arg) return null;
  const match = arg.match(/\/(\d+)\/?$/);
  if (match) return match[1];
  if (/^\d+$/.test(arg)) return arg;
  return null;
}

export function extractTargetIdFromArgs(args: string[]): string | null {
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    // Skip flags and flag-like options
    if (arg.startsWith('-')) {
      // If it is a flag that takes an option (like --json, -F, -b, --body) without an equals sign,
      // the next token is its value, so we should skip it as well.
      const optionFlags = ['--json', '-F', '-b', '--body', '--repo', '-R'];
      if (optionFlags.includes(arg) && i + 1 < args.length) {
        i++;
      }
      continue;
    }
    const extracted = extractTargetId(arg);
    if (extracted !== null) {
      return extracted;
    }
  }
  return null;
}

function getRepoOwnerAndName(): { owner: string; name: string } | null {
  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (match) {
      return { owner: match[1], name: match[2] };
    }
  } catch (err) {
    console.warn('[agentGhTool] Failed to get repo owner and name from git remote:', err);
  }
  return null;
}

// Note: cachedPrNumbersByIssue is a module-level mutable cache designed to live
// for a single process invocation in CI. In long-lived or testing environments,
// be sure to clear this cache or guard against stale data.
export const cachedPrNumbersByIssue: Record<string, string[]> = {};

export function getAllowedPrNumbers(triggeringIssueNumber: string): string[] {
  if (cachedPrNumbersByIssue[triggeringIssueNumber] !== undefined) {
    return cachedPrNumbersByIssue[triggeringIssueNumber]!;
  }
  try {
    const raw = execFileSync('gh', ['pr', 'list', '--json', 'number,headRefName'], {
      encoding: 'utf-8',
      timeout: 15000,
    });
    const prs = JSON.parse(raw) as Array<{ number: number; headRefName: string }>;
    const allowed = prs
      .filter((pr) => {
        const ref = pr.headRefName || '';
        return isBranchNameAssociatedWithIssue(ref, triggeringIssueNumber);
      })
      .map((pr) => String(pr.number));
    cachedPrNumbersByIssue[triggeringIssueNumber] = allowed;
    return allowed;
  } catch (err) {
    console.warn(`[agentGhTool] Failed to fetch allowed PRs for issue #${triggeringIssueNumber}:`, err);
    return [];
  }
}

// Note: cachedPrLinkedStatus is a module-level mutable cache designed to live
// for a single process invocation in CI. In long-lived or testing environments,
// be sure to clear this cache or guard against stale data.
export const cachedPrLinkedStatus: Record<string, boolean> = {};

/**
 * Directly queries the GitHub CLI to verify if a target PR is formally linked to the triggering issue.
 */
export function isPrLinkedToIssue(targetPrId: string, triggeringIssueNumber: string): boolean {
  const cacheKey = `${targetPrId}:${triggeringIssueNumber}`;
  if (cacheKey in cachedPrLinkedStatus) {
    return cachedPrLinkedStatus[cacheKey];
  }
  try {
    const repoInfo = getRepoOwnerAndName();
    if (!repoInfo) {
      console.warn('[agentGhTool] Could not determine repository owner/name for direct link validation.');
      return false;
    }
    const { owner, name } = repoInfo;

    const query = `
      query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            closingIssuesReferences(first: 10) {
              nodes {
                number
              }
            }
          }
        }
      }
    `;

    const raw = execFileSync('gh', [
      'api',
      'graphql',
      '-F', `owner=${owner}`,
      '-F', `name=${name}`,
      '-F', `number=${targetPrId}`,
      '-f', `query=${query}`
    ], {
      encoding: 'utf-8',
      timeout: 15000,
    });

    const parsed = JSON.parse(raw) as {
      data?: {
        repository?: {
          pullRequest?: {
            closingIssuesReferences?: {
              nodes?: Array<{ number: number }>;
            };
          };
        };
      };
    };

    const nodes = parsed.data?.repository?.pullRequest?.closingIssuesReferences?.nodes || [];
    const issueNumbers = nodes.map((n) => String(n.number));
    const result = issueNumbers.includes(triggeringIssueNumber);
    cachedPrLinkedStatus[cacheKey] = result;
    return result;
  } catch (err) {
    console.warn(`[agentGhTool] Failed to verify linked issues for PR #${targetPrId} via gh api:`, err);
    return false;
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
  let attemptCount = 0;
  const MAX_CALLS = 10;
  const MAX_ATTEMPTS = 20;

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
      // 1. Budget checks
      if (attemptCount >= MAX_ATTEMPTS) {
        const message = `Rejected: maximum tool call attempt budget of ${MAX_ATTEMPTS} exceeded for this run.`;
        console.warn(`[agentGhTool] ${message}`);
        return { error: message };
      }
      attemptCount++;

      if (callCount >= MAX_CALLS) {
        const message = `Rejected: maximum tool call success budget of ${MAX_CALLS} exceeded for this run.`;
        console.warn(`[agentGhTool] ${message}`);
        return { error: message };
      }

      // 2. Format checks
      if (!Array.isArray(args) || args.length < 2) {
        const message = `Rejected: gh command must include at least a resource and an action (got ${JSON.stringify(args)}).`;
        console.warn(`[agentGhTool] ${message}`);
        return { error: message };
      }

      // 3. Subcommand allowlist check
      if (!isAllowedGhCommand(args)) {
        const message =
          `Rejected: "gh ${subcommandOf(args)}" is not on the allowlist. ` +
          `Allowed subcommands: ${ALLOWED_GH_COMMANDS.join(', ')}.`;
        console.warn(`[agentGhTool] Rejected disallowed gh subcommand: "${subcommandOf(args)}" (full args: ${JSON.stringify(args)})`);
        return { error: message };
      }

      // 4. Parameter security check: --repo / -R (no cross-repo)
      const hasRepoArg = args.some((arg) =>
        arg === '--repo' || arg.startsWith('--repo=') || arg === '-R'
      );
      if (hasRepoArg) {
        const message = 'Rejected: cross-repo access is forbidden. Remove --repo/-R flags.';
        console.warn(`[agentGhTool] ${message}`);
        return { error: message };
      }

      // 5. Parameter security check: --body-file / -F (no local file access)
      const hasBodyFileArg = args.some((arg) =>
        arg === '--body-file' || arg.startsWith('--body-file=') || arg === '-F'
      );
      if (hasBodyFileArg) {
        const message = 'Rejected: reading from files via --body-file/-F is forbidden. Use --body/-b instead.';
        console.warn(`[agentGhTool] ${message}`);
        return { error: message };
      }

      const subcommand = subcommandOf(args);

      // Guard against overly large body sizes or HTML injections (prompt injection or massive outputs)
      if (['issue comment', 'pr comment'].includes(subcommand)) {
        let bodyText = '';
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--body' || args[i] === '-b') {
            bodyText = args[i + 1] || '';
            break;
          } else if (args[i].startsWith('--body=')) {
            bodyText = args[i].substring(7);
            break;
          } else if (args[i].startsWith('-b=')) {
            bodyText = args[i].substring(3);
            break;
          }
        }
        const MAX_COMMENT_LENGTH = 10000;
        if (bodyText.length > MAX_COMMENT_LENGTH) {
          const message = `Rejected: comment body is too long (${bodyText.length} characters). Maximum allowed length is ${MAX_COMMENT_LENGTH} characters.`;
          console.warn(`[agentGhTool] ${message}`);
          return { error: message };
        }
        const containsHtmlInjections = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi.test(bodyText) ||
                                       /<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi.test(bodyText);
        if (containsHtmlInjections) {
          const message = 'Rejected: comment body contains potential HTML script/iframe injections.';
          console.warn(`[agentGhTool] ${message}`);
          return { error: message };
        }
      }

      // 6. Target-ID boundary validation (scoping to the triggering issue/PR)
      const triggeringIssueNumber = process.env.ISSUE_NUMBER;
      if (triggeringIssueNumber) {
        const targetId = extractTargetIdFromArgs(args);
        if (['issue view', 'issue comment'].includes(subcommand)) {
          if (!targetId || targetId !== triggeringIssueNumber) {
            const message = `Rejected: gh command target issue (${targetId || 'none'}) does not match triggering issue #${triggeringIssueNumber}.`;
            console.warn(`[agentGhTool] ${message}`);
            return { error: message };
          }
        }
        if (['pr view', 'pr diff', 'pr comment'].includes(subcommand)) {
          const allowedPrs = getAllowedPrNumbers(triggeringIssueNumber);
          const isBranchMatch = targetId !== null && allowedPrs.includes(targetId);
          const isDirectLinkMatch = isBranchMatch || (targetId !== null && isPrLinkedToIssue(targetId, triggeringIssueNumber));
          if (!targetId || !isDirectLinkMatch) {
            const message = `Rejected: gh command target PR (${targetId || 'none'}) is not linked or associated with triggering issue #${triggeringIssueNumber} (allowed PRs: ${allowedPrs.join(', ') || 'none'}).`;
            console.warn(`[agentGhTool] ${message}`);
            return { error: message };
          }
        }
      }

      // 7. Increment call count only after all validation checks have passed successfully
      callCount++;
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
