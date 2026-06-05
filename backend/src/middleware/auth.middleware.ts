import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import { Role, isSuperRole } from '../constants/roles';
import QueryValidator from '../services/query/QueryValidator';

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
 * Factory: gate a route to one or more roles.
 * Must be used after isAuthenticated.
 */
export const requireRoles =
  (...roles: Role[]) =>
  (req: Request, res: Response, next: NextFunction) => {
    const user = req.user as Express.User | undefined;

    if (!user?.role || !roles.includes(user.role)) {
      logger.warn('Unauthorized role access attempt', {
        username: user?.username,
        role: user?.role,
        required: roles,
        path: req.path,
      });

      return res.status(403).json({
        error: 'Forbidden',
        message: `Requires one of: ${roles.join(', ')}`,
      });
    }

    next();
  };

/**
 * Middleware to check if user has MASTER role.
 * Alias for requireRoles(Role.MASTER) — kept for clarity at call sites.
 */
export const requireMaster = requireRoles(Role.MASTER);

/**
 * User-administration gate: exclusively ADMIN.
 * ADMIN holds everything MASTER does PLUS user-access management;
 * MASTER no longer manages users.
 */
export const requireAdmin = requireRoles(Role.ADMIN);

/**
 * Middleware to check if user can execute write queries
 * MASTER and USER can write, READER cannot
 */
