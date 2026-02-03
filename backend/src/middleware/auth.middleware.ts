import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

/**
 * Middleware to check if user is authenticated
 */
export const isAuthenticated = (req: Request, res: Response, next: NextFunction) => {
  // Check session
  if ((req.session as any)?.passport?.user) {
    req.user = (req.session as any).passport.user;
    return next();
  }

  logger.warn('Unauthenticated access attempt', {
    ip: req.ip,
    path: req.path,
  });

  res.status(401).json({
    error: 'Unauthorized',
    message: 'You must be logged in to access this resource',
  });
};

/**
 * Middleware to check if user has MASTER role
 * Must be used after isAuthenticated
 */
export const requireMaster = (req: Request, res: Response, next: NextFunction) => {
  const user = req.user as any;

  if (!user || user.role !== 'MASTER') {
    logger.warn('Unauthorized MASTER access attempt', {
      username: user?.username,
      role: user?.role,
      path: req.path,
    });

    return res.status(403).json({
      error: 'Forbidden',
      message: 'Only MASTER can perform this action',
    });
  }

  next();
};

/**
 * Middleware to check if user can execute write queries
 * MASTER and USER can write, READER cannot
 */
export const canWrite = (req: Request, res: Response, next: NextFunction) => {
  const user = req.user as any;

  if (!user) {
    return res.status(401).json({
      error: 'Unauthorized',
    });
  }

  if (user.role === 'READER') {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'READER role can only execute SELECT queries',
    });
  }

  next();
};

/**
 * Middleware to validate query based on user role
 * READER can only execute SELECT queries
 */
export const validateQueryPermissions = (req: Request, res: Response, next: NextFunction) => {
  const user = req.user as any;
  const { query } = req.body;

  if (!user || !query) {
    return next();
  }

  // MASTER and USER can execute any query
  if (user.role === 'MASTER' || user.role === 'USER') {
    return next();
  }

  // READER can only execute SELECT queries
  if (user.role === 'READER') {
    const trimmedQuery = query.trim().toUpperCase();

    // Check if query starts with SELECT (allow WITH for CTEs)
    if (!trimmedQuery.startsWith('SELECT') && !trimmedQuery.startsWith('WITH')) {
      logger.warn('READER attempted write query', {
        username: user.username,
        query: query.substring(0, 100),
      });

      return res.status(403).json({
        error: 'Forbidden',
        message: 'READER role can only execute SELECT queries. Write operations (INSERT, UPDATE, DELETE, etc.) are not allowed.',
      });
    }

    // Additional check: ensure no write keywords in the query
    const writeKeywords = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE'];
    for (const keyword of writeKeywords) {
      if (trimmedQuery.includes(keyword)) {
        logger.warn('READER attempted query with write keyword', {
          username: user.username,
          keyword,
          query: query.substring(0, 100),
        });

        return res.status(403).json({
          error: 'Forbidden',
          message: `READER role cannot execute queries containing ${keyword}`,
        });
      }
    }
  }

  next();
};
