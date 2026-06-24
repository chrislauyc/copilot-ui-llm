import * as path from 'path';

/**
 * Resolves the default workspace containment fallback directory when no explicit path is provided.
 * In diagnostic mode, this is '/tmp/sandbox/workspace'.
 * Otherwise, it refers to the isolated 'workspace' subdirectory under the project root.
 */
export function getDefaultWorkspaceDir(): string {
  if (process.env.DIAGNOSTIC_MODE === 'true') {
    return '/tmp/sandbox/workspace';
  }
  return path.join(process.cwd(), 'workspace');
}

/**
 * Resolves the workspace root path.
 * Returns '/tmp/sandbox/workspace' in diagnostic mode, otherwise process.cwd().
 */
export function getWorkspaceRoot(): string {
  if (process.env.DIAGNOSTIC_MODE === 'true') {
    return '/tmp/sandbox/workspace';
  }
  return process.cwd();
}

/**
 * Resolves the git directory location.
 * Returns '/tmp/sandbox/.git' in diagnostic mode, otherwise the standard '.aistudio/.git' location.
 */
export function getGitRoot(): string {
  if (process.env.DIAGNOSTIC_MODE === 'true') {
    return '/tmp/sandbox/.git';
  }
  return path.join(process.cwd(), '.aistudio', '.git');
}
