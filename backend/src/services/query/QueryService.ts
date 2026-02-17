import logger from '../../utils/logger';
import DatabasePools from '../../config/database';
import { QueryRequest, QueryResponse } from '../../types';
import QueryValidator from './QueryValidator';
import ExecutionManager, { ExecutionResult } from './ExecutionManager';
import QueryExecutor from './QueryExecutor';
import historyService from '../history.service';

/**
 * QueryService - Main service that orchestrates query execution
 * Refactored to use smaller, focused classes:
 * - QueryValidator: Validates SQL queries
 * - ExecutionManager: Manages execution state and cleanup (using Redis for cross-pod visibility)
 * - QueryExecutor: Handles actual database execution
 */
class QueryService {
  private executionManager: ExecutionManager;
  private executor: QueryExecutor;

  constructor() {
    this.executionManager = new ExecutionManager();
    this.executor = new QueryExecutor(this.executionManager);
  }

  /**
   * Stop the query service and cleanup resources
   */
  public stop(): void {
    // No cleanup needed - Redis handles TTL automatically
  }

  /**
   * Get execution status and result
   */
  public async getExecutionStatus(executionId: string): Promise<ExecutionResult | null> {
    return this.executionManager.getExecutionStatus(executionId);
  }

  /**
   * Cancel an active query execution with proper logging
   */
  public async cancelExecution(executionId: string): Promise<boolean> {
    const marked = await this.executionManager.markAsCancelled(executionId);
    if (!marked) {
      return false;
    }

    // Get backend PIDs to cancel
    const pids = this.executionManager.getBackendPids(executionId);
    const dbPools = DatabasePools.getInstance();

    // Try to cancel the query on the database side for each client
    for (const { cloudKey, pid } of pids) {
      try {
        // Extract cloudName and databaseName from cloudKey
        const [cloudName, ...dbParts] = cloudKey.split('_');
        const databaseName = dbParts.join('_');
        
        const pool = dbPools.getPoolByName(cloudName, databaseName);
        if (pool) {
          const cancelClient = await pool.connect();
          try {
            await cancelClient.query('SELECT pg_cancel_backend($1)', [pid]);
            logger.info(`Cancelled query on ${cloudKey}`, { executionId, pid });
          } catch (error: any) {
            // Log but don't fail - query might have already completed
            if (error.code !== '57014') { // query_canceled
              logger.warn(`Failed to cancel query on ${cloudKey}`, { 
                executionId, 
                pid, 
                error: error.message,
                code: error.code 
              });
            }
          } finally {
            cancelClient.release();
          }
        }
      } catch (error: any) {
        logger.error(`Error during cancellation on ${cloudKey}`, { 
          executionId, 
          error: error.message 
        });
      }
    }

    logger.info('Query execution cancelled', { executionId });
    return true;
  }

  /**
   * Get list of active executions
   */
  public getActiveExecutions() {
    return this.executionManager.getActiveExecutions();
  }

  /**
   * Start async query execution (returns immediately with executionId)
   */
  public async startExecution(request: QueryRequest, userId?: string): Promise<string> {
    const { v4: uuidv4 } = require('uuid');
    const executionId = uuidv4();
    
    // Initialize result storage with userId for authorization
    await this.executionManager.initializeExecution(executionId, userId);
    
    // Start execution in background with proper error handling
    this.executeAsync(executionId, request, userId).catch((error) => {
      logger.error('Async execution failed', {
        executionId,
        error: error.message,
      });
      
      // Update result record on error - ensure endTime is always set
      this.executionManager.failExecution(executionId, error.message);
    });
    
    logger.info('Started async query execution', {
      executionId,
      database: request.database,
      mode: request.mode,
      userId,
    });
    
    return executionId;
  }

