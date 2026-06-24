import { execFile, execFileSync, spawnSync } from 'child_process';
import * as util from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { getWorkspaceRoot, getGitRoot } from './sandbox';

const execFileAsync = util.promisify(execFile);

export const DEFAULT_GIT_DIR_NAME = '.aistudio';

function isMockGit(): boolean {
  return process.env.VITEST === 'true' && process.env.REAL_GIT_TEST !== 'true';
}

/**
 * Validates the working directory to prevent accidentally running git
 * commands in the host repo (e.g. root workspace without `.aistudio`),
 * which can cause destructive operations wiping the actual project.
 */
export function getGitEnv(cwd: string) {
  const workspaceRoot = getWorkspaceRoot();
  const gitRoot = getGitRoot();

  const isMainWorkspace = path.resolve(cwd) === path.resolve(workspaceRoot);

  if (isMainWorkspace) {
    return {
      ...process.env,
      GIT_DIR: gitRoot,
      GIT_WORK_TREE: workspaceRoot,
      GIT_PAGER: 'cat'
    };
  }

  return {
    ...process.env,
    GIT_DIR: path.join(cwd, DEFAULT_GIT_DIR_NAME, '.git'),
    GIT_WORK_TREE: cwd,
    GIT_PAGER: 'cat'
  };
}

/**
 * Prepares the sandbox git environment if it does not already exist.
 */
export async function initializeGitSandboxAsync(cwd: string): Promise<void> {
  const env = getGitEnv(cwd);
  const gitDir = env.GIT_DIR;
  const workTree = env.GIT_WORK_TREE;
  if (!fs.existsSync(gitDir)) {
    fs.mkdirSync(path.dirname(gitDir), { recursive: true });
    fs.mkdirSync(workTree, { recursive: true });

    const excludeDir = path.join(gitDir, 'info');
    fs.mkdirSync(excludeDir, { recursive: true });
    fs.writeFileSync(path.join(excludeDir, 'exclude'), `${DEFAULT_GIT_DIR_NAME}/\n`);
    
    // Create the dummy .git folder to satisfy validateGitWorktree if in test
    if (isMockGit()) {
      fs.mkdirSync(gitDir, { recursive: true });
      return;
    }

    await execFileAsync('git', ['init'], { cwd: workTree, env });
    await execFileAsync('git', ['config', 'user.email', 'sandbox@aistudio.local'], { cwd: workTree, env });
    await execFileAsync('git', ['config', 'user.name', 'AI Studio Sandbox'], { cwd: workTree, env });
    await execFileAsync('git', ['add', '-A'], { cwd: workTree, env }).catch(() => {});
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'Sandbox Baseline (pre-existing files)'], { cwd: workTree, env }).catch(() => {});
  }
}

export function initializeGitSandboxSync(cwd: string): void {
  const env = getGitEnv(cwd);
  const gitDir = env.GIT_DIR;
  const workTree = env.GIT_WORK_TREE;
  if (!fs.existsSync(gitDir)) {
    fs.mkdirSync(path.dirname(gitDir), { recursive: true });
    fs.mkdirSync(workTree, { recursive: true });

    const excludeDir = path.join(gitDir, 'info');
    fs.mkdirSync(excludeDir, { recursive: true });
    fs.writeFileSync(path.join(excludeDir, 'exclude'), `${DEFAULT_GIT_DIR_NAME}/\n`);

    // Create the dummy .git folder to satisfy validateGitWorktree if in test
    if (isMockGit()) {
      fs.mkdirSync(gitDir, { recursive: true });
      return;
    }

    execFileSync('git', ['init'], { cwd: workTree, env });
    execFileSync('git', ['config', 'user.email', 'sandbox@aistudio.local'], { cwd: workTree, env });
    execFileSync('git', ['config', 'user.name', 'AI Studio Sandbox'], { cwd: workTree, env });
    try { execFileSync('git', ['add', '-A'], { cwd: workTree, env }); } catch (e) {}
    try { execFileSync('git', ['commit', '--allow-empty', '-m', 'Sandbox Baseline (pre-existing files)'], { cwd: workTree, env }); } catch (e) {}
  }
}

export async function getGitDiffHead(cwd: string): Promise<string> {
  if (isMockGit()) return 'MOCK_DIFF_HEAD';
  const env = getGitEnv(cwd);
  try {
    const { stdout } = await execFileAsync('git', ['diff', 'HEAD'], { cwd: env.GIT_WORK_TREE, env });
    return stdout;
  } catch (e: any) {
    return e.stdout?.toString() || '';
  }
}

