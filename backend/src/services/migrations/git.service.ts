import { execSync } from 'child_process';
import fs from 'fs';
import logger from '../../utils/logger';

const SAFE_REF_REGEX = /^[a-zA-Z0-9._\-/]+$/;

/**
 * Ensure the repo exists and is a git repo. Fetches latest refs if it exists.
 * We don't auto-clone for security reasons.
 */
export function ensureRepo(repoPath: string, repoUrl?: string): void {
  if (!fs.existsSync(repoPath)) {
    logger.warn(`Repo path does not exist: ${repoPath}. Please clone the repo manually.`, { repoPath, repoUrl });
    return;
  }

  const gitDir = `${repoPath}/.git`;
  if (!fs.existsSync(gitDir)) {
    logger.warn(`Path exists but is not a git repo: ${repoPath}`, { repoPath });
    return;
  }

  try {
    execSync('git fetch --all', {
      ...execOpts(repoPath),
      stdio: 'ignore',
    });
    logger.info('Git fetch --all completed', { repoPath });
  } catch (err: any) {
    logger.warn('Git fetch --all failed (non-fatal)', { repoPath, error: err.message });
  }
}

/**
 * Fetch all remotes + pull current branch to get latest changes.
 */
export function pullLatest(repoPath: string): void {
  try {
    // Fetch all remote refs and objects
    execSync('git fetch --all --prune', {
      ...execOpts(repoPath),
      stdio: 'ignore',
    });
    logger.info('Git fetch --all completed', { repoPath });
  } catch (err: any) {
    logger.warn('Git fetch --all failed (non-fatal)', { repoPath, error: err.message });
  }

  try {
    // Pull current branch to update local HEAD
    execSync('git pull --ff-only', {
      ...execOpts(repoPath),
      stdio: 'ignore',
    });
    logger.info('Git pull completed', { repoPath });
  } catch (err: any) {
    // Pull can fail if there are local changes or diverged branches — non-fatal
    logger.warn('Git pull --ff-only failed (non-fatal, local branch may be diverged)', { repoPath, error: err.message });
  }
}

function validateRef(ref: string): void {
  if (!ref || !SAFE_REF_REGEX.test(ref)) {
    throw new Error(`Invalid git ref: "${ref}". Only alphanumeric characters, dots, hyphens, underscores, and slashes are allowed.`);
  }
}

function validatePath(filePath: string): void {
  // Reject path traversal and command injection — allow typical file path chars
  if (!filePath || /[;&|`$]/.test(filePath) || filePath.includes('..')) {
    throw new Error(`Invalid file path: "${filePath}".`);
  }
}

const execOpts = (repoPath: string) => ({
  encoding: 'utf8' as const,
  cwd: repoPath,
  timeout: 30000,
});

/**
 * Get list of changed files between two git refs.
 * If migrationSubdir is provided, scopes to that directory.
 * Returns all file types (not just .sql).
 */
export function getChangedFiles(
  repoPath: string,
  migrationSubdir: string | undefined,
  fromRef: string,
  toRef: string
): string[] {
  validateRef(fromRef);
  validateRef(toRef);

  try {
    const pathFilter = migrationSubdir ? ` -- "${migrationSubdir}"` : '';
    const output = execSync(
      `git diff --name-only --diff-filter=ACMR ${fromRef}...${toRef}${pathFilter}`,
      execOpts(repoPath)
    );

    return output
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  } catch (err: any) {
    logger.error('Failed to get changed files from git', {
      fromRef,
      toRef,
      migrationSubdir,
      error: err.message,
    });
    throw new Error(`Git diff failed: ${err.message}`);
  }
}

/**
 * Get file content at a specific git ref.
 */
export function getFileContent(repoPath: string, ref: string, filePath: string): string {
  validateRef(ref);
  validatePath(filePath);

  try {
    return execSync(
      `git show ${ref}:${filePath}`,
      execOpts(repoPath)
    );
  } catch (err: any) {
    logger.error('Failed to get file content from git', {
      ref,
      filePath,
      error: err.message,
    });
    throw new Error(`Git show failed for ${filePath}@${ref}: ${err.message}`);
  }
}

/**
 * Get recent branches and tags for autocomplete.
 */
export function getRecentRefs(repoPath: string): { branches: string[]; tags: string[] } {
  try {
    const branchOutput = execSync(
      'git branch -r --sort=-committerdate --format="%(refname:short)" | head -50',
      { ...execOpts(repoPath), shell: '/bin/bash' }
    );
    const branches = branchOutput
      .split('\n')
      .map(b => b.trim())
      .filter(b => b.length > 0);

    const tagOutput = execSync(
      'git tag --sort=-version:refname | head -30',
      execOpts(repoPath)
    );
    const tags = tagOutput
      .split('\n')
      .map(t => t.trim())
      .filter(t => t.length > 0);

    return { branches, tags };
  } catch (err: any) {
    logger.error('Failed to get recent refs from git', { error: err.message });
    throw new Error(`Git refs failed: ${err.message}`);
  }
}