  /**
   * Execute query asynchronously (background task)
   */
  private async executeAsync(executionId: string, request: QueryRequest, userId?: string): Promise<void> {
    const timeout = Math.min(request.timeout || 300000, 300000);
    
    try {
      // Get cloud configuration
      const cloudConfig = DatabasePools.getInstance().getCloudConfig();
      const pgSchema = request.pgSchema || 'public';
      const databaseName = request.database;

      // Determine which clouds to execute on based on mode
      const cloudsToExecute: string[] = [];

      if (request.mode === 'both') {
        cloudsToExecute.push(cloudConfig.primaryCloud);
        cloudsToExecute.push(...cloudConfig.secondaryClouds);
      } else {
        cloudsToExecute.push(request.mode);
      }

      const response: QueryResponse = {
        id: executionId,
        success: false,
      };

      // Execute on each cloud
      const successes: boolean[] = [];
      let wasCancelled = false;
      
      for (const cloudName of cloudsToExecute) {
        // Check if cancelled before starting this cloud
        if (this.executionManager.isCancelled(executionId)) {
          wasCancelled = true;
          // Add a placeholder result for clouds that weren't executed due to cancellation
          response[cloudName] = {
            success: false,
            error: 'Query was cancelled before execution on this cloud',
            duration_ms: 0
          };
          successes.push(false);
          continue; // Continue to add placeholders for remaining clouds
        }
        
        try {
          const result = await this.executor.executeOnDatabase(
            cloudName, 
            databaseName, 
            request.query, 
            timeout, 
            pgSchema, 
            request.continueOnError || false,
            executionId
          );
          response[cloudName] = result;
          successes.push(result.success);
          
          // Save partial results immediately after each cloud completes
          // This ensures partial results are available even if cancelled mid-execution
          // Don't mark as complete yet - still running other clouds
          await this.executionManager.savePartialResults(executionId, {...response});
          
          // Update progress
          if (result.statementCount) {
            await this.executionManager.updateProgress(
              executionId,
              result.results?.length || (result.success ? 1 : 0),
              result.statementCount
            );
          } else if (result.success) {
            // Single statement - update progress
            await this.executionManager.updateProgress(executionId, 1, 1);
          }
        } catch (error: any) {
          logger.error(`Execution failed on ${cloudName}/${databaseName}`, {
            cloudName,
            databaseName,
            error: error.message
          });
          response[cloudName] = {
            success: false,
            error: error.message,
            duration_ms: 0
          };
          successes.push(false);
        }
      }

      // Determine overall success
      response.success = successes.length > 0 && successes.every(s => s);
      
      // Update result (respects cancellation status, saves partial results)
      await this.executionManager.completeExecution(executionId, response, response.success);

      logger.info('Async query execution complete', {
        executionId,
        success: response.success,
        cloudsExecuted: cloudsToExecute,
        wasCancelled,
      });
      
      // Save to history if userId provided (including cancelled queries)
      if (userId) {
        historyService
          .saveQueryExecution(
            userId,
            request.query,
            request.database,
            request.mode,
            response
          )
          .catch((err) => {
            logger.error('Failed to save query to history:', err);
          });
      }
    } catch (error: any) {
      await this.executionManager.failExecution(executionId, error.message);
      
      logger.error('Async query execution failed', {
        executionId,
        error: error.message,
      });
      
      // Save failed execution to history
      if (userId) {
        const errorResponse: QueryResponse = {
          id: executionId,
          success: false,
          error: error.message
        };
        historyService
          .saveQueryExecution(
            userId,
            request.query,
            request.database,
            request.mode,
            errorResponse
          )
          .catch((err) => {
            logger.error('Failed to save failed query to history:', err);
          });
      }
    }
  }

  /**
   * Validate SQL query (delegates to QueryValidator singleton)
   */
  public validateQuery(query: string) {
    return QueryValidator.validateQuery(query);
  }

  /**
   * Check if query requires password verification
   */
  public requiresPasswordVerification(query: string): string | null {
    return QueryValidator.requiresPasswordVerification(query);
  }
}

// Export singleton instance
export default new QueryService();
