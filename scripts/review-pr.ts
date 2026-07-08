// check for openrouter models first before falling back to gemini
if (!process.env.REVIEWER_PROVIDER && process.env.REVIEWER_MODEL) {
  if (process.env.REVIEWER_MODEL.includes('/')) {
    process.env.REVIEWER_PROVIDER = 'openrouter';
  } else {
    process.env.REVIEWER_PROVIDER = 'gemini';
  }
}
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import { app } from '../src/serverRuntime';
import { getReviewerExecutionConfig, executeAuditSession } from '../src/utils/auditorHelper';
import { submitCodeReviewTool } from '../src/config/tools';
import { getFilteredDiff } from './diffFilter';
import {
  loadPreviousReviewState,
  isCommitReachable,
  renderStateMarker,
  type ReviewState,
  type PersistedBlockingFinding,
} from './reviewState';

interface CodeReviewFinding {
  severity: 'blocking' | 'suggestion' | 'nit';
  file: string;
  line?: number;
  message: string;
  status?: 'new' | 'still-open' | 'resolved';
}

interface CodeReviewResult {
  findings: CodeReviewFinding[];
  summary: string;
}
const PORT = parseInt(process.env.PORT || '3000', 10);
/**
 * ProviderRegistry routes gemini (and other non-anthropic-direct) calls through
 * this app's own '/api/providers/:provider/*' proxy route rather than hitting
 * the upstream API directly (see src/serverRuntime.ts). That route is normally
 * only reachable because the full app server is already running. This script
 * runs headless in CI, so it has to stand the proxy up itself for the duration
 * of the review call.
 */
