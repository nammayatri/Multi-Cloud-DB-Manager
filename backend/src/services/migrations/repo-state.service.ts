import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger';
import { RepoCloneState, RepoStatus } from '../../types/migrations';

/**
 * Singleton state machine for the NammaYatri repo clone.
 *
 * Replaces the K8s init container: instead of blocking pod startup on a
 * 2-minute git clone, the main container kicks off the clone in the background
 * after starting. Migration endpoints gate on this state — they return 503 with
 * a structured status so the UI can show a "cloning…" overlay instead of
 * surfacing a cryptic git error.
 */
class RepoStateService {
  private state: RepoCloneState = 'NOT_STARTED';
  private startedAt: Date | null = null;
  private finishedAt: Date | null = null;
  private errorMessage: string | null = null;
  private cloneInFlight: Promise<void> | null = null;

  public getStatus(repoPath: string): RepoStatus {
    return {
      state: this.state,
      repoPath,
      startedAt: this.startedAt?.toISOString(),
      finishedAt: this.finishedAt?.toISOString(),
      error: this.errorMessage ?? undefined,
      message: this.statusMessage(),
    };
  }

  public isReady(): boolean {
    return this.state === 'READY';
  }

  /**
   * Trigger a clone (or no-op fetch) in the background. Idempotent: if a clone
   * is already in flight or the repo is READY, this returns the existing task.
   *
   * Behaviour:
   *  - If repoPath/.git exists → set READY immediately, fire `git fetch` async
   *  - Else if repoUrl provided → run `git clone` async, set READY on success
   *  - Else → mark ERROR (can't proceed without URL)
   */
  public ensureCloned(repoPath: string, repoUrl: string | undefined): Promise<void> {
    if (this.cloneInFlight) return this.cloneInFlight;
    if (this.state === 'READY') return Promise.resolve();

    this.cloneInFlight = this.runClone(repoPath, repoUrl)
      .finally(() => {
        this.cloneInFlight = null;
      });
    return this.cloneInFlight;
  }

  private async runClone(repoPath: string, repoUrl: string | undefined): Promise<void> {
    // Already cloned: just mark ready and fire a non-blocking fetch
    if (fs.existsSync(path.join(repoPath, '.git'))) {
      logger.info('Repo already present, marking READY', { repoPath });
      this.markReady();
      this.fireBackgroundFetch(repoPath); // best-effort fetch in background
      return;
    }

    if (!repoUrl) {
      this.markError(
        `Repo not present at ${repoPath} and no repoUrl configured. ` +
          `Set migrations.repoUrl in databases.json or pre-clone the repo.`
      );
      return;
    }

    this.startedAt = new Date();
    this.state = 'CLONING';
    this.errorMessage = null;
    this.finishedAt = null;
    logger.info(`Cloning repo into ${repoPath}`, { repoUrl, repoPath });

    try {
      // Make sure parent dir exists
      const parent = path.dirname(repoPath);
      if (!fs.existsSync(parent)) {
        fs.mkdirSync(parent, { recursive: true });
      }

      // git clone <url> <repoPath>. Use spawn-style execFile (no shell) for safety.
      await new Promise<void>((resolve, reject) => {
        const proc = execFile(
          'git',
          ['clone', repoUrl, repoPath],
          { maxBuffer: 64 * 1024 * 1024 },
          (err) => (err ? reject(err) : resolve())
        );
        proc.on('error', reject);
      });

      logger.info('Repo clone completed', { repoPath, durationMs: Date.now() - this.startedAt.getTime() });
      this.markReady();
    } catch (err: any) {
      const msg = err?.message || 'Unknown error';
      logger.error('Repo clone failed', { repoPath, repoUrl, error: msg });
      this.markError(`git clone failed: ${msg}`);
    }
  }

  private fireBackgroundFetch(repoPath: string): void {
    execFile('git', ['fetch', '--all', '--prune'], { cwd: repoPath }, (err) => {
      if (err) {
        logger.warn('Background git fetch failed (non-fatal)', { repoPath, error: err.message });
      } else {
        logger.info('Background git fetch completed', { repoPath });
      }
    });
  }

  private markReady(): void {
    this.state = 'READY';
    this.finishedAt = new Date();
    this.errorMessage = null;
  }

  private markError(msg: string): void {
    this.state = 'ERROR';
    this.finishedAt = new Date();
    this.errorMessage = msg;
  }

  private statusMessage(): string {
    switch (this.state) {
      case 'NOT_STARTED':
        return 'Clone has not been triggered yet.';
      case 'CLONING':
        return `Cloning NammaYatri repo… (started ${this.startedAt?.toISOString() ?? 'unknown'}). This usually takes 1–3 minutes per pod startup.`;
      case 'READY':
        return 'Repo is ready.';
      case 'ERROR':
        return `Clone failed: ${this.errorMessage ?? 'unknown error'}. Hit POST /api/migrations/refresh-repo to retry.`;
    }
  }

  /** Reset state and trigger a fresh clone — used by the manual retry endpoint. */
  public retry(repoPath: string, repoUrl: string | undefined): Promise<void> {
    this.state = 'NOT_STARTED';
    this.errorMessage = null;
    this.startedAt = null;
    this.finishedAt = null;
    return this.ensureCloned(repoPath, repoUrl);
  }
}

export default new RepoStateService();
