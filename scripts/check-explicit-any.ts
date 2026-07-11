import { execSync } from 'node:child_process';

const safeRefRegex = /^[a-zA-Z0-9._\-\/]+$/;

// Try to fetch the base branch if we are in a GitHub Actions environment
if (process.env.GITHUB_ACTIONS === 'true') {
  const baseRef = process.env.GITHUB_BASE_REF || 'main';
  if (safeRefRegex.test(baseRef)) {
    console.log(`GitHub Actions detected. Fetching base branch: ${baseRef}...`);
    try {
      // Attempt to unshallow the current repository clone first so git has history
      try {
        execSync('git fetch --unshallow', { stdio: 'ignore' });
      } catch {
        // already unshallow or failed
      }
      execSync(`git fetch origin ${baseRef} --depth=100`, { stdio: 'inherit' });
    } catch (err) {
      console.warn(`Failed to fetch origin ${baseRef}:`, err);
    }
  } else {
    console.warn(`Invalid GITHUB_BASE_REF: "${baseRef}"`);
  }
}

function getBaseRef(): string | null {
  if (process.env.GITHUB_BASE_REF) {
    const baseRef = process.env.GITHUB_BASE_REF;
    if (safeRefRegex.test(baseRef)) {
      const prBase = `origin/${baseRef}`;
      try {
        execSync(`git rev-parse --verify ${prBase}`, { stdio: 'ignore' });
        return prBase;
      } catch {}
    }
  }

  for (const ref of ['origin/main', 'main', 'origin/master', 'master']) {
    try {
      execSync(`git rev-parse --verify ${ref}`, { stdio: 'ignore' });
      return ref;
    } catch {
      // ignore
    }
  }
  return null;
}

