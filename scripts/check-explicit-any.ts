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
  cleaned = cleaned.replace(/`/g, ''); // Simplified backtick removal
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

const bannedTsCommentRegex = /(?:\/\/|\/\*|^\s*\*)\s*@ts-(?:ignore|expect-error)\b/;

function isCommentLine(trimmed: string): boolean {
  // Do not ignore comment lines if they contain the banned directives
  if (bannedTsCommentRegex.test(trimmed)) {
    return false;
  }
  // Do not ignore comment lines if they contain eslint-disable comments,
  // so that we can process their disable/enable state in the main loop.
  if (trimmed.includes('eslint-disable')) {
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

function updateBlockCommentState(line: string, currentState: boolean): boolean {
  let inComment = currentState;
  let pos = 0;
  while (pos < line.length) {
    if (!inComment) {
      const startIdx = line.indexOf('/*', pos);
      if (startIdx === -1) {
        break;
      }
      inComment = true;
      pos = startIdx + 2;
    } else {
      const endIdx = line.indexOf('*/', pos);
      if (endIdx === -1) {
        break;
      }
      inComment = false;
      pos = endIdx + 2;
    }
  }
  return inComment;
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
    } catch {
      console.warn('Failed to get diff against merge base, trying direct diff against base ref...');
      try {
        diff = execSync(`git diff ${baseRef} -- 'src/orchestrator' 'src/copilotSdk'`, { encoding: 'utf8' });
      } catch {
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
  let blockDisableAny = false;
  let blockDisableTsComment = false;
  let inBlockComment = false;

  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      ignoreNextExplicitAny = false;
      ignoreNextBanTsComment = false;
      blockDisableAny = false;
      blockDisableTsComment = false;
      inBlockComment = false;
      continue;
    }

    if (line.startsWith('@@ ')) {
      // Hunk boundary - reset inBlockComment because the hunk context is disjoint
      inBlockComment = false;
      continue;
    }

    if (!line.startsWith('+') && !line.startsWith('-') && !line.startsWith(' ')) {
      continue;
    }

    const prefix = line[0];
    const content = line.slice(1);
    const trimmed = content.trim();

    // 1. Maintain block comment state and block disables across all added/context lines
    if (prefix === '+' || prefix === ' ') {
      inBlockComment = updateBlockCommentState(content, inBlockComment);

      // Check block disables / enables
      if (content.includes('eslint-disable') && !content.includes('eslint-disable-next-line') && !content.includes('eslint-disable-line')) {
        const hasNoSpecifics = !content.includes('@typescript-eslint/');
        if (hasNoSpecifics || content.includes('@typescript-eslint/no-explicit-any')) {
          blockDisableAny = true;
        }
        if (hasNoSpecifics || content.includes('@typescript-eslint/ban-ts-comment')) {
          blockDisableTsComment = true;
        }
      } else if (content.includes('eslint-enable')) {
        const hasNoSpecifics = !content.includes('@typescript-eslint/');
        if (hasNoSpecifics || content.includes('@typescript-eslint/no-explicit-any')) {
          blockDisableAny = false;
        }
        if (hasNoSpecifics || content.includes('@typescript-eslint/ban-ts-comment')) {
          blockDisableTsComment = false;
        }
      }
    }

    // 2. Perform violation checks only on newly added lines ('+')
    if (prefix === '+') {
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

      const shouldIgnoreAny = ignoreNextExplicitAny || isLineAnyDisabled || blockDisableAny;
      const shouldIgnoreTsComment = ignoreNextBanTsComment || isLineTsCommentDisabled || blockDisableTsComment;

      // Reset the "next-line" flags for the following lines, but set them now if this line is a disable-next-line
      ignoreNextExplicitAny = hasDisableAny;
      ignoreNextBanTsComment = hasDisableTsComment;

      // If the line is classified as a standard comment line (and is not an eslint disable directive or does not contain @ts-ignore), ignore it.
      if (isCommentLine(trimmed)) {
        continue;
      }

      // If we are currently in a multi-line block comment, skip any regular check (e.g. 'any')
      // but still check for @ts-ignore or @ts-expect-error
      if (inBlockComment) {
        const literalsStripped = stripStringAndRegexLiterals(content);
        if (bannedTsCommentRegex.test(literalsStripped)) {
          if (!shouldIgnoreTsComment) {
            violations.push({
              file: currentFile,
              lineContent: trimmed,
              reason: 'Usage of @ts-ignore or @ts-expect-error is forbidden by the type discipline guide.'
            });
          }
        }
        continue;
      }

      // 1. Strip string/regex literals first to avoid false positives inside literals
      const literalsStripped = stripStringAndRegexLiterals(content);

      // 2. Check for @ts-ignore or @ts-expect-error in the stripped content
      if (bannedTsCommentRegex.test(literalsStripped)) {
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
