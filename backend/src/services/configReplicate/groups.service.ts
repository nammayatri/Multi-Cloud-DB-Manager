import { Pool } from 'pg';
import DatabasePools from '../../config/database';
import logger from '../../utils/logger';
import { ConfigGroup, ConfigGroupSummary, GroupTableConfig } from '../../types/configReplicate';

const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS dual_db_manager.config_replicate_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    description TEXT,
    dimension_columns TEXT[] NOT NULL,
    created_by UUID REFERENCES dual_db_manager.users(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP,
    CONSTRAINT config_replicate_groups_name_check CHECK (length(btrim(name)) > 0),
    CONSTRAINT config_replicate_groups_dimensions_check CHECK (array_length(dimension_columns, 1) >= 1)
  );

  CREATE TABLE IF NOT EXISTS dual_db_manager.config_replicate_group_tables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL
      REFERENCES dual_db_manager.config_replicate_groups(id) ON DELETE CASCADE,
    schema_name VARCHAR(200) NOT NULL,
    table_name  VARCHAR(200) NOT NULL,
    dimension_columns TEXT[] NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    match_strategy VARCHAR(20) NOT NULL DEFAULT 'AUTO',
    match_key_columns TEXT[] NOT NULL DEFAULT '{}',
    column_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    fk_remap JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT config_replicate_group_tables_strategy_check CHECK (
      match_strategy IN ('AUTO', 'UNIQUE_KEY', 'SIMILARITY')
    )
  );

  CREATE TABLE IF NOT EXISTS dual_db_manager.config_replicate_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID REFERENCES dual_db_manager.config_replicate_groups(id) ON DELETE SET NULL,
    group_name VARCHAR(200) NOT NULL,
    group_snapshot JSONB NOT NULL,
    database_name VARCHAR(100) NOT NULL,
    cloud_name VARCHAR(100) NOT NULL,
    base_values TEXT[] NOT NULL,
    new_values  TEXT[] NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'RUNNING',
    applied_by UUID REFERENCES dual_db_manager.users(id) ON DELETE SET NULL,
    applied_by_username VARCHAR(200),
    summary JSONB,
    rows_inserted INTEGER NOT NULL DEFAULT 0,
    rows_updated  INTEGER NOT NULL DEFAULT 0,
    rows_deleted  INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    duration_ms INTEGER,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMP,
    CONSTRAINT config_replicate_runs_status_check CHECK (
      status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'ABORTED')
    ),
    CONSTRAINT config_replicate_runs_values_differ CHECK (base_values <> new_values)
  );

  CREATE TABLE IF NOT EXISTS dual_db_manager.config_replicate_run_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL
      REFERENCES dual_db_manager.config_replicate_runs(id) ON DELETE CASCADE,
    schema_name VARCHAR(200) NOT NULL,
    table_name  VARCHAR(200) NOT NULL,
    operation   VARCHAR(10)  NOT NULL,
    diff_id TEXT NOT NULL,
    sql TEXT NOT NULL,
    params JSONB NOT NULL DEFAULT '[]'::jsonb,
    row_diff JSONB,
    rows_affected INTEGER,
    position INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT config_replicate_run_items_operation_check CHECK (
      operation IN ('INSERT', 'UPDATE', 'DELETE')
    )
  );
`;

const CREATE_INDEXES = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_config_replicate_groups_name
    ON dual_db_manager.config_replicate_groups(lower(btrim(name)));
  CREATE UNIQUE INDEX IF NOT EXISTS idx_config_replicate_group_tables_unique
    ON dual_db_manager.config_replicate_group_tables(group_id, schema_name, table_name);
  CREATE INDEX IF NOT EXISTS idx_config_replicate_group_tables_group
    ON dual_db_manager.config_replicate_group_tables(group_id, position);
  CREATE INDEX IF NOT EXISTS idx_config_replicate_runs_recent
    ON dual_db_manager.config_replicate_runs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_config_replicate_runs_group
    ON dual_db_manager.config_replicate_runs(group_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_config_replicate_run_items_run
    ON dual_db_manager.config_replicate_run_items(run_id, position);
`;

const mapTable = (row: any): GroupTableConfig => ({
  id: row.id,
  schema: row.schema_name,
  table: row.table_name,
  dimensionColumns: row.dimension_columns || [],
  position: row.position,
  matchStrategy: row.match_strategy,
  matchKeyColumns: row.match_key_columns || [],
  columnConfig: row.column_config || {},
  fkRemap: row.fk_remap || {},
});

