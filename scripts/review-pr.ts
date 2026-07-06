import { execSync } from 'node:child_process';
import { getReviewerExecutionConfig, executeAuditSession } from '../src/utils/auditorHelper';
import { submitCodeReviewTool } from '../src/config/tools';

interface CodeReviewFinding {
  severity: 'blocking' | 'suggestion' | 'nit';
  file: string;
  line?: number;
  message: string;
}

interface CodeReviewResult {
  findings: CodeReviewFinding[];
  summary: string;
}

async function main() {
  const baseSha = process.env.PR_BASE_SHA;
  const headSha = process.env.PR_HEAD_SHA;
  const prNumber = process.env.PR_NUMBER;

  if (!baseSha || !headSha || !prNumber) {
    console.error('Missing required env vars: PR_BASE_SHA, PR_HEAD_SHA, PR_NUMBER.');
    process.exit(1);
  }

  const diff = execSync(`git diff ${baseSha}...${headSha}`, { maxBuffer: 1024 * 1024 * 20 }).toString();

  if (!diff.trim()) {
    console.log('No diff to review, skipping.');
    return;
  }

  const systemPrompt = `You are a code review agent. Review the given PR diff for bugs, security issues, and quality concerns.
This PR may have been reviewed on a previous push -- focus on issues that are new or still unresolved, and avoid re-raising points that would already have been addressed.
You must not answer conversationally and must strictly invoke 'submit_code_review'.`;

  const executionConfig = getReviewerExecutionConfig();

  const result = await executeAuditSession<CodeReviewResult>(
    process.cwd(),
    executionConfig,
    systemPrompt,
    submitCodeReviewTool,
    `PR DIFF:\n${diff}`,
    {
      toolChoice: { type: 'function', function: { name: submitCodeReviewTool.function.name } },
      allowOthers: false
    }
  );

  if (!result) {
    console.error('Reviewer failed to return findings.');
    process.exit(1);
  }

  const bySeverity = (sev: CodeReviewFinding['severity']) =>
    result.findings.filter((f) => f.severity === sev);

  const section = (label: string, items: CodeReviewFinding[]) =>
    items.length
      ? `**${label}**\n` + items.map((f) => `- \`${f.file}${f.line ? ':' + f.line : ''}\`: ${f.message}`).join('\n')
      : '';

  const body = [
    `### Code Review`,
    result.summary,
    section('Blocking', bySeverity('blocking')),
    section('Suggestions', bySeverity('suggestion')),
    section('Nits', bySeverity('nit')),
  ].filter(Boolean).join('\n\n');

  execSync(`gh pr comment ${prNumber} --body ${JSON.stringify(body)}`, { stdio: 'inherit' });
}

main().catch((err) => {
  console.error('[review-pr] failed:', err?.message || err);
  process.exit(1);
});
