import { execSync } from 'node:child_process';

// Try to fetch the base branch if we are in a GitHub Actions environment
if (process.env.GITHUB_ACTIONS === 'true') {
  const baseRef = process.env.GITHUB_BASE_REF || 'main';
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
}

function getBaseRef(): string | null {
  if (process.env.GITHUB_BASE_REF) {
    const prBase = `origin/${process.env.GITHUB_BASE_REF}`;
    try {
      execSync(`git rev-parse --verify ${prBase}`, { stdio: 'ignore' });
      return prBase;
    } catch {}
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

function cleanCodeLine(line: string): string {
  // Strip single-line comments (starting with //)
  let cleaned = line.replace(/\/\/.*$/g, '');

  // Strip multi-line comments in a single line (like /* ... */)
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');

  // Strip string literals: '...', "...", `...`
  cleaned = cleaned.replace(/"(?:\\.|[^"\\])*"/g, '');
  cleaned = cleaned.replace(/'(?:\\.|[^'\\])*'/g, '');
  cleaned = cleaned.replace(/`(?:\\.|[^`\\])*`/g, '');

  return cleaned;
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

  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      const content = line.slice(1);
      const trimmed = content.trim();

      // Check for eslint-disable comment
      if (content.includes('eslint-disable')) {
        continue;
      }

      // 1. Check for @ts-ignore or @ts-expect-error first (before stripping comments)
      if (/@ts-ignore|@ts-expect-error/.test(content)) {
        violations.push({
          file: currentFile,
          lineContent: trimmed,
          reason: 'Usage of @ts-ignore or @ts-expect-error is forbidden by the type discipline guide.'
        });
        continue;
      }

      // 2. Strip comments and strings before checking for 'any'
      const cleaned = cleanCodeLine(content);

      if (/\bany\b/.test(cleaned)) {
        violations.push({
          file: currentFile,
          lineContent: trimmed,
          reason: 'New explicit "any" type usage is forbidden in orchestrator/SDK paths.'
        });
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
