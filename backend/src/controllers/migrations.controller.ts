import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import * as migrationsService from '../services/migrations/migrations.service';
import * as gitService from '../services/migrations/git.service';
import repoState from '../services/migrations/repo-state.service';
import * as liteDiffService from '../services/migrations/lite-diff.service';

/**
 * If the repo isn't ready yet, short-circuit with a 503 carrying structured
 * status so the UI can render a clear "cloning…" overlay. Returns true if the
 * response was already sent (caller should bail).
 */
function gateOnRepoReady(res: Response, repoPath: string): boolean {
  if (repoState.isReady()) return false;
  const status = repoState.getStatus(repoPath);
  res.status(503).json({
    error: 'Repo not ready',
    repoStatus: status,
  });
  return true;
}

/**
 * GET /api/migrations/config
 * Returns available environments and databases (no secrets).
 */
export const getConfig = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    // Strip repoPath AND repoUrl — repoUrl embeds the git credential in
    // deployments (https://x-access-token:<PAT>@github.com/...), so returning it
    // would disclose the token to any authenticated user. Both are internal-only.
    const { repoPath, repoUrl, ...safeConfig } = migrationsService.getConfig();
    res.json({ success: true, ...safeConfig });
  } catch (error: any) {
    logger.error('Failed to load migration config:', error);
    next(error);
  }
};

/**
 * GET /api/migrations/refs
 * Returns recent branches and tags from the configured repo.
 */
export const getRefs = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const config = migrationsService.getConfig();
    if (gateOnRepoReady(res, config.repoPath)) return;
    gitService.pullLatest(config.repoPath);
    const refs = gitService.getRecentRefs(config.repoPath);
    res.json({ success: true, ...refs });
  } catch (error: any) {
    logger.error('Failed to get git refs:', error);
    next(error);
  }
};

/**
 * GET /api/migrations/repo-status
 * Lightweight poll endpoint — UI uses this to decide whether to show the
 * "cloning repo…" overlay or render the Migrations panel.
 */
export const getRepoStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const config = migrationsService.getConfig();
    res.json(repoState.getStatus(config.repoPath));
  } catch (error: any) {
    logger.error('Failed to get repo status:', error);
    next(error);
  }
};

/**
 * POST /api/migrations/analyze
 * Run the full migration analysis pipeline.
 * Body: { fromRef, toRef, environment, databaseFilter? }
 */
export const analyze = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { fromRef, toRef, environment, database: databaseFilter } = req.body;

    if (!fromRef || typeof fromRef !== 'string') {
      return res.status(400).json({ error: 'fromRef is required' });
    }
    if (!toRef || typeof toRef !== 'string') {
      return res.status(400).json({ error: 'toRef is required' });
    }
    if (!environment || typeof environment !== 'string') {
      return res.status(400).json({ error: 'environment is required' });
    }
    if (fromRef.length > 200) {
      return res.status(400).json({ error: 'fromRef too long' });
    }
    if (toRef.length > 200) {
      return res.status(400).json({ error: 'toRef too long' });
    }
    if (environment.length > 200) {
      return res.status(400).json({ error: 'environment too long' });
    }

    logger.info('Migration analysis requested', {
      user: (req.user as any)?.username,
      fromRef,
      toRef,
      environment,
      databaseFilter,
    });

    const cfg = migrationsService.getConfig();
    if (gateOnRepoReady(res, cfg.repoPath)) return;

    const result = await migrationsService.analyze(fromRef, toRef, environment, databaseFilter);
    res.json(result);
  } catch (error: any) {
    logger.error('Migration analysis failed:', error);
    next(error);
  }
};

/**
 * POST /api/migrations/refresh-repo
 * Runs git fetch --all --prune on the configured repo. If the initial clone
 * is still in progress, this returns the current clone status. If a previous
 * clone errored, this triggers a fresh clone attempt.
 */
export const refreshRepo = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const config = migrationsService.getConfig();

    // If a prior clone errored, retry from scratch.
    const status = repoState.getStatus(config.repoPath);
    if (status.state === 'ERROR' || status.state === 'NOT_STARTED') {
      repoState.retry(config.repoPath, config.repoUrl).catch(() => { /* logged inside */ });
      res.json({ success: true, message: 'Clone retry triggered', repoStatus: repoState.getStatus(config.repoPath) });
      return;
    }

    if (gateOnRepoReady(res, config.repoPath)) return;

    gitService.pullLatest(config.repoPath);
    res.json({ success: true, message: 'Repository refreshed (git fetch --all --prune)' });
  } catch (error: any) {
    logger.error('Failed to refresh repo:', error);
    next(error);
  }
};

/**
 * GET /api/migrations/file?ref=xxx&path=yyy
 * Returns raw SQL content of a single file at a given ref.
 */
export const getFileContent = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { ref, path: filePath } = req.query;

    if (!ref || typeof ref !== 'string') {
      return res.status(400).json({ error: 'ref query parameter is required' });
    }
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ error: 'path query parameter is required' });
    }
    if (ref.length > 200) {
      return res.status(400).json({ error: 'ref too long' });
    }
    if (filePath.length > 500) {
      return res.status(400).json({ error: 'path too long' });
    }

    // Validate that the requested path is under a configured migration path
    const config = migrationsService.getConfig();
    if (gateOnRepoReady(res, config.repoPath)) return;
    const isAllowedPath = config.pathMapping.some(
      (mapping) => filePath.startsWith(mapping.path + '/') || filePath === mapping.path
    );
    if (!isAllowedPath) {
      return res.status(403).json({ error: 'Requested path is not within a configured migration directory' });
    }

    const content = gitService.getFileContent(config.repoPath, ref, filePath);
    res.json({ success: true, ref, path: filePath, content });
  } catch (error: any) {
    logger.error('Failed to get file content:', error);
    next(error);
  }
};

/**
 * POST /api/migrations/lite-diff
 * Resolve a GitHub compare URL into the SQL it introduces, grouped by
 * directory. Read-only: this endpoint never executes SQL — running goes
 * through /api/query/execute, which carries the role and audit gates.
 * Body: { compareUrl }
 */
export const liteDiff = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { compareUrl } = req.body;

    if (!compareUrl || typeof compareUrl !== 'string') {
      return res.status(400).json({ error: 'compareUrl is required' });
    }
    if (compareUrl.length > 500) {
      return res.status(400).json({ error: 'compareUrl too long' });
    }

    const cfg = migrationsService.getConfig();
    if (gateOnRepoReady(res, cfg.repoPath)) return;

    logger.info('Lite migration diff requested', {
      user: (req.user as any)?.username,
      compareUrl,
    });

    const result = await liteDiffService.getLiteDiff(compareUrl);
    res.json(result);
  } catch (error: any) {
    // A bad compare URL is user error, not a server fault — surface the
    // message instead of a generic 500 from the error handler.
    if (/compare URL/i.test(error.message) || /Too many SQL files/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    logger.error('Lite migration diff failed:', error);
    next(error);
  }
};