function stripStringAndRegexLiterals(line: string): string {
  let cleaned = line;
  // Strip string literals: "...", '...', `...`
  cleaned = cleaned.replace(/"(?:\\.|[^"\\])*"/g, '');
  cleaned = cleaned.replace(/'(?:\\.|[^'\\])*'/g, '');
  cleaned = cleaned.replace(/`(?:\\.|[^`\\])*`/g, '');
  // Strip regex literals
  cleaned = cleaned.replace(/\/(?![*\/])(?:\\.|[^\/\\])+\/[gimsuy]*/g, '');
  return cleaned;
}

function cleanCodeLine(line: string): string {
  // Strip single-line comments (starting with //)
  let cleaned = line.replace(/\/\/.*$/g, '');

  // Strip multi-line comments in a single line (like /* ... */)
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');

  // Strip string/regex literals
  cleaned = stripStringAndRegexLiterals(cleaned);

  return cleaned;
}

function isCommentLine(trimmed: string): boolean {
  // Do not ignore comment lines if they contain the banned directives
  if (/@ts-ignore|@ts-expect-error/.test(trimmed)) {
    return false;
  }
  // Single line comments
  if (trimmed.startsWith('//')) return true;
  // Block comment start or end
  if (trimmed.startsWith('/*') || trimmed.startsWith('*/')) return true;
  // JSDoc / block comment continuation line
  if (trimmed === '*' || trimmed.startsWith('* ')) return true;
  return false;
}

function main() {
  console.log('=== Checking for new explicit "any", @ts-ignore, or @ts-expect-error in src/orchestrator or src/copilotSdk ===');

  let diff = '';
  const baseRef = getBaseRef();

  if (baseRef) {
    try {
      console.log(`Finding merge base between ${baseRef} and HEAD...`);
      const mergeBase = execSync(`git merge-base ${baseRef} HEAD`, { encoding: 'utf8' }).trim();
      console.log(`Comparing current state against merge base ${mergeBase} (from ${baseRef})...`);
      diff = execSync(`git diff ${mergeBase} -- 'src/orchestrator' 'src/copilotSdk'`, { encoding: 'utf8' });
    } catch (err) {
      console.warn('Failed to get diff against merge base, trying direct diff against base ref...');
      try {
        diff = execSync(`git diff ${baseRef} -- 'src/orchestrator' 'src/copilotSdk'`, { encoding: 'utf8' });
      } catch (err2) {
        console.warn('Failed to get diff against base ref, falling back to local diff against HEAD.');
        try {
          diff = execSync(`git diff HEAD -- 'src/orchestrator' 'src/copilotSdk'`, { encoding: 'utf8' });
        } catch {
          // ignore
        }
      }
    }
  } else {
    console.log('No base branch found. Checking uncommitted/local changes against HEAD.');
    try {
      diff = execSync(`git diff HEAD -- 'src/orchestrator' 'src/copilotSdk'`, { encoding: 'utf8' });
    } catch {
      // ignore
    }
  }

  if (!diff.trim()) {
    console.log('✅ No changes detected in target paths.');
    process.exit(0);
  }

  const lines = diff.split('\n');
  const violations: { file: string; lineContent: string; reason: string }[] = [];
  let currentFile = 'unknown';

  let ignoreNextExplicitAny = false;
  let ignoreNextBanTsComment = false;

  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      ignoreNextExplicitAny = false;
      ignoreNextBanTsComment = false;
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      const content = line.slice(1);
      const trimmed = content.trim();

      // Ignore comment continuation lines and comment boundaries
      if (isCommentLine(trimmed)) {
        continue;
      }

      // Check if this line has a disable comment for subsequent lines (eslint-disable-next-line)
      let hasDisableAny = false;
      let hasDisableTsComment = false;

      if (content.includes('eslint-disable-next-line')) {
        if (content.includes('@typescript-eslint/no-explicit-any')) {
          hasDisableAny = true;
        }
        if (content.includes('@typescript-eslint/ban-ts-comment')) {
          hasDisableTsComment = true;
        }
      }

      // Check if this line itself has an eslint-disable-line or inline eslint-disable
      const isLineAnyDisabled = (content.includes('eslint-disable-line') || content.includes('eslint-disable')) && 
                                content.includes('@typescript-eslint/no-explicit-any');
      const isLineTsCommentDisabled = (content.includes('eslint-disable-line') || content.includes('eslint-disable')) && 
                                      content.includes('@typescript-eslint/ban-ts-comment');

      const shouldIgnoreAny = ignoreNextExplicitAny || isLineAnyDisabled;
      const shouldIgnoreTsComment = ignoreNextBanTsComment || isLineTsCommentDisabled;

      // Reset the "next-line" flags for future lines, but if this line itself is a disable-next-line, set them for the next one
      ignoreNextExplicitAny = hasDisableAny;
      ignoreNextBanTsComment = hasDisableTsComment;

      // 1. Strip string/regex literals first to avoid false positives inside literals
      const literalsStripped = stripStringAndRegexLiterals(content);

      // 2. Check for @ts-ignore or @ts-expect-error in the stripped content
      if (/@ts-ignore|@ts-expect-error/.test(literalsStripped)) {
        if (!shouldIgnoreTsComment) {
          violations.push({
            file: currentFile,
            lineContent: trimmed,
            reason: 'Usage of @ts-ignore or @ts-expect-error is forbidden by the type discipline guide.'
          });
        }
        continue;
      }

      // 3. Strip comments and strings before checking for 'any'
      const cleaned = cleanCodeLine(content);

      if (/\bany\b/.test(cleaned)) {
        if (!shouldIgnoreAny) {
          violations.push({
            file: currentFile,
            lineContent: trimmed,
            reason: 'New explicit "any" type usage is forbidden in orchestrator/SDK paths.'
          });
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error('\n❌ ERROR: Type discipline violations introduced in src/orchestrator or src/copilotSdk paths:\n');
    for (const violation of violations) {
      console.error(`  File: ${violation.file}`);
      console.error(`  Line: ${violation.lineContent}`);
      console.error(`  Reason: ${violation.reason}\n`);
    }
    console.error('Please specify a more specific type instead of "any", or use "unknown" or "eslint-disable-next-line @typescript-eslint/no-explicit-any" if absolutely necessary.\n');
    process.exit(1);
  }

  console.log('✅ No new explicit "any" or banned TS comments detected in target paths.');
  process.exit(0);
}

main();
