import { Request, Response, NextFunction } from 'express';
import queryService from '../services/query.service';
import historyService from '../services/history.service';
import DatabasePools from '../config/database';
import logger from '../utils/logger';
import { AppError } from '../middleware/error.middleware';
import { QueryRequest } from '../types';
import bcrypt from 'bcryptjs';

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
      // Only MASTER users can execute these queries
      if (user.role !== 'MASTER') {
        throw new AppError('Only MASTER users can execute ALTER/DROP queries', 403);
      }

      // Verify password
      if (!queryRequest.password) {
        throw new AppError('Password verification required for this query', 400);
      }

      // Get user's password hash from database
      const dbPools = DatabasePools.getInstance();
      const historyPool = dbPools.history;
      const userResult = await historyPool.query(
        'SELECT password_hash FROM dual_db_manager.users WHERE username = $1',
        [user.username]
      );

      if (userResult.rows.length === 0) {
        throw new AppError('User not found', 404);
      }

      const passwordValid = await bcrypt.compare(queryRequest.password, userResult.rows[0].password_hash);
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

    // Validate database and mode against actual configuration
    const cloudConfig = DatabasePools.getInstance().getCloudConfig();
    const allDatabases = [
      ...cloudConfig.primaryDatabases.map(d => d.databaseName),
      ...Object.values(cloudConfig.secondaryDatabases).flat().map(d => d.databaseName)
    ];
    const allClouds = [cloudConfig.primaryCloud, ...cloudConfig.secondaryClouds];

    if (!allDatabases.includes(queryRequest.database)) {
      throw new AppError(`Invalid database: ${queryRequest.database}`, 400);
    }

    if (queryRequest.mode !== 'both' && !allClouds.includes(queryRequest.mode)) {
      throw new AppError(`Invalid execution mode: ${queryRequest.mode}`, 400);
    }

    // Hard-block CREATE INDEX on protected tables — no override
    const dbInfo = [
      ...cloudConfig.primaryDatabases,
      ...Object.values(cloudConfig.secondaryDatabases).flat(),
    ].find(d => d.databaseName === queryRequest.database);

    if (dbInfo?.indexCreateBlockedTables && dbInfo.indexCreateBlockedTables.length > 0) {
      const blockedMatches = queryService.checkIndexCreateBlocked(
        queryRequest.query,
        dbInfo.indexCreateBlockedTables,
        queryRequest.pgSchema || dbInfo.defaultSchema
      );
      if (blockedMatches.length > 0) {
        logger.warn('Blocked CREATE INDEX on protected table', {
          username: user.username,
          tables: blockedMatches,
        });
        throw new AppError(
          `CREATE INDEX is blocked on the following protected table(s): ${blockedMatches.join(', ')}. These tables are critical for production — please contact your administrator to run this index query.`,
          403
        );
      }
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

    if (!executionId) {
      throw new AppError('Execution ID is required', 400);
    }

    const status = await queryService.getExecutionStatus(executionId);

    if (!status) {
      throw new AppError('Execution not found', 404);
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

    // Authorization: Only allow cancelling own executions or MASTER users
    if (status.userId && status.userId !== user.id && user.role !== 'MASTER') {
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
