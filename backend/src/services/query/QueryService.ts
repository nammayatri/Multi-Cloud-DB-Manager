import logger from '../../utils/logger';
import DatabasePools from '../../config/database';
import { QueryRequest, QueryResponse } from '../../types';
import QueryValidator from './QueryValidator';
import ExecutionManager, { ExecutionResult } from './ExecutionManager';
import QueryExecutor from './QueryExecutor';
import historyService from '../history.service';
import clickHouseSyncService from '../clickhouse/ClickHouseSyncService';

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
      this.executionManager.completeActiveExecution(executionId);
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

      // Block INSERT statements that would generate different UUIDs on each cloud:
      //   1. Explicit: INSERT contains gen_random_uuid() / uuid_generate_vX() in its text
      //   2. Implicit: INSERT omits a column whose table DEFAULT is gen_random_uuid()
      // SELECT with gen_random_uuid() is allowed (read-only, no divergence risk).
      //
      // continueOnError: false → block entire batch if any INSERT has UUID divergence risk
      // continueOnError: true  → skip only the offending INSERT statements, run the rest
      const UUID_FN_REGEX = /(?:gen_random_uuid|uuid_generate_v[1345](?:mc)?)\(\)/gi;
      let processedQuery = request.query;

      if (cloudsToExecute.length > 1) {
        const allStatements = QueryValidator.splitStatements(request.query);
        const blockedStatements: string[] = [];
        // Statements that passed the explicit check — will go through implicit check next
        const candidateAllowed: string[] = [];

        // Pass 1: explicit UUID function check
        // Block any statement that contains INSERT + UUID function anywhere in its text.
        UUID_FN_REGEX.lastIndex = 0;
        for (const stmt of allStatements) {
          const hasInsert = /\bINSERT\b/i.test(stmt);
          const hasUuidFn = UUID_FN_REGEX.test(stmt);
          UUID_FN_REGEX.lastIndex = 0;
          if (hasInsert && hasUuidFn) {
            blockedStatements.push(stmt);
          } else {
            candidateAllowed.push(stmt);
          }
        }

        // Pass 2: implicit UUID check — INSERT omits a UUID-default column
        const finalAllowed: string[] = [];
        const implicitBlockInfo: Array<{ cols: string[] }> = [];
        for (const stmt of candidateAllowed) {
          if (/\bINSERT\b/i.test(stmt)) {
            const implicitCols = await this.getImplicitUuidColumns(
              stmt, pgSchema, cloudConfig.primaryCloud, databaseName
            );
            if (implicitCols.length > 0) {
              logger.debug('INSERT has implicit UUID-default columns', { executionId, implicitCols });
              blockedStatements.push(stmt);
              implicitBlockInfo.push({ cols: implicitCols });
            } else {
              finalAllowed.push(stmt);
            }
          } else {
            finalAllowed.push(stmt);
          }
        }

        if (blockedStatements.length > 0) {
          const implicitColsDesc = implicitBlockInfo.length > 0
            ? ` Columns with UUID defaults that must be explicitly set: ${[...new Set(implicitBlockInfo.flatMap(i => i.cols))].join(', ')}.`
            : '';
          const uuidErrorMsg =
            `${blockedStatements.length} INSERT statement(s) contain or rely on gen_random_uuid() which would generate different UUIDs on each cloud, causing data divergence.${implicitColsDesc} ` +
            'Use the Generate UUID button in the editor toolbar to replace gen_random_uuid() with explicit UUID literals.';

          if (!request.continueOnError) {
            logger.warn('Execution blocked: INSERT with UUID divergence risk in multi-cloud query', { executionId, blockedCount: blockedStatements.length });
            await this.executionManager.failExecution(executionId, uuidErrorMsg, 'UUID_DIVERGENCE');
            this.executionManager.completeActiveExecution(executionId);
            return;
          }

          // continueOnError: skip blocked statements, execute the rest
          logger.warn('Skipping INSERT(s) with UUID divergence risk due to continueOnError', { executionId, blockedCount: blockedStatements.length });
          processedQuery = finalAllowed.join('\n\n');

          if (!processedQuery.trim()) {
            await this.executionManager.failExecution(executionId, uuidErrorMsg, 'UUID_DIVERGENCE');
            this.executionManager.completeActiveExecution(executionId);
            return;
          }
        }
      }

      // Execute on each cloud
      const successes: boolean[] = [];
      let wasCancelled = false;

      for (const cloudName of cloudsToExecute) {
        // Check if cancelled before starting this cloud
        if (await this.executionManager.isCancelled(executionId)) {
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
            processedQuery,
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
          await this.executionManager.savePartialResults(executionId, { ...response });

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
      this.executionManager.completeActiveExecution(executionId);

      logger.info('Async query execution complete', {
        executionId,
        success: response.success,
        cloudsExecuted: cloudsToExecute,
        wasCancelled,
      });

      // ── ClickHouse sync (non-blocking, best-effort) ──────────────────
      // Fire after PG execution succeeds — only DDL statements are acted on,
      // everything else is a no-op inside syncAfterQuery.
      if (response.success && process.env.SYNC_TO_CLICKHOUSE !== 'false') {
        const pgSchema = request.pgSchema || 'public';
        const dbPools = DatabasePools.getInstance();
        const cloudConfig = dbPools.getCloudConfig();
        // Use the primary cloud pool for CH sync (source of truth)
        const primaryPool = dbPools.getPoolByName(cloudConfig.primaryCloud, databaseName);
        if (primaryPool) {
          clickHouseSyncService
            .syncAfterQuery(request.query, primaryPool, pgSchema)
            .then(syncResult => {
              if (syncResult.action !== 'skipped' && syncResult.action !== 'disabled') {
                logger.info('ClickHouse sync completed', { executionId, ...syncResult });
              }
            })
            .catch(err => {
              logger.error('ClickHouse sync failed (non-blocking)', { executionId, error: err.message });
            });
        }
      }
      // ─────────────────────────────────────────────────────────────────

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
      this.executionManager.completeActiveExecution(executionId);

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
   * Query information_schema to find UUID-default columns that are NOT explicitly
   * listed in the given INSERT statement's column list.
   * Returns column names that would be auto-generated with gen_random_uuid() by the DB.
   */
  private async getImplicitUuidColumns(
    stmt: string,
    pgSchema: string,
    cloudName: string,
    databaseName: string
  ): Promise<string[]> {
    // Parse: INSERT INTO [schema.]table [(col1, col2, ...)] VALUES/SELECT
    const match = stmt.match(
      /^\s*INSERT\s+INTO\s+(?:"?(\w+)"?\.)?"?(\w+)"?\s*(?:\(([^)]*)\))?\s*(?:VALUES|SELECT)/i
    );
    if (!match) return [];

    const tableSchema = match[1] || pgSchema || 'public';
    const tableName   = match[2];
    const columnListStr = match[3];

    // If no column list: all columns are implied — any UUID-default column will be auto-generated
    const explicitColumns = columnListStr
      ? columnListStr.split(',').map(c => c.trim().replace(/"/g, '').toLowerCase())
      : null;

    const pool = DatabasePools.getInstance().getPoolByName(cloudName, databaseName);
    if (!pool) return [];

    try {
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT column_name
           FROM information_schema.columns
           WHERE table_schema = $1
             AND table_name   = $2
             AND (column_default ILIKE '%gen_random_uuid%'
                  OR column_default ILIKE '%uuid_generate_v%')`,
          [tableSchema, tableName]
        );
        const uuidDefaultCols: string[] = result.rows.map((r: any) => r.column_name.toLowerCase());
        if (uuidDefaultCols.length === 0) return [];

        // No explicit column list → all UUID-default columns will be auto-generated
        if (explicitColumns === null) return uuidDefaultCols;

        // Return UUID-default columns missing from the explicit list
        return uuidDefaultCols.filter(col => !explicitColumns.includes(col));
      } finally {
        client.release();
      }
    } catch (err: any) {
      // Schema query failed — don't block, log and continue
      logger.warn('Failed to query information_schema for UUID defaults', { err: err.message });
      return [];
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
