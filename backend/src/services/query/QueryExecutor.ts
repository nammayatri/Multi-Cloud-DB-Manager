import { Pool, QueryResult } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import DatabasePools from '../../config/database';
import logger from '../../utils/logger';
import { QueryRequest, QueryResponse } from '../../types';
import QueryValidator from './QueryValidator';
import ExecutionManager from './ExecutionManager';

// Clean field info - only keep essential properties
interface CleanField {
  name: string;
  dataTypeID?: number;
}

// Clean result without internal PostgreSQL metadata
interface CleanQueryResult {
  command: string;
  rowCount: number | null;
  rows: any[];
  fields: CleanField[];
}

/**
 * QueryExecutor - Handles actual query execution on databases
 */
export class QueryExecutor {
  private dbPools: DatabasePools;
  private maxTimeout: number;
  private statementTimeout: number;
  private executionManager: ExecutionManager;

  constructor(executionManager: ExecutionManager) {
    this.dbPools = DatabasePools.getInstance();
    this.maxTimeout = parseInt(process.env.MAX_QUERY_TIMEOUT_MS || '300000');
    this.statementTimeout = parseInt(process.env.STATEMENT_TIMEOUT_MS || '300000'); // 5 minutes default
    this.executionManager = executionManager;
  }

  /**
   * Clean PostgreSQL result - remove internal metadata, keep only essential fields
   */
  private cleanResult(result: QueryResult): CleanQueryResult {
    return {
      command: result.command,
      rowCount: result.rowCount,
      rows: result.rows,
      fields: result.fields.map(f => ({
        name: f.name,
        dataTypeID: f.dataTypeID
      }))
    };
  }

