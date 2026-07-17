import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import { Role, isSuperRole } from '../constants/roles';
import {
  ROLE_FUNCTIONALITY,
  effectiveRoleFromFunctionalities,
} from '../constants/functionalities';
import LocService from '../services/loc/LocService';
import QueryValidator from '../services/query/QueryValidator';

/**
 * loc-gateway authentication: the loc auth service (../loc) proxies user
 * traffic here having already validated the user's token, and proves itself
 * with `x-loc-auth: <shared secret>` (the locAuthSecret configured when this
 * service was registered in loc). We trust its X-User-* identity headers and
 * resolve the user's access from their loc functionality list — either sent
 * inline (X-User-Functionality, for services registered with
 * sendFunctionalities) or fetched from loc's role API and cached for an hour.
 *
 * Returns a user object, or null with the response already sent.
 */
const authenticateViaLoc = async (
  req: Request,
  res: Response
): Promise<Express.User | null> => {
  const loc = LocService.getInstance();
  const presented = req.header('x-loc-auth') || '';

  if (!loc.isConfigured() || !loc.verifyGatewaySecret(presented)) {
    logger.warn('Rejected x-loc-auth header with invalid or unconfigured secret', {
      ip: req.ip,
      path: req.path,
      configured: loc.isConfigured(),
    });
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid loc gateway secret',
    });
    return null;
  }

  const userId = req.header('x-user-id');
  const username = req.header('x-username');
  const roleName = req.header('x-user-role');
  if (!userId || !username || !roleName) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing loc identity headers (x-user-id / x-username / x-user-role)',
    });
    return null;
  }

  // Functionality list: inline header if loc sends it, else loc's role API
  // (GET /get/{service}/roles/{id}/functionality, cached in-mem for 1 hour).
  let functionalities: string[];
  const inline = req.header('x-user-functionality');
  if (inline !== undefined) {
    functionalities = inline ? inline.split(',').map(f => f.trim()).filter(Boolean) : [];
  } else {
    try {
      functionalities = (await loc.getFunctionalitiesForRole(roleName)) ?? [];
    } catch (error) {
      logger.error('loc role/functionality lookup failed', {
        role: roleName,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(503).json({
        error: 'Service Unavailable',
        message: 'Could not resolve permissions from the auth service',
      });
      return null;
    }
  }

  return {
    id: userId,
    username,
    email: '',
    name: username,
    role: effectiveRoleFromFunctionalities(functionalities),
    functionalities,
    authSource: 'loc',
  };
};

/**
 * Middleware to check if user is authenticated.
 * loc-gateway requests (x-loc-auth header present) are authenticated from
 * loc's injected identity headers; everything else falls back to the
 * session-cookie flow.
 */
export const isAuthenticated = async (req: Request, res: Response, next: NextFunction) => {
  // loc gateway path: header present → this is the ONLY way the request may
  // authenticate (a bad secret is rejected, never silently downgraded).
  if (req.header('x-loc-auth') !== undefined) {
    const user = await authenticateViaLoc(req, res);
    if (user) {
      req.user = user;
      return next();
    }
    return; // response already sent
  }

  // Fallback: session cookie
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
 *
 * loc-authenticated users are validated against their functionality list
 * (a loc role may combine several access tiers, e.g. db:write +
 * clickhouse:manage); session users against their stored role.
 */
export const requireRoles =
  (...roles: Role[]) =>
  (req: Request, res: Response, next: NextFunction) => {
    const user = req.user as Express.User | undefined;

    if (user?.authSource === 'loc') {
      const held = user.functionalities || [];
      if (roles.some(role => held.includes(ROLE_FUNCTIONALITY[role]))) {
        return next();
      }
      logger.warn('Unauthorized functionality access attempt (loc)', {
        username: user.username,
        functionalities: held,
        required: roles.map(r => ROLE_FUNCTIONALITY[r]),
        path: req.path,
      });
      return res.status(403).json({
        error: 'Forbidden',
        message: `Requires one of these functionalities: ${roles
          .map(r => ROLE_FUNCTIONALITY[r])
          .join(', ')}`,
      });
    }

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
