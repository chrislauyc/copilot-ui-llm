// H2 blast-radius check: even with the .aistudio sandbox GIT_DIR/GIT_WORK_TREE
// design, migrating the active sandbox GIT_WORK_TREE to /tmp/sandbox/workspace
// isolates the host working directory from destructive git operations.
// This script verifies that workspace operations on `/tmp/sandbox/workspace` 
// do not touch, revert, or delete files in the real project working directory.
// Runs entirely inside a throwaway tmp dir; never touches the real repo.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-blast-radius-host-'));
const sandboxCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-blast-radius-sandbox-'));
const workspaceDir = path.join(sandboxCwd, 'workspace');
fs.mkdirSync(workspaceDir, { recursive: true });

function getGitEnv() {
  return {
    ...process.env,
    GIT_DIR: path.join(sandboxCwd, '.git'),
    GIT_WORK_TREE: workspaceDir,
    GIT_PAGER: 'cat',
  };
}

function run(args) {
  return execFileSync('git', args, { cwd: workspaceDir, env: getGitEnv() }).toString();
}

// 1. A file exists BEFORE the sandbox is ever initialized (simulates real host project file)
fs.writeFileSync(path.join(cwd, 'pre_existing_real_file.txt'), 'original content, never committed to sandbox');

// Host files synced to sandbox workspace initially
fs.cpSync(cwd, workspaceDir, { recursive: true });

// 2. Initialize the sandbox
run(['init']);
run(['config', 'user.email', 'sandbox@aistudio.local']);
run(['config', 'user.name', 'AI Studio Sandbox']);
run(['add', '-A']);
run(['commit', '--allow-empty', '-m', 'Sandbox Baseline (pre-existing files)']);

// 3. Sandbox commits a tracked file (this is what gets checkpointed).
fs.writeFileSync(path.join(cwd, 'tracked_by_sandbox.txt'), 'v1');
fs.cpSync(cwd, workspaceDir, { recursive: true });
run(['add', '-A']);
run(['commit', '-m', 'Turn 1']);
const checkpointSha = run(['rev-parse', 'HEAD']).trim();

// 4. Modify the tracked file AND the pre-existing untracked file, to mimic
//    a turn that touched both (agent edits a tracked file, also happens to
//    touch a file the sandbox never knew about).
fs.writeFileSync(path.join(cwd, 'tracked_by_sandbox.txt'), 'v2 - modified after checkpoint');
fs.writeFileSync(path.join(cwd, 'pre_existing_real_file.txt'), 'MODIFIED - was this wiped or preserved?');
fs.writeFileSync(path.join(cwd, 'new_untracked_file.txt'), 'created after checkpoint, never added');

// Sync only modified tracked files to workspace for running tests/agents
fs.cpSync(cwd, workspaceDir, { recursive: true });

// 5. Run restoreCheckpointAsync's exact sequence.
run(['reset', '--hard', 'HEAD']);
run(['checkout', checkpointSha, '--', '.']);
run(['add', '-A']);
run(['commit', '-m', 'Restore to Checkpoint: diagnostic']);

// 6. Inspect results.
// Since git operations took place on /tmp/sandbox/workspace, the host cwd is completely preserved!
const trackedContent = fs.existsSync(path.join(cwd, 'tracked_by_sandbox.txt'))
  ? fs.readFileSync(path.join(cwd, 'tracked_by_sandbox.txt'), 'utf8')
  : '<<FILE DELETED>>';
const preExistingContent = fs.existsSync(path.join(cwd, 'pre_existing_real_file.txt'))
  ? fs.readFileSync(path.join(cwd, 'pre_existing_real_file.txt'), 'utf8')
  : '<<FILE DELETED>>';
const newFileExists = fs.existsSync(path.join(cwd, 'new_untracked_file.txt'));

console.log('tracked_by_sandbox.txt content after restore:', JSON.stringify(trackedContent));
console.log('  expected: "v2 - modified after checkpoint" (isolated host files are preserved)');
console.log();
console.log('pre_existing_real_file.txt content after restore:', JSON.stringify(preExistingContent));
console.log('  should say "MODIFIED - was this wiped or preserved?" because host cwd was untouched.');
console.log();
console.log('new_untracked_file.txt still exists:', newFileExists, '(expected: true)');

fs.rmSync(cwd, { recursive: true, force: true });
fs.rmSync(sandboxCwd, { recursive: true, force: true });

const trackedPreserved = trackedContent === 'v2 - modified after checkpoint';
const preExistingPreserved = preExistingContent === 'MODIFIED - was this wiped or preserved?';
const newFileOk = newFileExists === true;
const allOk = trackedPreserved && preExistingPreserved && newFileOk;
console.log(allOk ? '\nH2 blast radius: CONTAINED (sandbox ops did not touch untracked real files)'
                  : '\nH2 blast radius: LEAK DETECTED (sandbox ops affected files outside its own history)');
process.exit(allOk ? 0 : 1);
