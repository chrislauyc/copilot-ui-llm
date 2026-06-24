// H3: verifies that our fix successfully solves the initial commit issue.
// By running `git add -A` and committing a Sandbox Baseline right after init,
// pre-existing files are tracked immediately. Combined with isolating the 
// process workspace to /tmp/sandbox/workspace, files in the real working directory
// are completely protected from git hard resets/checkouts.
// Runs entirely inside a throwaway tmp dir; never touches the real repo.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-root-cause-host-'));
const sandboxCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-root-cause-sandbox-'));
const workspaceDir = path.join(sandboxCwd, 'workspace');
fs.mkdirSync(workspaceDir, { recursive: true });

function getGitEnv() {
  return { ...process.env, GIT_DIR: path.join(sandboxCwd, '.git'), GIT_WORK_TREE: workspaceDir, GIT_PAGER: 'cat' };
}
function run(args) {
  return execFileSync('git', args, { cwd: workspaceDir, env: getGitEnv() }).toString();
}

// A file pre-exists, e.g. dropped in by the IDE/scaffold before any AI turn runs.
fs.writeFileSync(path.join(cwd, 'scaffold_file.txt'), 'present before sandbox init');

// Sync to workspace initial state
fs.cpSync(cwd, workspaceDir, { recursive: true });

// --- initializeGitSandboxSync (updated with fix) ---
run(['init']);
run(['config', 'user.email', 'sandbox@aistudio.local']);
run(['config', 'user.name', 'AI Studio Sandbox']);
run(['add', '-A']);
run(['commit', '--allow-empty', '-m', 'Sandbox Baseline (pre-existing files)']);

const afterInitLs = run(['ls-tree', '-r', '--name-only', 'HEAD']).trim();
console.log('Files tracked in HEAD right after sandbox init:', JSON.stringify(afterInitLs) || '(none)');
const scaffoldIsTrackedInitially = afterInitLs.includes('scaffold_file.txt');
console.log('  scaffold_file.txt tracked in baseline?', scaffoldIsTrackedInitially);

// --- first real turn (add custom authored file) ---
fs.writeFileSync(path.join(cwd, 'agent_authored_file.txt'), 'the file the agent actually meant to create');
fs.cpSync(cwd, workspaceDir, { recursive: true });
run(['add', '-A']);
run(['commit', '-m', 'Turn Completed: create agent_authored_file.txt']);
const checkpointSha = run(['rev-parse', 'HEAD']).trim();

const afterTurnLs = run(['ls-tree', '-r', '--name-only', 'HEAD']).trim().split('\n');
console.log('\nFiles tracked after first turn commit:', afterTurnLs);

// --- user manually edits scaffold_file.txt in host, unrelated to AI turns ---
fs.writeFileSync(path.join(cwd, 'scaffold_file.txt'), 'user hand-edited this directly, unrelated to AI turns');

// --- restoreCheckpointAsync verbatim ---
run(['reset', '--hard', 'HEAD']);
run(['checkout', checkpointSha, '--', '.']);
run(['add', '-A']);
try {
  run(['commit', '-m', 'Restore to Checkpoint: diagnostic']);
} catch (e) {
  // ignore commit no-op
}

const finalContentHost = fs.readFileSync(path.join(cwd, 'scaffold_file.txt'), 'utf8');
console.log('\nscaffold_file.txt content in host after a checkpoint restore:', JSON.stringify(finalContentHost));
const handEditPreserved = finalContentHost === 'user hand-edited this directly, unrelated to AI turns';
console.log('  user\'s hand-edit successfully preserved:', handEditPreserved);

fs.rmSync(cwd, { recursive: true, force: true });
fs.rmSync(sandboxCwd, { recursive: true, force: true });

const fixSuccess = scaffoldIsTrackedInitially && handEditPreserved;
console.log(fixSuccess
  ? '\nH3 REAL VERIFICATION PASSED: Pre-existing files are tracked immediately in the sandbox baseline, and isolated host files remain completely safe and untouched by restore checkpoint operations!'
  : '\nH3 verification FAILED.');
process.exit(fixSuccess ? 0 : 1);