function startProviderProxy(): Promise<Server> {  
  process.env.COPILOT_API_URL = `http://127.0.0.1:${PORT}`;
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function stopProviderProxy(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Resolves which diff range to review. Prefers an incremental diff since the
 * last-reviewed sha (cheaper, and lets the model focus on what's actually new)
 * but falls back to the full base...head diff whenever that isn't possible or
 * safe: no prior state, the prior sha is unreachable (force-push/rebase, or a
 * shallow checkout that never had it), or it's identical to the current head
 * (nothing new to review incrementally, though we still may want to bail out
 * entirely -- handled by the caller).
 */
function resolveDiffRange(
  baseSha: string,
  headSha: string,
  previousState: ReviewState | null,
): { range: string; incremental: boolean } {
  if (!previousState) {
    return { range: `${baseSha}...${headSha}`, incremental: false };
  }
  if (previousState.lastReviewedSha === headSha) {
    return { range: `${baseSha}...${headSha}`, incremental: false };
  }
  if (!isCommitReachable(previousState.lastReviewedSha)) {
    console.warn(
      `[review-pr] previously-reviewed sha ${previousState.lastReviewedSha} is not reachable in this checkout ` +
      `(force-push, rebase, or shallow clone) -- falling back to a full review.`,
    );
    return { range: `${baseSha}...${headSha}`, incremental: false };
  }
  return { range: `${previousState.lastReviewedSha}...${headSha}`, incremental: true };
}

function buildSystemPrompt(incremental: boolean): string {
  return `You are a code review agent. Review the given PR diff for bugs, compliance issues, and quality concerns.

Compliance information is located in AGENTS.md and README.md.

${incremental
    ? `The PR DIFF below only covers changes since the last review round. A list of previously reported blocking findings is included -- for each one, check whether it is now resolved, still open, or (if it no longer applies at all) drop it. Only set the 'status' field on findings that correspond to one of these prior items. Do not re-raise a previously reported blocking finding as a new finding; instead report it once with the appropriate status.`
    : `This is a full review of the entire PR diff (no prior review state was found, or it could not be used). Do not set the 'status' field on any findings.`}

Suggestions and nits are not tracked across review rounds -- just report whatever you currently observe, with no 'status' field.

You must not answer conversationally and must strictly invoke 'submit_code_review'.`;
}

function buildUserPrompt(diff: string, previousState: ReviewState | null, incremental: boolean): string {
  if (!incremental || !previousState || previousState.blockingFindings.length === 0) {
    return `PR DIFF:\n${diff}`;
  }
  const findingsList = previousState.blockingFindings
    .map((f: PersistedBlockingFinding) => `- \`${f.file}${f.line ? ':' + f.line : ''}\`: ${f.message}`)
    .join('\n');
  return `Previously reported blocking findings (verify each is resolved, still-open, or no longer applicable):\n${findingsList}\n\nPR DIFF (since last reviewed commit):\n${diff}`;
}

async function main() {
  const baseSha = process.env.PR_BASE_SHA;
  const headSha = process.env.PR_HEAD_SHA;
  const prNumber = process.env.PR_NUMBER;

  if (!baseSha || !headSha || !prNumber) {
    console.error('Missing required env vars: PR_BASE_SHA, PR_HEAD_SHA, PR_NUMBER.');
    process.exit(1);
  }

  const previousState = loadPreviousReviewState(prNumber);
  const { range, incremental } = resolveDiffRange(baseSha, headSha, previousState);

  const diff = getFilteredDiff(range);
  if (!diff.trim()) {
    console.log(`No diff to review for range ${range}, skipping.`);
    return;
  }

  const systemPrompt = buildSystemPrompt(incremental);
  const userPrompt = buildUserPrompt(diff, previousState, incremental);

  const executionConfig = getReviewerExecutionConfig();
  const proxyServer = await startProviderProxy();
  let result: CodeReviewResult | null;

  try {
    result = await executeAuditSession<CodeReviewResult>(
      process.cwd(),
      executionConfig,
      systemPrompt,
      submitCodeReviewTool,
      userPrompt,
      {
        toolChoice: { type: 'function', function: { name: submitCodeReviewTool.function.name } },
        allowOthers: false
      },
      undefined,
      600000
    );
  } finally {
    await stopProviderProxy(proxyServer);
  }

  if (!result) {
    console.error('Reviewer failed to return findings.');
    process.exit(1);
  }

  const bySeverity = (sev: CodeReviewFinding['severity']) =>
    result.findings.filter((f) => f.severity === sev);

  const section = (label: string, items: CodeReviewFinding[]) =>
    items.length
      ? `**${label}**\n` + items.map((f) => {
          const statusTag = f.status ? ` _(${f.status})_` : '';
          return `- \`${f.file}${f.line ? ':' + f.line : ''}\`: ${f.message}${statusTag}`;
        }).join('\n')
      : '';

  const blockingFindings = bySeverity('blocking');

  const body = [
    `### Code Review${incremental ? ' (incremental, since last review)' : ''}`,
    result.summary,
    section('Blocking', blockingFindings),
    section('Suggestions', bySeverity('suggestion')),
    section('Nits', bySeverity('nit')),
  ].filter(Boolean).join('\n\n');

  // Only carry forward blocking findings that are still open (drop anything
  // the model marked 'resolved', and drop suggestions/nits entirely -- see
  // discussion: cross-run memory is only worth the token/complexity cost for
  // gating issues, not opt-in ones).
  const stillOpenBlocking: PersistedBlockingFinding[] = blockingFindings
    .filter((f) => f.status !== 'resolved')
    .map((f) => ({ file: f.file, line: f.line, message: f.message }));

  const newState: ReviewState = {
    lastReviewedSha: headSha,
    blockingFindings: stillOpenBlocking,
  };
  const bodyWithState = `${body}\n\n${renderStateMarker(newState)}`;

  try {
    execFileSync('gh', ['pr', 'comment', prNumber, '--body', bodyWithState], { stdio: 'inherit' });
  } catch (commentErr) {
    console.warn('[review-pr] failed to post PR comment using GitHub CLI (this is expected if the run originates from a fork or lacks write permissions):', commentErr);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[review-pr] failed:', err?.message || err);
  process.exit(1);
});
