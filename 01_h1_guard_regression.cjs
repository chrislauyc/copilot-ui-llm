// H1 regression check: checkpoint/restore must refuse to run when cwd is
// missing, and must refuse any directory that isn't an initialized
// .aistudio sandbox. Mirrors the exact guard now in server.ts (post-fix).
// Runs entirely inside a throwaway tmp dir; never touches the real repo.

const fs = require('fs');
const path = require('path');
const os = require('os');

function validateGitWorktree(dir) {
  const sandboxGitDir = path.join(dir, '.aistudio', '.git');
  if (fs.existsSync(path.join(dir, '.git')) && fs.statSync(path.join(dir, '.git')).isDirectory()) {
    return { valid: false, error: 'Access Denied: Un-sandboxed top-level .git directory found.' };
  }
  if (!fs.existsSync(sandboxGitDir)) {
    return { valid: false, error: 'Target directory is not an initialized AI Studio Git sandbox.' };
  }
  return { valid: true };
}

function simulateRestoreGuard(sessionCwd) {
  const runCwd = sessionCwd; // post-fix: no `|| process.cwd()` fallback
  if (!runCwd) {
    return { blocked: true, reason: 'Session has no associated working directory.' };
  }
  const v = validateGitWorktree(runCwd);
  if (!v.valid) {
    return { blocked: true, reason: v.error };
  }
  return { blocked: false };
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-guard-'));
const plainDir = path.join(scratch, 'plain-dir');       // no .git at all
const realGitDir = path.join(scratch, 'real-git-dir');  // top-level .git as a directory
const sandboxDir = path.join(scratch, 'sandboxed');     // proper .aistudio/.git

fs.mkdirSync(plainDir, { recursive: true });
fs.mkdirSync(path.join(realGitDir, '.git'), { recursive: true });
fs.mkdirSync(path.join(sandboxDir, '.aistudio', '.git'), { recursive: true });

const cases = [
  { label: 'cwd undefined (session never set one)', cwd: undefined, expectBlocked: true },
  { label: 'cwd empty string', cwd: '', expectBlocked: true },
  { label: 'plain directory, no git at all', cwd: plainDir, expectBlocked: true },
  { label: 'real top-level .git directory present', cwd: realGitDir, expectBlocked: true },
  { label: 'properly initialized .aistudio sandbox', cwd: sandboxDir, expectBlocked: false },
];

let allPassed = true;
for (const c of cases) {
  const result = simulateRestoreGuard(c.cwd);
  const pass = result.blocked === c.expectBlocked;
  allPassed = allPassed && pass;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${c.label} -> blocked=${result.blocked}${result.reason ? ` (${result.reason})` : ''}`);
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log(allPassed ? '\nH1 guard: ALL CASES PASS' : '\nH1 guard: REGRESSION DETECTED');
process.exit(allPassed ? 0 : 1);
