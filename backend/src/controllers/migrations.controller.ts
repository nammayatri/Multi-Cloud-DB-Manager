import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import * as migrationsService from '../services/migrations/migrations.service';
import * as gitService from '../services/migrations/git.service';

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
    const { repoPath, ...safeConfig } = migrationsService.getConfig();
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
    gitService.pullLatest(config.repoPath);
    const refs = gitService.getRecentRefs(config.repoPath);
    res.json({ success: true, ...refs });
  } catch (error: any) {
    logger.error('Failed to get git refs:', error);
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

    const result = await migrationsService.analyze(fromRef, toRef, environment, databaseFilter);
    res.json(result);
  } catch (error: any) {
    logger.error('Migration analysis failed:', error);
    next(error);
  }
};

/**
 * POST /api/migrations/refresh-repo
 * Runs git fetch --all --prune on the configured repo.
 */
export const refreshRepo = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const config = migrationsService.getConfig();
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
