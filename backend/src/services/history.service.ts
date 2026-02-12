import DatabasePools from '../config/database';
import logger from '../utils/logger';
import { QueryExecution, QueryHistoryFilter, QueryResponse } from '../types';

class HistoryService {
  private dbPools: DatabasePools;

  constructor() {
    this.dbPools = DatabasePools.getInstance();
  }

  /**
   * Initialize history database schema
   */
  public async initializeSchema() {
    const createSchema = `CREATE SCHEMA IF NOT EXISTS dual_db_manager;`;

    const setSearchPath = `SET search_path TO dual_db_manager, public;`;

    const createQueryHistoryTable = `
      CREATE TABLE IF NOT EXISTS dual_db_manager.query_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES dual_db_manager.users(id) ON DELETE CASCADE,
        query TEXT NOT NULL,
        database_name VARCHAR(50) NOT NULL,
        execution_mode VARCHAR(50) NOT NULL,
        cloud_results JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `;

    const createIndexes = `
      CREATE INDEX IF NOT EXISTS idx_query_history_user_id ON dual_db_manager.query_history(user_id);
      CREATE INDEX IF NOT EXISTS idx_query_history_created_at ON dual_db_manager.query_history(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_query_history_database ON dual_db_manager.query_history(database_name);
    `;

    try {
      await this.dbPools.history.query(createSchema);
      await this.dbPools.history.query(setSearchPath);
      await this.dbPools.history.query(createQueryHistoryTable);
      await this.dbPools.history.query(createIndexes);
      logger.info('History database schema initialized');
    } catch (error) {
      logger.error('Failed to initialize history schema:', error);
      throw error;
    }
  }

  /**
   * Check if query is read-only (SELECT, WITH, EXPLAIN, SHOW)
   */
  private isReadOnlyQuery(query: string): boolean {
    const normalizedQuery = query.trim().toUpperCase();
    return (
      normalizedQuery.startsWith('SELECT') ||
      normalizedQuery.startsWith('WITH') ||
      normalizedQuery.startsWith('EXPLAIN') ||
      normalizedQuery.startsWith('SHOW')
    );
  }

  /**
   * Clean up cloud result to remove verbose PostgreSQL type information
   */
  private cleanCloudResult(result: any): any {
    if (!result) return result;

    // If it's a single result with verbose data
    if (result.result) {
      return {
        success: result.success,
        duration_ms: result.duration_ms,
        error: result.error,
        rowCount: result.result?.rowCount,
        command: result.result?.command,
      };
    }

    // If it's multiple results (multi-statement query)
    if (result.results) {
      return {
        success: result.success,
        duration_ms: result.duration_ms,
        statementCount: result.statementCount,
        results: result.results.map((r: any) => ({
          success: r.success,
          statement: r.statement,
          error: r.error,
          rowsAffected: r.rowsAffected || r.result?.rowCount,
          command: r.result?.command,
        })),
      };
    }

    // If it's just an error
    if (result.error) {
      return {
        success: result.success,
        duration_ms: result.duration_ms,
        error: result.error,
      };
    }

    return result;
  }

  /**
   * Save query execution to history (only write queries)
   */
  public async saveQueryExecution(
    userId: string,
    query: string,
    database: string, // Database name (e.g., 'bpp', 'bap')
    mode: string, // Dynamic cloud mode
    response: QueryResponse
  ): Promise<void> {
    // Skip saving SELECT queries to history
    if (this.isReadOnlyQuery(query)) {
      logger.debug('Skipping read-only query from history');
      return;
    }

    // Build cloud_results JSONB dynamically from response, cleaning up verbose data
    const cloudResults: Record<string, any> = {};
    for (const key of Object.keys(response)) {
      if (key === 'id' || key === 'success') continue;
      cloudResults[key] = this.cleanCloudResult(response[key as keyof QueryResponse]);
    }

    const sql = `
      INSERT INTO dual_db_manager.query_history (
        id, user_id, query, database_name, execution_mode, cloud_results
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `;

    const values = [
      response.id,
      userId,
      query,
      database,
      mode,
      JSON.stringify(cloudResults),
    ];

    try {
      await this.dbPools.history.query(sql, values);
      logger.info('Query execution saved to history', { executionId: response.id });
    } catch (error) {
      logger.error('Failed to save query to history:', error);
      // Don't throw - history failure shouldn't fail the query
    }
  }

  /**
   * Get query history with filters
   */
  public async getHistory(filter: QueryHistoryFilter): Promise<QueryExecution[]> {
    let sql = `
      SELECT
        qh.id,
        qh.user_id,
        qh.query,
        qh.database_name,
        qh.execution_mode,
        qh.cloud_results,
        qh.created_at,
        u.email,
        u.name
      FROM dual_db_manager.query_history qh
      JOIN dual_db_manager.users u ON qh.user_id = u.id
      WHERE 1=1
    `;

    const values: any[] = [];
    let paramCount = 1;

    if (filter.user_id) {
      sql += ` AND qh.user_id = $${paramCount++}`;
      values.push(filter.user_id);
    }

    if (filter.schema) {
      sql += ` AND qh.database_name = $${paramCount++}`;
      values.push(filter.schema);
    }

    if (filter.success !== undefined) {
      if (filter.success) {
        // All cloud results have success = true
        sql += ` AND NOT EXISTS (
          SELECT 1 FROM jsonb_each(qh.cloud_results) AS cr
          WHERE (cr.value->>'success')::boolean = false
        )`;
      } else {
        // At least one cloud result has success = false
        sql += ` AND EXISTS (
          SELECT 1 FROM jsonb_each(qh.cloud_results) AS cr
          WHERE (cr.value->>'success')::boolean = false
        )`;
      }
    }

    if (filter.start_date) {
      sql += ` AND qh.created_at >= $${paramCount++}`;
      values.push(filter.start_date);
    }

    if (filter.end_date) {
      sql += ` AND qh.created_at <= $${paramCount++}`;
      values.push(filter.end_date);
    }

    sql += ` ORDER BY qh.created_at DESC`;

    if (filter.limit) {
      sql += ` LIMIT $${paramCount++}`;
      values.push(filter.limit);
    }

    if (filter.offset) {
      sql += ` OFFSET $${paramCount++}`;
      values.push(filter.offset);
    }

    try {
      const result = await this.dbPools.history.query(sql, values);
      return result.rows;
    } catch (error) {
      logger.error('Failed to fetch query history:', error);
      throw error;
    }
  }

  /**
   * Get single query execution by ID
   */
  public async getExecutionById(id: string): Promise<QueryExecution | null> {
    const sql = `
      SELECT * FROM dual_db_manager.query_history WHERE id = $1
    `;

    try {
      const result = await this.dbPools.history.query(sql, [id]);
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Failed to fetch execution by ID:', error);
      throw error;
    }
  }

  // Note: findOrCreateUser is no longer needed as we use the users table directly from auth
}

export default new HistoryService();
