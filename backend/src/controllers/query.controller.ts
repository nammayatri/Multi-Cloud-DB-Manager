import { Request, Response, NextFunction } from 'express';
import queryService from '../services/query.service';
import { checkExecutionConstraints } from '../services/query/queryPermissions';
import { verifyUserPassword } from '../utils/verifyPassword';
import logger from '../utils/logger';
import { AppError } from '../middleware/error.middleware';
import { QueryRequest } from '../types';
import { isSuperRole } from '../constants/roles';

/**
 * Start async query execution (returns immediately with executionId)
 */
export const executeQuery = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user as Express.User;
    const queryRequest: QueryRequest = req.body;

    // Validate query
    const validation = queryService.validateQuery(queryRequest.query);
    if (!validation.valid) {
      throw new AppError(validation.error || 'Invalid query', 400);
    }

    // Check if query requires password verification (ALTER/DROP, excluding ALTER ADD)
    const requiresPasswordVerification = queryService.requiresPasswordVerification(queryRequest.query);

    if (requiresPasswordVerification) {
      // Only MASTER/ADMIN users can execute these queries
      if (!isSuperRole(user.role)) {
        throw new AppError('Only MASTER or ADMIN users can execute ALTER/DROP queries', 403);
      }

      // Verify password
      if (!queryRequest.password) {
        throw new AppError('Password verification required for this query', 400);
      }

      const passwordValid = await verifyUserPassword(user.username, queryRequest.password);
      if (passwordValid === null) {
        throw new AppError('User not found', 404);
      }

      if (!passwordValid) {
        logger.warn('Password verification failed for sensitive query', {
          username: user.username,
          query: queryRequest.query.substring(0, 100)
        });
        throw new AppError('Invalid password', 401);
      }

      logger.info('Password verification successful for sensitive query', {
        username: user.username,
        queryType: requiresPasswordVerification
      });
    }

    // Role-independent execution constraints (valid database/mode, INSERT
    // primary-cloud rule, protected-table CREATE INDEX block). Shared with the
    // query-request approval path so both enforce them identically.
    const constraints = checkExecutionConstraints({
      query: queryRequest.query,
      database: queryRequest.database,
      mode: queryRequest.mode,
      pgSchema: queryRequest.pgSchema,
    });

    if (!constraints.ok) {
      if (constraints.blockedTables) {
        logger.warn('Blocked CREATE INDEX on protected table', {
          username: user.username,
          tables: constraints.blockedTables,
        });
      }
      throw new AppError(constraints.message!, constraints.status || 400);
    }

    logger.info('Query execution requested', {
      user: user.email,
      database: queryRequest.database,
      mode: queryRequest.mode,
    });

    // Carry the authenticated session role into the executor so per-statement
    // role policy (e.g. RELEASE_MANAGER) can be enforced even on the
    // continueOnError path. Always overwrite so a client cannot smuggle their own.
    queryRequest.userRole = user.role;

    // Direct execution is never tied to a query request. Clearing this stops a
    // client from forging the audit link by posting a requestId of its own.
    queryRequest.requestId = undefined;

    // Start async execution - returns immediately with executionId
    const executionId = await queryService.startExecution(queryRequest, user.id);

    res.json({
      executionId,
      status: 'started',
      message: 'Query execution started'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get execution status and results
 */
export const getExecutionStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { executionId } = req.params;
    const user = req.user as Express.User;

    if (!executionId) {
      throw new AppError('Execution ID is required', 400);
    }

    const status = await queryService.getExecutionStatus(executionId);

    if (!status) {
      throw new AppError('Execution not found', 404);
    }

    // Authorization: the payload includes the full result rows, so restrict it
    // to the owner (or MASTER/ADMIN) — matching cancelQuery below. Without this
    // any authenticated user could read another user's query results.
    if (status.userId && status.userId !== user.id && !isSuperRole(user.role)) {
      throw new AppError('You can only view your own query executions', 403);
    }

    res.json(status);
  } catch (error) {
    next(error);
  }
};

/**
 * Cancel an active query execution
 */
export const cancelQuery = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { executionId } = req.params;
    const user = req.user as Express.User;

    if (!executionId) {
      throw new AppError('Execution ID is required', 400);
    }

    // Check if execution exists in results
    const status = await queryService.getExecutionStatus(executionId);
    
    if (!status) {
      throw new AppError('Execution not found', 404);
    }

    // Authorization: Only allow cancelling own executions or MASTER/ADMIN users
    if (status.userId && status.userId !== user.id && !isSuperRole(user.role)) {
      throw new AppError('You can only cancel your own queries', 403);
    }

    // If already completed, return success (nothing to cancel)
    if (status.status !== 'running') {
      res.json({
        success: true,
        message: 'Execution already completed',
        status: status.status
      });
      return;
    }

    // Try to cancel
    const cancelled = await queryService.cancelExecution(executionId);

    if (!cancelled) {
      // Execution finished between our check and cancel attempt
      res.json({
        success: true,
        message: 'Execution completed before cancellation'
      });
      return;
    }

    logger.info('Query cancellation requested', {
      executionId,
      user: user.email
    });

    res.json({
      success: true,
      message: 'Query cancellation requested'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get list of active query executions
 */
export const getActiveExecutions = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const executions = queryService.getActiveExecutions();

    res.json({
      executions
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Validate a query without executing it
 */
export const validateQuery = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { query } = req.body;

    if (!query) {
      throw new AppError('Query is required', 400);
    }

    const validation = queryService.validateQuery(query);

    res.json({
      valid: validation.valid,
      error: validation.error,
    });
  } catch (error) {
    next(error);
  }
};
