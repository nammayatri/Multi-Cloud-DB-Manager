import { execFileSync } from 'child_process';
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
    execFileSync('git', ['fetch', '--all'], {
      ...execOpts(repoPath),
      stdio: 'ignore',
    });
    logger.info('Git fetch --all completed', { repoPath });
  } catch (err: any) {
    logger.warn('Git fetch --all failed (non-fatal)', { repoPath, error: err.message });
  }
}

/**
 * Fetch all remotes to get latest changes.
 * Only fetches — does not modify the working tree.
 */
export function pullLatest(repoPath: string): void {
  try {
    execFileSync('git', ['fetch', '--all', '--prune'], {
      ...execOpts(repoPath),
      stdio: 'ignore',
    });
    logger.info('Git fetch --all completed', { repoPath });
  } catch (err: any) {
    logger.warn('Git fetch --all failed (non-fatal)', { repoPath, error: err.message });
  }
}

function validateRef(ref: string): void {
  if (!ref || !SAFE_REF_REGEX.test(ref)) {
    throw new Error(`Invalid git ref: "${ref}". Only alphanumeric characters, dots, hyphens, underscores, and slashes are allowed.`);
  }
}

function validatePath(filePath: string): void {
  // Reject path traversal, command injection, newlines, nulls, and flag-like paths
  if (!filePath || /[;&|`$\n\r\0]/.test(filePath) || filePath.includes('..') || filePath.startsWith('-')) {
    throw new Error(`Invalid file path: "${filePath}".`);
  }
}

const execOpts = (repoPath: string) => ({
  encoding: 'utf8' as const,
  cwd: repoPath,
  timeout: 30000,
  // Large migration snapshot files must not be silently truncated. The default
  // 1 MB buffer would make `git show` throw ENOBUFS mid-file, dropping
  // statements from the analysis. 64 MB is far above any real migration file.
  maxBuffer: 64 * 1024 * 1024,
});

/**
 * Merge-base of two refs — the common ancestor. `git diff A...B` (three-dot,
 * used for the changed-file list) is equivalent to `diff merge-base(A,B) B`, so
 * per-file statement diffing must use the SAME base to stay consistent. Falls
 * back to `fromRef` if the merge-base can't be computed (e.g. unrelated
 * histories or a shallow clone missing the ancestor).
 */
export function getMergeBase(repoPath: string, fromRef: string, toRef: string): string {
  validateRef(fromRef);
  validateRef(toRef);
  try {
    const out = execFileSync('git', ['merge-base', fromRef, toRef], execOpts(repoPath));
    const base = out.trim();
    return base || fromRef;
  } catch (err: any) {
    logger.warn('git merge-base failed — falling back to fromRef', {
      fromRef, toRef, error: err.message,
    });
    return fromRef;
  }
}

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
    const args = ['diff', '--name-only', '--diff-filter=ACMR', `${fromRef}...${toRef}`];
    if (migrationSubdir) {
      args.push('--', migrationSubdir);
    }
    const output = execFileSync('git', args, execOpts(repoPath));

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
    return execFileSync('git', ['show', `${ref}:${filePath}`], execOpts(repoPath));
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
 * Like getFileContent, but returns '' instead of throwing/logging when the file
 * does not exist at that ref. Used for the diff baseline, where a file being
 * absent at the merge-base is the EXPECTED "newly added file" case (all of its
 * statements then count as added) — not an error worth logging.
 */
export function getFileContentOrEmpty(repoPath: string, ref: string, filePath: string): string {
  validateRef(ref);
  validatePath(filePath);
  try {
    return execFileSync('git', ['show', `${ref}:${filePath}`], execOpts(repoPath));
  } catch {
    return '';
  }
}

/**
 * Get recent branches and tags for autocomplete.
 */
export function getRecentRefs(repoPath: string): { branches: string[]; tags: string[] } {
  try {
    const branchOutput = execFileSync(
      'git',
      ['branch', '-r', '--sort=-committerdate', '--format=%(refname:short)'],
      execOpts(repoPath)
    );
    const branches = branchOutput
      .split('\n')
      .map(b => b.trim())
      .filter(b => b.length > 0)
      .slice(0, 50);

    const tagOutput = execFileSync(
      'git',
      ['tag', '--sort=-version:refname'],
      execOpts(repoPath)
    );
    const tags = tagOutput
      .split('\n')
      .map(t => t.trim())
      .filter(t => t.length > 0)
      .slice(0, 30);

    return { branches, tags };
  } catch (err: any) {
    logger.error('Failed to get recent refs from git', { error: err.message });
    throw new Error(`Git refs failed: ${err.message}`);
  }
}
