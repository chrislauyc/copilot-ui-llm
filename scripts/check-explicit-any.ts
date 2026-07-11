import { execSync } from 'node:child_process';

// Try to fetch the base branch if we are in a GitHub Actions environment
if (process.env.GITHUB_ACTIONS === 'true') {
  const baseRef = process.env.GITHUB_BASE_REF || 'main';
  console.log(`GitHub Actions detected. Fetching base branch: ${baseRef}...`);
  try {
    execSync(`git fetch origin ${baseRef} --depth=1`, { stdio: 'inherit' });
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

function main() {
  console.log('=== Checking for new explicit "any" in src/orchestrator or src/copilotSdk ===');

  let diff = '';
  const baseRef = getBaseRef();

  if (baseRef) {
    try {
      // Find the merge base between the base branch and HEAD
      const mergeBase = execSync(`git merge-base ${baseRef} HEAD`, { encoding: 'utf8' }).trim();
      console.log(`Comparing current state against merge base ${mergeBase} (from ${baseRef})`);
      diff = execSync(`git diff ${mergeBase} -- 'src/orchestrator' 'src/copilotSdk'`, { encoding: 'utf8' });
    } catch (err) {
      console.warn('Failed to get diff against merge base, falling back to local diff.');
      try {
        diff = execSync(`git diff -- 'src/orchestrator' 'src/copilotSdk'`, { encoding: 'utf8' });
      } catch {
        // ignore
      }
    }
  } else {
    console.log('No base branch found. Checking uncommitted/local changes.');
    try {
      diff = execSync(`git diff -- 'src/orchestrator' 'src/copilotSdk'`, { encoding: 'utf8' });
    } catch {
      // ignore
    }
  }

  if (!diff.trim()) {
    console.log('✅ No changes detected in target paths.');
    process.exit(0);
  }

  const lines = diff.split('\n');
  const explicitAnyRegex = /:\s*any\b|as\s+any\b|<any>/;
  const violations: { file: string; lineContent: string }[] = [];
  let currentFile = 'unknown';

  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      const content = line.slice(1);
      const trimmed = content.trim();

      // Ignore comments
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        continue;
      }
      
      // Ignore if it has eslint-disable comments
      if (content.includes('eslint-disable')) {
        continue;
      }

      if (explicitAnyRegex.test(content)) {
        violations.push({
          file: currentFile,
          lineContent: trimmed
        });
      }
    }
  }

  if (violations.length > 0) {
    console.error('\n❌ ERROR: New explicit "any" introduced in src/orchestrator or src/copilotSdk paths:\n');
    for (const violation of violations) {
      console.error(`  File: ${violation.file}`);
      console.error(`  Line: ${violation.lineContent}\n`);
    }
    console.error('Please specify a more specific type instead of "any", or use "unknown" or "eslint-disable-next-line @typescript-eslint/no-explicit-any" if absolutely necessary.\n');
    process.exit(1);
  }

  console.log('✅ No new explicit "any" usages detected in target paths.');
  process.exit(0);
}

main();