  /**
   * Execute query with timeout protection
   */
  public async executeWithTimeout(
    pool: Pool,
    query: string,
    timeout: number,
    executionId?: string
  ): Promise<{ result: QueryResult; duration: number }> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (executionId) {
          // Trigger cancellation
          this.executionManager.markAsCancelled(executionId);
        }
        reject(new Error(`Query timeout after ${timeout}ms`));
      }, timeout);

      // Execute query and handle both sync and async errors
      Promise.resolve().then(async () => {
        try {
          const result = await pool.query(query);
          clearTimeout(timeoutId);
          const duration = Date.now() - startTime;
          resolve({ result, duration });
        } catch (error) {
          clearTimeout(timeoutId);
          reject(error);
        }
      }).catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
    });
  }

  /**
   * Execute query on a single database (supports multiple statements)
   */
  public async executeOnDatabase(
    cloudName: string,
    databaseName: string,
    query: string,
    timeout: number,
    pgSchema?: string,
    continueOnError: boolean = false,
    executionId?: string
  ): Promise<{
    success: boolean;
    result?: CleanQueryResult;
    results?: Array<{
      statement: string;
      success: boolean;
      result?: CleanQueryResult;
      error?: string;
      rowsAffected?: number;
    }>;
    error?: string;
    duration_ms: number;
    statementCount?: number;
    wasCancelled?: boolean;
  }> {
    const pool = this.dbPools.getPoolByName(cloudName, databaseName);

    if (!pool) {
      throw new Error(`Pool not found for ${cloudName}_${databaseName}`);
    }

    const startTime = Date.now();

    // Split into multiple statements first (for error handling)
    const statements = QueryValidator.splitStatements(query)
      .map(s => QueryValidator.addDefaultLimit(s));

    try {
      // If pgSchema is provided, we need to set search_path
      if (pgSchema) {
      const client = await pool.connect();
      
      // Register this execution if we have an executionId
      if (executionId) {
        const cloudKey = `${cloudName}_${databaseName}`;
        const pidResult = await client.query('SELECT pg_backend_pid() as pid');
        const backendPid = pidResult.rows[0]?.pid;
        this.executionManager.registerActiveExecution(executionId, cloudKey, client, backendPid);
      }

      try {
        // Check for cancellation
        if (executionId && this.executionManager.isCancelled(executionId)) {
          return {
            success: false,
            error: 'Query was cancelled by user',
            duration_ms: Date.now() - startTime,
            wasCancelled: true
          };
        }

        // Validate pgSchema to prevent SQL injection
        const validation = QueryValidator.validateSchemaName(pgSchema);
        if (!validation.valid) {
          throw new Error(validation.error);
        }

        // Safe to use without quotes after strict validation
        // Note: pg identifiers can't use parameterized queries, but validation ensures safety
        await client.query(`SET search_path TO ${pgSchema}, public`);

        logger.info(`Executing query on ${cloudName}/${databaseName}`, {
          cloudName,
          databaseName,
          pgSchema,
          statementCount: statements.length,
          continueOnError
        });

          if (statements.length === 1) {
            // Single statement
            try {
              const result = await client.query(statements[0]);
              const duration = Date.now() - startTime;

              logger.info(`Query successful on ${cloudName}/${databaseName}`, {
                cloudName,
                databaseName,
                duration_ms: duration,
                rows: result.rowCount,
              });

              return {
                success: true,
                result: this.cleanResult(result),
                duration_ms: duration,
              };
            } catch (error: any) {
              const duration = Date.now() - startTime;
              return {
                success: false,
                error: error?.message || 'Unknown error',
                duration_ms: duration,
              };
            }
          } else {
            // Multiple statements with pgSchema - execute all and collect results
            return await this.executeMultipleStatements(
              client,
              statements,
              cloudName,
              databaseName,
              startTime,
              continueOnError,
              executionId
            );
          }
        } finally {
          client.release();
          if (executionId) {
            this.executionManager.releaseClient(executionId, `${cloudName}_${databaseName}`);
          }
        }
      }

      // No pgSchema - use original logic
      logger.info(`Executing query on ${cloudName}/${databaseName}`, {
        cloudName,
        databaseName,
        query: query.substring(0, 100),
        statementCount: statements.length,
        continueOnError
      });

      if (statements.length === 1) {
        // Single statement - original behavior
        try {
          const { result, duration } = await this.executeWithTimeout(pool, query, timeout, executionId);

          logger.info(`Query successful on ${cloudName}/${databaseName}`, {
            cloudName,
            databaseName,
            duration_ms: duration,
            rows: result.rowCount,
          });

          return {
            success: true,
            result: this.cleanResult(result),
            duration_ms: duration,
          };
        } catch (error: any) {
          return {
            success: false,
            error: error?.message || 'Unknown error',
            duration_ms: Date.now() - startTime,
          };
        }
      } else {
        // Multiple statements without pgSchema - execute each and collect results
        const client = await pool.connect();
        
        // Register this execution if we have an executionId
        if (executionId) {
          const cloudKey = `${cloudName}_${databaseName}`;
          const pidResult = await client.query('SELECT pg_backend_pid() as pid');
          const backendPid = pidResult.rows[0]?.pid;
          this.executionManager.registerActiveExecution(executionId, cloudKey, client, backendPid);
        }

        try {
          return await this.executeMultipleStatements(
            client,
            statements,
            cloudName,
            databaseName,
            startTime,
            continueOnError,
            executionId
          );
        } finally {
          client.release();
          if (executionId) {
            this.executionManager.releaseClient(executionId, `${cloudName}_${databaseName}`);
          }
        }
      }
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const errorMessage = error?.message || 'Unknown error';

      logger.error(`Query failed on ${cloudName}/${databaseName}`, {
        cloudName,
        databaseName,
        error: errorMessage,
        duration_ms: duration,
        statementCount: statements.length,
      });

      // For multi-statement queries, return results format even on error
      if (statements.length > 1) {
        // Return all statements with the connection error
        const results = statements.map(statement => ({
          statement: statement,
          success: false,
          error: errorMessage,
        }));
        
        return {
          success: false,
          results,
          duration_ms: duration,
          statementCount: statements.length,
        };
      }

      // Single statement - return simple error format
      return {
        success: false,
        error: errorMessage,
        duration_ms: duration,
      };
    }
  }

  /**
   * Execute multiple statements with transaction handling
   */
  private async executeMultipleStatements(
    client: any,
    statements: string[],
    cloudName: string,
    databaseName: string,
    startTime: number,
    continueOnError: boolean,
    executionId?: string
  ): Promise<{
    success: boolean;
    results: Array<{
      statement: string;
      success: boolean;
      result?: CleanQueryResult;
      error?: string;
      rowsAffected?: number;
    }>;
    duration_ms: number;
    statementCount: number;
  }> {
    const results = [];
    let allSuccess = true;
    let inTransaction = false;

    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];

      // Check for cancellation before each statement
      if (executionId && this.executionManager.isCancelled(executionId)) {
        results.push({
          statement: statement,
          success: false,
          error: 'Query was cancelled by user'
        });
        allSuccess = false;
        break;
      }

      // Check if this is a transaction control statement
      if (QueryValidator.isTransactionStatement(statement)) {
        const upper = statement.trim().toUpperCase();
        if (upper.startsWith('BEGIN') || upper.startsWith('START TRANSACTION')) {
          inTransaction = true;
        } else if (upper.startsWith('COMMIT') || upper.startsWith('ROLLBACK')) {
          inTransaction = false;
        }
      }

      try {
        // Add timeout for each statement to prevent indefinite hangs
        const result = await Promise.race([
          client.query(statement),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Statement timeout after ${this.statementTimeout}ms`)), this.statementTimeout)
          )
        ]) as QueryResult;
        
        results.push({
          statement: statement,
          success: true,
          result: this.cleanResult(result),
          rowsAffected: result.rowCount || 0,
        });
      } catch (error: any) {
        allSuccess = false;
        const errorMessage = error?.message || 'Unknown error';

        results.push({
          statement: statement,
          success: false,
          error: errorMessage,
        });

        // If we're in a transaction and a query fails, auto-rollback
        if (inTransaction && !QueryValidator.isTransactionStatement(statement)) {
          try {
            await client.query('ROLLBACK');
            results.push({
              statement: 'ROLLBACK (auto)',
              success: true,
              result: undefined,
              rowsAffected: 0,
            });
            inTransaction = false;
          } catch (rollbackError: any) {
            results.push({
              statement: 'ROLLBACK (auto)',
              success: false,
              error: rollbackError?.message || 'Failed to rollback',
            });
          }
        }

        // Only stop on error if continueOnError is false
        if (!continueOnError) {
          break;
        }
      }

      // Update progress
      if (executionId) {
        this.executionManager.updateProgress(executionId, results.length, statements.length, statement);
      }
    }

    const duration = Date.now() - startTime;

    logger.info(`Multi-statement query executed on ${cloudName}/${databaseName}`, {
      cloudName,
      databaseName,
      duration_ms: duration,
      statementCount: statements.length,
      successCount: results.filter(r => r.success).length,
      inTransaction,
      continueOnError
    });

    return {
      success: allSuccess,
      results,
      duration_ms: duration,
      statementCount: statements.length,
    };
  }
}

export default QueryExecutor;
