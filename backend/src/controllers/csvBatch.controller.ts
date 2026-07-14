import { Request, Response, NextFunction } from 'express';
import csvBatchService from '../services/query/CsvBatchService';
import DatabasePools from '../config/database';
import { AppError } from '../middleware/error.middleware';
import logger from '../utils/logger';

/**
 * Start an async CSV-driven batch query execution.
 * The frontend parses the CSV and sends an array of IDs; this endpoint
 * chunks them into batches, substitutes {id} in the query template, and
 * executes each batch against the target database(s).
 */
export const startCsvBatch = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user as Express.User;
    const { queryTemplate, ids, database, batchSize, sleepMs, dryRun, stopOnError, pgSchema } = req.body;

    // Validate the database exists in the config. CSV batch runs on the
    // database's own primary cloud (resolved in the service).
    const dbPools = DatabasePools.getInstance();
    const cloudConfig = dbPools.getCloudConfig();
    const allDatabases = [
      ...cloudConfig.primaryDatabases.map(d => d.databaseName),
      ...Object.values(cloudConfig.secondaryDatabases).flat().map(d => d.databaseName),
    ];

    if (!allDatabases.includes(database)) {
      throw new AppError(`Invalid database: ${database}.`, 400);
    }

    logger.info('CSV batch execution requested', {
      user: user.email,
      database,
      cloud: dbPools.getPrimaryCloudForDatabase(database),
      idCount: Array.isArray(ids) ? ids.length : 0,
      batchSize,
      dryRun,
      stopOnError,
    });

    const result = await csvBatchService.startBatchExecution(
      { queryTemplate, ids, database, batchSize, sleepMs, dryRun, stopOnError, pgSchema },
      user.id
    );

    res.json({
      ...result,
      status: dryRun ? 'completed' : 'started',
      message: dryRun ? 'Dry run completed — poll /status/:executionId for results' : 'CSV batch execution started',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Poll the status of a CSV batch execution (reuses the same ExecutionResult shape).
 */
export const getCsvBatchStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { executionId } = req.params;
    const status = await csvBatchService.getExecutionStatus(executionId);
    if (!status) {
      throw new AppError('Execution not found', 404);
    }
    res.json(status);
  } catch (error) {
    next(error);
  }
};

/**
 * Cancel a running CSV batch execution.
 */
export const cancelCsvBatch = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { executionId } = req.params;
    const cancelled = await csvBatchService.cancelExecution(executionId);
    res.json({
      success: cancelled,
      message: cancelled ? 'Cancellation requested' : 'Execution not found or already completed',
    });
  } catch (error) {
    next(error);
  }
};
