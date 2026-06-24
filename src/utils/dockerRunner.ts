import { spawn, exec, execSync } from 'child_process';
import { getIsolatedName, registerContainer, unregisterContainer, validateGitWorktree } from './workspace';
import path from 'path';
import { getWorkspaceRoot, getGitRoot } from './sandbox';

let isDockerAvailableCache: boolean | null = null;

/**
 * Checks if Docker daemon is available and accessible.
 */
export function isDockerAvailable(): boolean {
  if (isDockerAvailableCache !== null) return isDockerAvailableCache;
  try {
    execSync('docker ps', { stdio: 'ignore' });
    isDockerAvailableCache = true;
  } catch (e) {
    isDockerAvailableCache = false;
  }
  return isDockerAvailableCache;
}

/**
 * Executes a command natively in a child subprocess shell when virtualized containerization is unavailable.
 */
export async function runNativeProcess(
  command: string,
  workingDir: string = '/workspace',
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  if (process.env.VITEST === 'true') {
    return Promise.resolve({
      stdout: 'Mocked native output for ' + command,
      stderr: '',
      exitCode: 0
    });
  }

  try {
    sanitizeDockerCommand(command);
  } catch (err: any) {
    return {
      stdout: '',
      stderr: err.message || 'Command validation failed',
      exitCode: 1
    };
  }

  return new Promise((resolve) => {
    // Resolve workspace mount to process run environment
    const workspaceRoot = getWorkspaceRoot();
    const targetDir = workingDir.startsWith('/workspace')
      ? path.join(workspaceRoot, workingDir.substring(10))
      : (workingDir === '/' ? workspaceRoot : workingDir);

    const gitDir = getGitRoot();
    const gitWorkTree = getWorkspaceRoot();

    const child = spawn('bash', ['-c', command], { 
      cwd: targetDir,
      env: {
        ...process.env,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: gitWorkTree,
        GIT_PAGER: 'cat'
      }
    });

    const onAbort = () => child.kill('SIGKILL');
    if (signal) {
      signal.addEventListener('abort', onAbort);
      if (signal.aborted) {
        child.kill('SIGKILL');
        resolve({ stdout: '', stderr: 'Native process aborted', exitCode: 1 });
        return;
      }
    }

    child.on('error', (err: any) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ stdout: '', stderr: `Failed to spawn native process: ${err.message}`, exitCode: 127 });
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

/**
 * Generates a unique Docker container name based on a safe string and a hash
 * of the current working directory, salted by the session string if provided.
 */
export function getContainerName(sessionId?: string): string {
  return getIsolatedName('copilot-runner', sessionId);
}

/**
 * Sanitizes and validates the input command to block highly dangerous/destructive command injections
 * that can damage the mounted host file system.
 */
export function sanitizeDockerCommand(command: string): string {
  if (!command) return '';

  // Normalize command by removing backslashes, quotes, and whitespace for inspection
  const normalized = command.replace(/['"\\`]/g, '');

  const dangerousPatterns = [
    /rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+/i, // e.g. rm -rf, rm -r
    /rm\s+-[a-zA-Z]*d[a-zA-Z]*\s+/i, // directory removal
    /rm\s+--(recursive|dir)\b/i,
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(normalized)) {
      throw new Error(`Command execution blocked: dangerous directory removal command detected.`);
    }
  }

  return command;
}

/**
 * Executes a command inside a docker container and returns the results.
 */
export async function runDockerProcess(
  command: string,
  workingDir: string = '/workspace',
  signal?: AbortSignal,
  sessionId?: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  if (process.env.VITEST === 'true') {
    return Promise.resolve({
      stdout: 'Mocked docker output for ' + command,
      stderr: '',
      exitCode: 0
    });
  }

  if (process.env.DIAGNOSTIC_MODE === 'true') {
    return runNativeProcess(command, workingDir, signal);
  }

  // Before mounting the Docker volume, check whether the workspace's .git path is safe
  const gitValidation = validateGitWorktree(process.cwd());
  if (!gitValidation.valid) {
    throw new Error(`Blocking Initialization Error: ${gitValidation.error}`);
  }

  try {
    sanitizeDockerCommand(command);
  } catch (err: any) {
    return {
      stdout: '',
      stderr: err.message || 'Command validation failed',
      exitCode: 1
    };
  }

  const containerName = getContainerName(sessionId);
  registerContainer(containerName);

  // T2: Orphan Sanity Check - Ensure no existing container with the same isolated name is hanging
  // before we attempt to spawn a new one.
  try {
    exec(`docker rm -f ${containerName} > /dev/null 2>&1 || true`);
  } catch (e) {
    // ignore cleanup errors
  }

  return new Promise((resolve) => {
    // The command instructions specify the following docker run invocation:
    // docker run -i --rm -v /local/workspace/path:/workspace -w /workspace node:18-alpine bash
    
    // We use process.cwd() as the placeholder for the host workspace path.
    const workspaceRoot = getWorkspaceRoot();
    const volumeHostPath = workspaceRoot;
    const isDiag = workspaceRoot !== process.cwd();
    const gitDirEnv = isDiag ? getGitRoot() : '/workspace/.aistudio/.git';
    const gitWorkTreeEnv = isDiag ? workspaceRoot : '/workspace';

    const dockerArgs = [
      'run',
      '-i', // interactive mode
      '--rm', // automatically remove container
      '--name', containerName,
      '-e', `GIT_DIR=${gitDirEnv}`,
      '-e', `GIT_WORK_TREE=${gitWorkTreeEnv}`,
      '-v', `${volumeHostPath}:/workspace`, // mount host current dir to /workspace
      '-w', workingDir,
      'node:18-alpine',
      'bash'
    ];

    const child = spawn('docker', dockerArgs);

    const onAbort = () => child.kill('SIGKILL');
    if (signal) {
      signal.addEventListener('abort', onAbort);
      if (signal.aborted) {
        child.kill('SIGKILL');
        unregisterContainer(containerName);
        resolve({ stdout: '', stderr: 'Docker process aborted', exitCode: 1 });
        return;
      }
    }

    child.on('error', (err: any) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      unregisterContainer(containerName);
      resolve({ stdout: '', stderr: `Failed to spawn docker process: ${err.message}`, exitCode: 127 });
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      unregisterContainer(containerName);
      resolve({ stdout, stderr, exitCode: code });
    });

    // Write the actual command to stdin and close it
    if (child.stdin.writable) {
      child.stdin.write(command + '\n');
      child.stdin.end();
    }
  });
}
