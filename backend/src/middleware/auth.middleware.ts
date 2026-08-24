import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import { Role, isSuperRole, isReadOnlyRole, canClearCache } from '../constants/roles';
import { checkRolePermission, canRequestApproval } from '../services/query/queryPermissions';

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
 * MASTER and USER can write, read-only roles (READER, CACHE_CLEARER) cannot
 */
export const canWrite = (req: Request, res: Response, next: NextFunction) => {
  const user = req.user as Express.User | undefined;

  if (!user) {
    return res.status(401).json({
      error: 'Unauthorized',
    });
  }

  if (isReadOnlyRole(user.role)) {
    return res.status(403).json({
      error: 'Forbidden',
      message: `${user.role} role can only execute SELECT queries`,
    });
  }

  next();
};

/**
 * Middleware to validate Redis permissions based on user role
 * Read-only roles cannot execute write commands; SCAN delete is restricted to
 * the cache-clearing roles (which includes CACHE_CLEARER but not READER).
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

  // Read-only roles (READER, CACHE_CLEARER) may not issue write commands.
  // CACHE_CLEARER clears keys through the SCAN delete flow below, not via DEL:
  // SCAN delete is pattern-scoped and written to Redis history.
  if (isReadOnlyRole(user.role)) {
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
        logger.warn('Read-only role attempted Redis write command', {
          username: user.username,
          role: user.role,
          command: upperCmd,
        });
        return res.status(403).json({
          error: 'Forbidden',
          message: `${user.role} role cannot execute write commands`,
        });
      }
    }
  }

  // SCAN delete — allowlisted roles only, so an unhandled role fails closed.
  if (req.body?.action === 'delete' && !canClearCache(user.role)) {
    logger.warn('Unprivileged role attempted Redis SCAN delete', {
      username: user.username,
      role: user.role,
    });
    return res.status(403).json({
      error: 'Forbidden',
      message: `${user.role} role cannot delete keys`,
    });
  }

  next();
};

/**
 * Middleware to validate query based on user role
 * READER: SELECT only
 * USER: SELECT, INSERT, UPDATE, ALTER, CREATE TABLE only
 * MASTER: All queries (no restrictions)
 *
 * The rules themselves live in services/query/queryPermissions so the
 * query-request approval flow enforces exactly the same policy — see the
 * header comment there.
 */
export const validateQueryPermissions = (req: Request, res: Response, next: NextFunction) => {
  const user = req.user as Express.User | undefined;
  const { query } = req.body;

  if (!user || !query) {
    return next();
  }

  const verdict = checkRolePermission(user.role, query, {
    continueOnError: !!req.body?.continueOnError,
  });

  if (verdict.allowed) {
    if (isSuperRole(user.role)) {
      logger.info(`${user.role} executing query`, {
        username: user.username,
        query: query.substring(0, 100),
      });
    }
    return next();
  }

  logger.warn('Query rejected by role policy', {
    username: user.username,
    role: user.role,
    query: query.substring(0, 100),
    violations: verdict.violations?.map(v => v.reason),
  });

  return res.status(403).json({
    error: 'Forbidden',
    message: verdict.message,
    // Lets the console offer "Request approval" instead of dead-ending on a
    // toast. The API client also skips its generic error toast on this code.
    code: 'ROLE_NOT_PERMITTED',
    canRequestApproval: canRequestApproval(user.role),
    ...(verdict.violations ? { violations: verdict.violations } : {}),
    ...(verdict.allowedOperations ? { allowedOperations: verdict.allowedOperations } : {}),
    yourRole: user.role,
  });
};
