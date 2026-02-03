import { Request, Response, NextFunction } from 'express';
import queryService from '../services/query.service';
import historyService from '../services/history.service';
import logger from '../utils/logger';
import { AppError } from '../middleware/error.middleware';
import { QueryRequest } from '../types';

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
