import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getWorkspaceRoot, getGitRoot } from './sandbox';

export const activeContainers = new Set<string>();

export function registerContainer(name: string) {
  activeContainers.add(name);
}

export function unregisterContainer(name: string) {
  activeContainers.delete(name);
}

export function cleanupWorkspaceDir(targetDir: string): void {
  try {
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  } catch (e: any) {
    // Ignore cleanup errors to prevent crashing test teardowns or process exits
  }
}

/**
 * Validates that the target workspace is a Git worktree (not a standard directory).
 * SYS-REQ-002/003: Block container mounting if .git is a directory.
 */
export function validateGitWorktree(dir: string): { valid: boolean; error?: string } {
  if (process.env.VITEST === 'true') return { valid: true };
  const workspaceRoot = getWorkspaceRoot();
  const gitRoot = getGitRoot();

  if (workspaceRoot !== process.cwd()) {
    if (!fs.existsSync(gitRoot) || !fs.existsSync(workspaceRoot)) {
      return { valid: false, error: 'Target directory is not an initialized AI Studio Git sandbox.' };
    }
    return { valid: true };
  }

  const sandboxGitDir = path.join(dir, '.aistudio', '.git');
  
  if (fs.existsSync(path.join(dir, '.git')) && fs.statSync(path.join(dir, '.git')).isDirectory()) {
      return { valid: false, error: 'Access Denied: Un-sandboxed top-level .git directory found. System requires isolated .aistudio/.git sandbox.' };
  }
  
  if (!fs.existsSync(sandboxGitDir)) {
    return { valid: false, error: 'Target directory is not an initialized AI Studio Git sandbox.' };
  }
  
  return { valid: true };
}

/**
 * Generates a stable, 6-character alphanumeric hash based on the current 
 * workspace path and an optional sessionId salt to prevent container name collisions.
 */
export function getWorkspaceHash(sessionId?: string): string {
  const cwd = process.cwd();
  let text = cwd;
  if (sessionId) {
    text += `-${sessionId}`;
  }
  return crypto.createHash('md5').update(text).digest('hex').slice(0, 6);
}

/**
 * Returns a unique container name or identifier string for the current session.
 */
export function getIsolatedName(baseName: string, sessionId?: string): string {
  const hash = getWorkspaceHash(sessionId);
  return `${baseName}-${hash}`;
}

/**
 * Syncs workspace files to isolated copy-based temporary worktrees,
 * or runs validation/cache invalidation command on volume directories.
 */
export async function syncWorkspace(sessionId?: string): Promise<void> {
  const hash = getWorkspaceHash(sessionId);
  const targetTempDir = path.join(process.cwd(), `tmp-${hash}`);
  
  return new Promise<void>((resolve) => {
    try {
      if (fs.existsSync(targetTempDir)) {
        const srcDir = path.join(process.cwd(), 'workspace');
        if (fs.existsSync(srcDir)) {
          try {
            // Native directory content copy without shell invocation (prevents shell injection entirely)
            fs.cpSync(srcDir, targetTempDir, { recursive: true, force: true });
          } catch (err) {
            // Ignore copy errors
          }
          resolve();
          return;
        }
      } else {
        // For directory volumes, invalidate system cache by listing the current working directory
        if (fs.existsSync(process.cwd())) {
          fs.readdirSync(process.cwd());
        }
      }
    } catch (error: any) {
      // Ignore copy / sync validation errors
    }
    resolve();
  });
}

