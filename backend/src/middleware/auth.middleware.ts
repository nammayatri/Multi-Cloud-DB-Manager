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
 * Middleware to validate Redis permissions based on user role
 * READER cannot execute write commands or delete via SCAN
 */
export const validateRedisPermissions = (req: Request, res: Response, next: NextFunction) => {
  const user = req.user as any;

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { command } = req.body;
  const upperCmd = command ? String(command).toUpperCase() : '';

  // RAW commands — only MASTER
  if (upperCmd === 'RAW' && user.role !== 'MASTER') {
    logger.warn('Non-MASTER attempted Redis RAW command', {
      username: user.username,
      role: user.role,
    });
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Only MASTER role can execute raw Redis commands',
    });
  }

  if (user.role === 'READER') {
    // Check for write commands
    if (upperCmd) {
      const writeCommands = ['SET', 'DEL', 'HSET', 'EXPIRE', 'LPUSH', 'RPUSH', 'RAW'];
      if (writeCommands.includes(upperCmd)) {
        logger.warn('READER attempted Redis write command', {
          username: user.username,
          command: upperCmd,
        });
        return res.status(403).json({
          error: 'Forbidden',
          message: 'READER role cannot execute write commands',
        });
      }
    }

    // Check for SCAN delete action
    const { action } = req.body;
    if (action === 'delete') {
      logger.warn('READER attempted Redis SCAN delete', {
        username: user.username,
      });
      return res.status(403).json({
        error: 'Forbidden',
        message: 'READER role cannot delete keys',
      });
    }
  }

  next();
};

/**
 * Middleware to validate query based on user role
 * READER: SELECT only
 * USER: SELECT, INSERT, UPDATE, ALTER, CREATE TABLE only
 * MASTER: All queries (no restrictions)
 */
export const validateQueryPermissions = (req: Request, res: Response, next: NextFunction) => {
  const user = req.user as any;
  const { query } = req.body;

  if (!user || !query) {
    return next();
  }

  const trimmedQuery = query.trim().toUpperCase();

  // MASTER can do anything
  if (user.role === 'MASTER') {
    logger.info('MASTER executing query', {
      username: user.username,
      query: query.substring(0, 100),
    });
    return next();
  }

  // For USER: Only allow specific operations
  if (user.role === 'USER') {
    // Operations that USER is allowed to do
    const userAllowedPatterns = [
      /^\s*SELECT/i,
      /^\s*WITH.*SELECT/i,  // CTEs with SELECT
      /^\s*INSERT/i,
      /^\s*UPDATE/i,
      /^\s*ALTER\s+TABLE/i,
      /^\s*CREATE\s+TABLE/i,
      /^\s*CREATE\s+INDEX/i,
    ];

    // Check if query matches any allowed pattern
    const isAllowed = userAllowedPatterns.some(pattern => pattern.test(query));

    if (!isAllowed) {
      // Check what they tried to do
      let attemptedOperation = 'Unknown';
      if (trimmedQuery.includes('DELETE')) attemptedOperation = 'DELETE';
      else if (trimmedQuery.includes('DROP')) attemptedOperation = 'DROP';
      else if (trimmedQuery.includes('TRUNCATE')) attemptedOperation = 'TRUNCATE';
      else if (trimmedQuery.includes('GRANT')) attemptedOperation = 'GRANT';
      else if (trimmedQuery.includes('REVOKE')) attemptedOperation = 'REVOKE';
      else if (trimmedQuery.includes('CREATE DATABASE')) attemptedOperation = 'CREATE DATABASE';
      else if (trimmedQuery.includes('CREATE SCHEMA')) attemptedOperation = 'CREATE SCHEMA';
      else if (trimmedQuery.includes('CREATE INDEX')) attemptedOperation = 'CREATE INDEX';

      logger.warn('USER attempted unauthorized operation', {
        username: user.username,
        operation: attemptedOperation,
        query: query.substring(0, 100),
      });

      return res.status(403).json({
        error: 'Forbidden',
        message: `USER role can only execute: SELECT, INSERT, UPDATE, ALTER TABLE, CREATE TABLE, CREATE INDEX. ${attemptedOperation} requires MASTER role.`,
        allowedOperations: ['SELECT', 'INSERT', 'UPDATE', 'ALTER TABLE', 'CREATE TABLE', 'CREATE INDEX'],
        yourRole: 'USER',
      });
    }

    // USER can proceed with allowed operations
    return next();
  }

  // READER role restrictions
  if (user.role === 'READER') {
    // Check if query starts with SELECT (allow WITH for CTEs)
    if (!trimmedQuery.startsWith('SELECT') && !trimmedQuery.startsWith('WITH')) {
      logger.warn('READER attempted non-SELECT query', {
        username: user.username,
        query: query.substring(0, 100),
      });

      return res.status(403).json({
        error: 'Forbidden',
        message: 'READER role can only execute SELECT queries. Write operations (INSERT, UPDATE, DELETE) are not allowed.',
      });
    }

    // Additional check: ensure no write keywords in the query
    const writeKeywords = ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER'];
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

  // READER restrictions (already handled above, but keep for clarity)
  next();
};