export async function getGitDiffHeadNumstat(cwd: string): Promise<string> {
  if (isMockGit()) return '1\t1\tmock_file.ts';
  const env = getGitEnv(cwd);
  try {
    const { stdout } = await execFileAsync('git', ['diff', 'HEAD', '--numstat'], { cwd: env.GIT_WORK_TREE, env });
    return stdout;
  } catch (e: any) {
    return e.stdout?.toString() || '';
  }
}

export async function commitAllChangesAsync(cwd: string, message: string): Promise<string> {
  if (isMockGit()) return 'MOCK_SHA';
  const env = getGitEnv(cwd);
  await execFileAsync('git', ['add', '-A'], { cwd: env.GIT_WORK_TREE, env });
  await execFileAsync('git', ['commit', '-m', message], { cwd: env.GIT_WORK_TREE, env }).catch(() => {});
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: env.GIT_WORK_TREE, env });
  return stdout.trim();
}

export function commitAllChangesSync(cwd: string, message: string): string {
  if (isMockGit()) return 'MOCK_SHA';
  const env = getGitEnv(cwd);
  execFileSync('git', ['add', '-A'], { cwd: env.GIT_WORK_TREE, env });
  try { execFileSync('git', ['commit', '-m', message], { cwd: env.GIT_WORK_TREE, env }); } catch(err) {}
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env.GIT_WORK_TREE, env }).toString().trim();
}

export async function restoreCheckpointAsync(cwd: string, commitSha: string, message: string): Promise<void> {
  if (isMockGit()) return;
  const env = getGitEnv(cwd);

  // 1. Get the original HEAD SHA so we can move back to it later
  const { stdout: headShaOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: env.GIT_WORK_TREE, env });
  const originalHeadSha = headShaOut.trim();

  // 2. Perform reset --hard to commitSha. This cleans the working directory and index to exactly commitSha.
  // This will cleanly delete any files that exist now but didn't exist at commitSha.
  await execFileAsync('git', ['reset', '--hard', commitSha], { cwd: env.GIT_WORK_TREE, env });

  // 3. Move HEAD back to originalHeadSha using a --soft reset. This does not touch the working tree or index.
  // So the working tree and index remain exactly as they were (matching commitSha).
  await execFileAsync('git', ['reset', '--soft', originalHeadSha], { cwd: env.GIT_WORK_TREE, env });

  // 4. Run git clean -fd to clean any untracked directories/files that might be left over from reset.
  await execFileAsync('git', ['clean', '-fd'], { cwd: env.GIT_WORK_TREE, env });

  // 5. Stage all changes. Since the index is still matching commitSha, this is technically already staged,
  // but running add -A ensures everything is in sync.
  await execFileAsync('git', ['add', '-A'], { cwd: env.GIT_WORK_TREE, env });

  // 6. Commit the changes to keep the history linear and HEAD where it was.
  await execFileAsync('git', ['commit', '-m', message], { cwd: env.GIT_WORK_TREE, env }).catch(() => {});
}

export function getGitDiffSync(cwd: string): string {
  if (isMockGit()) return 'MOCK_DIFF';
  const env = getGitEnv(cwd);
  try {
    const res = spawnSync('git', ['--no-pager', 'diff'], { 
      cwd: env.GIT_WORK_TREE, 
      env,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (res.error) throw res.error;
    return res.stdout ? res.stdout.toString() : '';
  } catch (e: any) {
    return '';
  }
}

export async function getGitDiffAsync(cwd: string): Promise<string> {
  if (isMockGit()) return 'MOCK_DIFF';
  const env = getGitEnv(cwd);
  try {
    const { stdout } = await execFileAsync('git', ['--no-pager', 'diff'], { 
      cwd: env.GIT_WORK_TREE, 
      env,
      timeout: 5000
    });
    return stdout;
  } catch (e: any) {
    return e.stdout?.toString() || '';
  }
}

export async function getHeadShaAsync(cwd: string): Promise<string> {
  if (isMockGit()) return 'MOCK_SHA';
  const env = getGitEnv(cwd);
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: env.GIT_WORK_TREE, env });
    return stdout.trim();
  } catch (e: any) {
    return '';
  }
}