export class ConfigReplicateGroupsService {
  private get pool(): Pool {
    return DatabasePools.getInstance().history;
  }

  public async initializeSchema(): Promise<void> {
    try {
      await this.pool.query(CREATE_TABLES);
      await this.pool.query(CREATE_INDEXES);
      logger.info('Config replicate schema initialized');
    } catch (error: any) {
      logger.error('Failed to initialize config replicate schema:', error);
      throw error;
    }
  }

  public async list(): Promise<ConfigGroupSummary[]> {
    const result = await this.pool.query(
      `SELECT g.id, g.name, g.description, g.dimension_columns, g.created_at, g.updated_at,
              u.username AS created_by_username,
              (SELECT COUNT(*) FROM dual_db_manager.config_replicate_group_tables t
                WHERE t.group_id = g.id)::int AS table_count
       FROM dual_db_manager.config_replicate_groups g
       LEFT JOIN dual_db_manager.users u ON u.id = g.created_by
       ORDER BY g.name`
    );

    return result.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      dimensionColumns: r.dimension_columns || [],
      tableCount: r.table_count,
      createdByUsername: r.created_by_username,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  public async getById(id: string): Promise<ConfigGroup | null> {
    const groupResult = await this.pool.query(
      `SELECT g.*, u.username AS created_by_username
       FROM dual_db_manager.config_replicate_groups g
       LEFT JOIN dual_db_manager.users u ON u.id = g.created_by
       WHERE g.id = $1`,
      [id]
    );

    const group = groupResult.rows[0];
    if (!group) return null;

    const tablesResult = await this.pool.query(
      `SELECT * FROM dual_db_manager.config_replicate_group_tables
       WHERE group_id = $1 ORDER BY position, table_name`,
      [id]
    );

    return {
      id: group.id,
      name: group.name,
      description: group.description,
      dimensionColumns: group.dimension_columns || [],
      createdBy: group.created_by,
      createdByUsername: group.created_by_username,
      createdAt: group.created_at,
      updatedAt: group.updated_at,
      tables: tablesResult.rows.map(mapTable),
    };
  }

  private async writeTables(
    client: any,
    groupId: string,
    tables: GroupTableConfig[]
  ): Promise<void> {
    await client.query(
      'DELETE FROM dual_db_manager.config_replicate_group_tables WHERE group_id = $1',
      [groupId]
    );

    for (const [index, table] of tables.entries()) {
      await client.query(
        `INSERT INTO dual_db_manager.config_replicate_group_tables (
           group_id, schema_name, table_name, dimension_columns, position,
           match_strategy, match_key_columns, column_config, fk_remap
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          groupId,
          table.schema,
          table.table,
          table.dimensionColumns,
          table.position ?? index,
          table.matchStrategy,
          table.matchKeyColumns || [],
          JSON.stringify(table.columnConfig || {}),
          JSON.stringify(table.fkRemap || {}),
        ]
      );
    }
  }

  public async create(
    input: { name: string; description?: string; dimensionColumns: string[]; tables: GroupTableConfig[] },
    userId: string
  ): Promise<ConfigGroup> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `INSERT INTO dual_db_manager.config_replicate_groups
           (name, description, dimension_columns, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.name.trim(), input.description?.trim() || null, input.dimensionColumns, userId]
      );

      const groupId = result.rows[0].id;
      await this.writeTables(client, groupId, input.tables);
      await client.query('COMMIT');

      const created = await this.getById(groupId);
      if (!created) throw new Error('Group vanished immediately after creation');
      return created;
    } catch (error) {
      await client.query('ROLLBACK').catch(err => logger.error('Rollback failed:', err));
      throw error;
    } finally {
      client.release();
    }
  }

  public async update(
    id: string,
    input: { name: string; description?: string; dimensionColumns: string[]; tables: GroupTableConfig[] }
  ): Promise<ConfigGroup | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `UPDATE dual_db_manager.config_replicate_groups
         SET name = $2, description = $3, dimension_columns = $4, updated_at = NOW()
         WHERE id = $1 RETURNING id`,
        [id, input.name.trim(), input.description?.trim() || null, input.dimensionColumns]
      );

      if (result.rowCount === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      await this.writeTables(client, id, input.tables);
      await client.query('COMMIT');

      return this.getById(id);
    } catch (error) {
      await client.query('ROLLBACK').catch(err => logger.error('Rollback failed:', err));
      throw error;
    } finally {
      client.release();
    }
  }

  public async remove(id: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM dual_db_manager.config_replicate_groups WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export default new ConfigReplicateGroupsService();
