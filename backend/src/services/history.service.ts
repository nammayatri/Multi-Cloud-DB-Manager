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
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES dual_db_manager.users(id) ON DELETE CASCADE,
        query TEXT NOT NULL,
        database_schema VARCHAR(10) NOT NULL CHECK (database_schema IN ('primary', 'secondary')),
        execution_mode VARCHAR(10) NOT NULL CHECK (execution_mode IN ('both', 'gcp', 'aws')),
        gcp_success BOOLEAN,
        aws_success BOOLEAN,
        gcp_result JSONB,
        aws_result JSONB,
        gcp_error TEXT,
        aws_error TEXT,
        gcp_duration_ms INTEGER,
        aws_duration_ms INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `;

    const createIndexes = `
      CREATE INDEX IF NOT EXISTS idx_query_history_user_id ON dual_db_manager.query_history(user_id);
      CREATE INDEX IF NOT EXISTS idx_query_history_created_at ON dual_db_manager.query_history(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_query_history_schema ON dual_db_manager.query_history(database_schema);
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

    const sql = `
      INSERT INTO dual_db_manager.query_history (
        id, user_id, query, database_schema, execution_mode,
        gcp_success, aws_success,
        gcp_result, aws_result,
        gcp_error, aws_error,
        gcp_duration_ms, aws_duration_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `;

    const values = [
      response.id,
      userId,
      query,
      database,
      mode,
      response.gcp ? response.gcp.success : null,
      response.aws ? response.aws.success : null,
      response.gcp?.result ? JSON.stringify(response.gcp.result) : null,
      response.aws?.result ? JSON.stringify(response.aws.result) : null,
      response.gcp?.error || null,
      response.aws?.error || null,
      response.gcp?.duration_ms || null,
      response.aws?.duration_ms || null,
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
        qh.database_schema,
        qh.execution_mode,
        qh.gcp_success,
        qh.aws_success,
        qh.gcp_result,
        qh.aws_result,
        qh.gcp_error,
        qh.aws_error,
        qh.gcp_duration_ms,
        qh.aws_duration_ms,
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
      // Map frontend schema names to database schema names
      const schemaMapping: Record<string, string> = {
        'primary': 'bpp',
        'secondary': 'bap'
      };
      const dbSchema = schemaMapping[filter.schema] || filter.schema;

      sql += ` AND qh.database_schema = $${paramCount++}`;
      values.push(dbSchema);
    }

    if (filter.success !== undefined) {
      if (filter.success) {
        // Success: At least one cloud succeeded (and none failed)
        sql += ` AND (
          (qh.gcp_success = true OR qh.aws_success = true)
          AND (qh.gcp_success IS NULL OR qh.gcp_success = true)
          AND (qh.aws_success IS NULL OR qh.aws_success = true)
        )`;
      } else {
        // Failed: At least one cloud failed (or both failed)
        sql += ` AND (
          qh.gcp_success = false OR qh.aws_success = false
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
