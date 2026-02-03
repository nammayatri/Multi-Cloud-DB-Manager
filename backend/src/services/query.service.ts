import { Pool, QueryResult } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import DatabasePools from '../config/database';
import logger from '../utils/logger';
import { QueryRequest, QueryResponse } from '../types';

class QueryService {
  private dbPools: DatabasePools;
  private maxTimeout: number;

  constructor() {
    this.dbPools = DatabasePools.getInstance();
    this.maxTimeout = parseInt(process.env.MAX_QUERY_TIMEOUT_MS || '300000');
  }

  /**
   * Execute query with timeout protection
   */
  private async executeWithTimeout(
    pool: Pool,
    query: string,
    timeout: number
  ): Promise<{ result: QueryResult; duration: number }> {
    const startTime = Date.now();

    return new Promise(async (resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Query timeout after ${timeout}ms`));
      }, timeout);

      try {
        const result = await pool.query(query);
        clearTimeout(timeoutId);
        const duration = Date.now() - startTime;
        resolve({ result, duration });
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  /**
   * Execute query on a single database (supports multiple statements)
   */
  private async executeOnDatabase(
    cloudName: string,
    databaseName: string,
    query: string,
    timeout: number,
    pgSchema?: string
  ): Promise<{
    success: boolean;
    result?: QueryResult;
    results?: Array<{
      statement: string;
      success: boolean;
      result?: QueryResult;
      error?: string;
      rowsAffected?: number;
    }>;
    error?: string;
    duration_ms: number;
    statementCount?: number;
  }> {
    const pool = this.dbPools.getPoolByName(cloudName, databaseName);

    if (!pool) {
      throw new Error(`Pool not found for ${cloudName}_${databaseName}`);
    }

    const startTime = Date.now();

    // Split into multiple statements first (for error handling)
    const statements = this.splitStatements(query);

    try {
      // If pgSchema is provided, we need to set search_path
      if (pgSchema) {
        const client = await pool.connect();
        try {
          await client.query(`SET search_path TO "${pgSchema}", public`);

          logger.info(`Executing query on ${cloudName}/${databaseName}`, {
            cloudName,
            databaseName,
            pgSchema,
            query: query.substring(0, 100),
            statementCount: statements.length,
          });

          if (statements.length === 1) {
            // Single statement
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
              result,
              duration_ms: duration,
            };
          } else {
            // Multiple statements with pgSchema
            const results = [];
            let allSuccess = true;
            let inTransaction = false;
            let transactionAborted = false;

            for (let i = 0; i < statements.length; i++) {
              const statement = statements[i];

              // Check if this is a transaction control statement
              if (this.isTransactionStatement(statement)) {
                const upper = statement.trim().toUpperCase();
                if (upper.startsWith('BEGIN') || upper.startsWith('START TRANSACTION')) {
                  inTransaction = true;
                  transactionAborted = false;
                } else if (upper.startsWith('COMMIT') || upper.startsWith('ROLLBACK')) {
                  inTransaction = false;
                  transactionAborted = false;
                }
              }

              try {
                const result = await client.query(statement);
                results.push({
                  statement: statement,
                  success: true,
                  result,
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
                if (inTransaction && !this.isTransactionStatement(statement)) {
                  transactionAborted = true;

                  // Try to rollback automatically
                  try {
                    await client.query('ROLLBACK');
                    results.push({
                      statement: 'ROLLBACK (auto)',
                      success: true,
                      result: undefined,
                      rowsAffected: 0,
                    });
                    inTransaction = false;
                    transactionAborted = false;
                  } catch (rollbackError: any) {
                    results.push({
                      statement: 'ROLLBACK (auto)',
                      success: false,
                      error: rollbackError?.message || 'Failed to rollback',
                    });
                  }
                }

                // Stop on error
                break;
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
              transactionAborted,
            });

            return {
              success: allSuccess,
              results,
              duration_ms: duration,
              statementCount: statements.length,
            };
          }
        } finally {
          client.release();
        }
      }

      // No pgSchema - use original logic
      logger.info(`Executing query on ${cloudName}/${databaseName}`, {
        cloudName,
        databaseName,
        query: query.substring(0, 100),
        statementCount: statements.length,
      });

      if (statements.length === 1) {
        // Single statement - original behavior
        const { result, duration } = await this.executeWithTimeout(pool, query, timeout);

        logger.info(`Query successful on ${cloudName}/${databaseName}`, {
          cloudName,
          databaseName,
          duration_ms: duration,
          rows: result.rowCount,
        });

        return {
          success: true,
          result,
          duration_ms: duration,
        };
      } else {
        // Multiple statements - execute each and collect results
        const results = [];
        let allSuccess = true;
        let inTransaction = false;

        for (const statement of statements) {
          // Check if this is a transaction control statement
          if (this.isTransactionStatement(statement)) {
            const upper = statement.trim().toUpperCase();
            if (upper.startsWith('BEGIN') || upper.startsWith('START TRANSACTION')) {
              inTransaction = true;
            } else if (upper.startsWith('COMMIT') || upper.startsWith('ROLLBACK')) {
              inTransaction = false;
            }
          }

          try {
            const { result } = await this.executeWithTimeout(pool, statement, timeout);
            results.push({
              statement: statement,
              success: true,
              result,
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

            // Always rollback on ANY error if in transaction
            if (inTransaction && !this.isTransactionStatement(statement)) {
              try {
                const { result } = await this.executeWithTimeout(pool, 'ROLLBACK', timeout);
                results.push({
                  statement: 'ROLLBACK (auto)',
                  success: true,
                  result,
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

            // Always stop on ANY error - never continue with open transaction
            break;
          }
        }

        const duration = Date.now() - startTime;

        logger.info(`Multi-statement query executed on ${cloudName}/${databaseName}`, {
          cloudName,
          databaseName,
          duration_ms: duration,
          statementCount: statements.length,
          successCount: results.filter(r => r.success).length,
        });

        return {
          success: allSuccess,
          results,
          duration_ms: duration,
          statementCount: statements.length,
        };
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
        return {
          success: false,
          results: [
            {
              statement: statements[0],
              success: false,
              error: errorMessage,
            }
          ],
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
   * Execute query on configured clouds (dynamic multi-cloud support)
   */
  public async executeDual(request: QueryRequest): Promise<QueryResponse> {
    const executionId = uuidv4();
    const timeout = Math.min(request.timeout || this.maxTimeout, this.maxTimeout);

    logger.info('Starting query execution', {
      executionId,
      database: request.database,
      mode: request.mode,
      timeout,
    });

    const response: QueryResponse = {
      id: executionId,
      success: false,
    };

    try {
      // Get cloud configuration
      const cloudConfig = this.dbPools.getCloudConfig();
      const pgSchema = request.pgSchema || 'public';
      const databaseName = request.database; // Use database name directly from request

      // Determine which clouds to execute on based on mode
      const cloudsToExecute: string[] = [];

      if (request.mode === 'both') {
        // Execute on all clouds
        cloudsToExecute.push(cloudConfig.primaryCloud);
        cloudsToExecute.push(...cloudConfig.secondaryClouds);
      } else {
        // Execute on specific cloud
        cloudsToExecute.push(request.mode);
      }

      // Execute on each cloud
      const successes: boolean[] = [];
      for (const cloudName of cloudsToExecute) {
        try {
          const result = await this.executeOnDatabase(cloudName, databaseName, request.query, timeout, pgSchema);
          response[cloudName] = result;
          successes.push(result.success);
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

      // Determine overall success (all must succeed)
      response.success = successes.length > 0 && successes.every(s => s);

      logger.info('Query execution complete', {
        executionId,
        success: response.success,
        cloudsExecuted: cloudsToExecute,
      });

      return response;
    } catch (error: any) {
      logger.error('Query execution failed', {
        executionId,
        error: error.message,
      });

      throw error;
    }
  }

  /**
   * Validate SQL query (basic validation)
   */
  public validateQuery(query: string): { valid: boolean; error?: string } {
    // Remove comments and whitespace
    const cleanQuery = query
      .replace(/--.*$/gm, '') // Remove single-line comments
      .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
      .trim();

    if (!cleanQuery) {
      return { valid: false, error: 'Query is empty' };
    }

    // Check for dangerous commands (customize based on your needs)
    const dangerousPatterns = [
      /^\s*DROP\s+DATABASE/i,
      /^\s*DROP\s+SCHEMA/i,
      /^\s*CREATE\s+DATABASE/i,
      /^\s*CREATE\s+SCHEMA/i,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(cleanQuery)) {
        return {
          valid: false,
          error: 'This operation is not allowed for safety reasons',
        };
      }
    }

    return { valid: true };
  }

  /**
   * Parse multi-statement queries
   */
  /**
   * Add default LIMIT to SELECT queries if not present
   */
  private addDefaultLimit(query: string): string {
    const trimmed = query.trim();
    const upperQuery = trimmed.toUpperCase();

    // Only apply to SELECT queries (not INSERT, UPDATE, DELETE, etc.)
    if (!upperQuery.startsWith('SELECT') && !upperQuery.startsWith('WITH')) {
      return query;
    }

    // Check if LIMIT already exists (case insensitive)
    if (/\bLIMIT\s+\d+/i.test(query)) {
      return query;
    }

    // Add LIMIT 10
    return `${trimmed}\nLIMIT 10`;
  }

  public splitStatements(query: string): string[] {
    // Remove SQL comments
    const withoutComments = query
      .replace(/--.*$/gm, '') // Remove single-line comments
      .replace(/\/\*[\s\S]*?\*\//g, ''); // Remove multi-line comments

    // Split by semicolon and clean up
    const statements = withoutComments
      .split(';')
      .map((stmt) => stmt.trim())
      .filter((stmt) => stmt.length > 0)
      .map((stmt) => this.addDefaultLimit(stmt)); // Add default LIMIT to SELECT queries

    return statements;
  }

  /**
   * Check if query is a transaction statement
   */
  public isTransactionStatement(query: string): boolean {
    const cleanQuery = query.trim().toUpperCase();
    return (
      cleanQuery.startsWith('BEGIN') ||
      cleanQuery.startsWith('COMMIT') ||
      cleanQuery.startsWith('ROLLBACK') ||
      cleanQuery.startsWith('START TRANSACTION')
    );
  }
}

export default new QueryService();