export const canWrite = (req: Request, res: Response, next: NextFunction) => {
  const user = req.user as Express.User | undefined;

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
  const user = req.user as Express.User | undefined;

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { command } = req.body;
  const upperCmd = command ? String(command).toUpperCase() : '';

  // RAW commands — only MASTER/ADMIN
  if (upperCmd === 'RAW' && !isSuperRole(user.role)) {
    logger.warn('Unprivileged role attempted Redis RAW command', {
      username: user.username,
      role: user.role,
    });
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Only MASTER or ADMIN role can execute raw Redis commands',
    });
  }

  // CKH_MANAGER currently has no Redis access.
  // To grant read-only later: remove this branch and extend the READER block below.
  if (user.role === Role.CKH_MANAGER) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'CKH_MANAGER does not have Redis access',
    });
  }

  // RELEASE_MANAGER has Redis access at the USER tier (read + write + SCAN
  // preview/delete). RAW commands stay gated to MASTER above. No further
  // restrictions here — fall through to the structured-command checks.

  if (user.role === 'READER') {
    // Check for write commands
    if (upperCmd) {
      const writeCommands = [
        'SET', 'SETNX', 'SETEX', 'MSET', 'DEL', 'EXPIRE',
        'INCR', 'INCRBY', 'DECR', 'DECRBY', 'INCRBYFLOAT',
        'HSET', 'HDEL',
        'LPUSH', 'RPUSH', 'RPOP', 'LTRIM', 'LREM',
        'SADD', 'SREM', 'SMOVE',
        'ZADD', 'ZREM', 'ZINCRBY', 'ZREMRANGEBYSCORE',
        'XADD', 'XDEL', 'XACK', 'XGROUP_CREATE',
        'GEOADD', 'PUBLISH',
        'RAW',
      ];
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
  const user = req.user as Express.User | undefined;
  const { query } = req.body;

  if (!user || !query) {
    return next();
  }

  const trimmedQuery = query.trim().toUpperCase();

  // MASTER and ADMIN can run anything (ADMIN differs from MASTER only in
  // user-access management, which is gated at the auth routes).
  if (isSuperRole(user.role)) {
    logger.info(`${user.role} executing query`, {
      username: user.username,
      query: query.substring(0, 100),
    });
    return next();
  }

  // CKH_MANAGER currently has no Postgres access.
  // To grant SELECT-only later: remove this branch and extend the READER block below
  // to also accept Role.CKH_MANAGER.
  if (user.role === Role.CKH_MANAGER) {
    logger.warn('CKH_MANAGER attempted Postgres query', {
      username: user.username,
      query: query.substring(0, 100),
    });
    return res.status(403).json({
      error: 'Forbidden',
      message: 'CKH_MANAGER does not have Postgres access',
    });
  }

  // RELEASE_MANAGER: SELECT/EXPLAIN, ALTER TABLE ADD COLUMN/CONSTRAINT,
  // CREATE INDEX CONCURRENTLY, transaction control. Per-statement enforcement.
  if (user.role === Role.RELEASE_MANAGER) {
    const continueOnError: boolean = !!req.body?.continueOnError;
    let statements: string[];
    try {
      statements = QueryValidator.splitStatements(query);
    } catch {
      statements = [query];
    }

    const violations: Array<{ statement: string; reason: string }> = [];
    for (const stmt of statements) {
      const verdict = QueryValidator.isAllowedForReleaseManager(stmt);
      if (!verdict.allowed) {
        violations.push({ statement: stmt.trim().substring(0, 200), reason: verdict.reason || 'not allowed' });
      }
    }

    if (violations.length === 0) {
      return next();
    }

    // Multi-statement + continueOnError=true: let it through; the executor
    // will reject offending statements per-statement (defense-in-depth check
    // duplicated there).
    if (continueOnError && statements.length > 1) {
      return next();
    }

    logger.warn('RELEASE_MANAGER attempted disallowed query', {
      username: user.username,
      violations: violations.map(v => v.reason),
    });

    return res.status(403).json({
      error: 'Forbidden',
      message:
        `RELEASE_MANAGER role: ${violations[0].reason}. ` +
        `Allowed: SELECT/EXPLAIN, CREATE TABLE, CREATE INDEX CONCURRENTLY, ALTER TABLE ADD COLUMN (with DEFAULT if NOT NULL), ALTER TABLE ADD CONSTRAINT.`,
      violations,
      yourRole: 'RELEASE_MANAGER',
    });
  }

  // For USER: only allow specific operations
  if (user.role === 'USER') {
    // Operations that USER/ADMIN are allowed to run
    const userAllowedPatterns = [
      /^\s*SELECT/i,
      /^\s*WITH[\s\S]*SELECT/i, // CTEs with SELECT ([\s\S] so multi-line CTEs match)
      /^\s*INSERT/i,
      /^\s*UPDATE/i,
      /^\s*ALTER\s+TABLE/i,
      /^\s*CREATE\s+TABLE/i,
      /^\s*CREATE\s+INDEX/i,
      // EXPLAIN restricted to read statements — EXPLAIN ANALYZE on a write
      // statement actually executes the write.
      /^\s*EXPLAIN(\s+\([^)]*\)|\s+ANALYZE|\s+VERBOSE)*\s+(SELECT|WITH)/i,
      /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i,
    ];

    // Validate EVERY statement, not just the query as a whole — otherwise a
    // disallowed statement can hide behind an allowed one
    // (e.g. "SELECT 1; DELETE FROM t").
    let statements: string[];
    try {
      statements = QueryValidator.splitStatements(query);
    } catch {
      statements = [query];
    }

    const disallowed = statements.find(
      stmt => !userAllowedPatterns.some(pattern => pattern.test(stmt))
    );

    if (disallowed) {
      // Identify what they tried to do (first keyword of the offending statement)
      const upperStmt = disallowed.trim().toUpperCase();
      let attemptedOperation = 'Unknown';
      if (upperStmt.startsWith('DELETE')) attemptedOperation = 'DELETE';
      else if (upperStmt.startsWith('DROP')) attemptedOperation = 'DROP';
      else if (upperStmt.startsWith('TRUNCATE')) attemptedOperation = 'TRUNCATE';
      else if (upperStmt.startsWith('GRANT')) attemptedOperation = 'GRANT';
      else if (upperStmt.startsWith('REVOKE')) attemptedOperation = 'REVOKE';
      else if (upperStmt.startsWith('CREATE DATABASE')) attemptedOperation = 'CREATE DATABASE';
      else if (upperStmt.startsWith('CREATE SCHEMA')) attemptedOperation = 'CREATE SCHEMA';

      logger.warn(`${user.role} attempted unauthorized operation`, {
        username: user.username,
        operation: attemptedOperation,
        query: query.substring(0, 100),
      });

      return res.status(403).json({
        error: 'Forbidden',
        message: `${user.role} role can only execute: SELECT, INSERT, UPDATE, ALTER TABLE, CREATE TABLE, CREATE INDEX. ${attemptedOperation} requires MASTER role.`,
        allowedOperations: ['SELECT', 'INSERT', 'UPDATE', 'ALTER TABLE', 'CREATE TABLE', 'CREATE INDEX'],
        yourRole: user.role,
      });
    }

    // All statements allowed — proceed
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

    return next();
  }

  // Fail closed: every role must be explicitly handled above. An unknown role
  // must never fall through to full query access.
  logger.warn('Query attempt by unhandled role — denying', {
    username: user.username,
    role: user.role,
  });
  return res.status(403).json({
    error: 'Forbidden',
    message: `Role ${user.role} does not have query access`,
  });
};
