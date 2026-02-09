import { Request, Response, NextFunction } from 'express';
import queryService from '../services/query.service';
import historyService from '../services/history.service';
import DatabasePools from '../config/database';
import logger from '../utils/logger';
import { AppError } from '../middleware/error.middleware';
import { QueryRequest } from '../types';
import bcrypt from 'bcryptjs';

/**
 * Execute a query on selected databases
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

    logger.info('Query execution requested', {
      user: user.email,
      database: queryRequest.database,
      mode: queryRequest.mode,
    });

    // Execute query
    const result = await queryService.executeDual(queryRequest);

    // Debug logging
    const cloudResults = Object.keys(result).filter(k => k !== 'id' && k !== 'success');
    logger.info('Query result structure', {
      executionId: result.id,
      clouds: cloudResults,
      overallSuccess: result.success,
    });

    // Save to history (async, don't wait)
    historyService
      .saveQueryExecution(
        user.id,
        queryRequest.query,
        queryRequest.database,
        queryRequest.mode,
        result
      )
      .catch((err) => {
        logger.error('Failed to save query to history:', err);
      });

    res.json(result);
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
