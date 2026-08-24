import { Pool } from 'pg';
import DatabasePools from '../../config/database';
import logger from '../../utils/logger';
import {
  ApplyResult,
  ConfigGroup,
  RunItemRecord,
  RunStatus,
  RunSummaryRecord,
} from '../../types/configReplicate';

/**
 * Row-level audit is the bulky, sensitive half: params holds the actual config
 * values written. Setting this prunes run_items past N days while keeping every
 * run summary forever, so "who replicated what, when, how many rows" survives
 * but the payload does not linger. Unset means keep everything.
 */
const RETENTION_DAYS = parseInt(process.env.CONFIG_REPLICATE_RUN_ITEM_RETENTION_DAYS || '0', 10);
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

interface RecordInput {
  group: ConfigGroup;
  database: string;
  cloud: string;
  baseValues: string[];
  newValues: string[];
  status: RunStatus;
  error: string | null;
  summary: ApplyResult['summary'];
  totals: { inserted: number; updated: number; deleted: number };
  items: RunItemRecord[];
  durationMs: number;
  user: { id: string; username: string };
}

const mapRun = (row: any): RunSummaryRecord => ({
  id: row.id,
  groupId: row.group_id,
  groupName: row.group_name,
  databaseName: row.database_name,
  cloudName: row.cloud_name,
  baseValues: row.base_values || [],
  newValues: row.new_values || [],
  status: row.status,
  appliedByUsername: row.applied_by_username,
  rowsInserted: row.rows_inserted,
  rowsUpdated: row.rows_updated,
  rowsDeleted: row.rows_deleted,
  error: row.error,
  durationMs: row.duration_ms,
  createdAt: row.created_at,
  finishedAt: row.finished_at,
});

export class ConfigReplicateRunsService {
  private lastSweepAt = 0;

  private get pool(): Pool {
    return DatabasePools.getInstance().history;
  }

  private async pruneExpiredItems(): Promise<void> {
    if (!RETENTION_DAYS || RETENTION_DAYS <= 0) return;
    if (Date.now() - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = Date.now();

    try {
      const result = await this.pool.query(
        `DELETE FROM dual_db_manager.config_replicate_run_items i
          USING dual_db_manager.config_replicate_runs r
          WHERE i.run_id = r.id
            AND r.created_at < NOW() - ($1 || ' days')::interval`,
        [RETENTION_DAYS]
      );
      if (result.rowCount) {
        logger.info('Pruned config replicate run items', {
          rows: result.rowCount,
          retentionDays: RETENTION_DAYS,
        });
      }
    } catch (error: any) {
      logger.error('Failed to prune config replicate run items:', error);
    }
  }

  public async record(input: RecordInput): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const runResult = await client.query(
        `INSERT INTO dual_db_manager.config_replicate_runs (
           group_id, group_name, group_snapshot, database_name, cloud_name,
           base_values, new_values, status, applied_by, applied_by_username,
           summary, rows_inserted, rows_updated, rows_deleted, error,
           duration_ms, finished_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
         RETURNING id`,
        [
          input.group.id,
          input.group.name,
          JSON.stringify(input.group),
          input.database,
          input.cloud,
          input.baseValues,
          input.newValues,
          input.status,
          input.user.id,
          input.user.username,
          JSON.stringify(input.summary),
          input.totals.inserted,
          input.totals.updated,
          input.totals.deleted,
          input.error,
          input.durationMs,
        ]
      );

      const runId = runResult.rows[0].id;

      for (const item of input.items) {
        await client.query(
          `INSERT INTO dual_db_manager.config_replicate_run_items (
             run_id, schema_name, table_name, operation, diff_id,
             sql, params, row_diff, rows_affected, position
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            runId,
            item.schema,
            item.table,
            item.operation,
            item.diffId,
            item.sql,
            JSON.stringify(item.params),
            item.rowDiff ? JSON.stringify(item.rowDiff) : null,
            item.rowsAffected,
            item.position,
          ]
        );
      }

      await client.query('COMMIT');
      void this.pruneExpiredItems();
      return runId;
    } catch (error: any) {
      await client.query('ROLLBACK').catch(err => logger.error('Run audit rollback failed:', err));
      logger.error('Failed to record config replicate run:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  public async list(
    filter: { groupId?: string; limit: number; offset: number }
  ): Promise<{ runs: RunSummaryRecord[]; total: number }> {
    const where = filter.groupId ? 'WHERE group_id = $3' : '';
    const params: unknown[] = [filter.limit, filter.offset];
    if (filter.groupId) params.push(filter.groupId);

    const result = await this.pool.query(
      `SELECT * FROM dual_db_manager.config_replicate_runs
       ${where}
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      params
    );

    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM dual_db_manager.config_replicate_runs
       ${filter.groupId ? 'WHERE group_id = $1' : ''}`,
      filter.groupId ? [filter.groupId] : []
    );

    return {
      runs: result.rows.map(mapRun),
      total: countResult.rows[0].total,
    };
  }

  public async getById(id: string): Promise<{ run: RunSummaryRecord; items: any[] } | null> {
    const runResult = await this.pool.query(
      'SELECT * FROM dual_db_manager.config_replicate_runs WHERE id = $1',
      [id]
    );

    if (runResult.rows.length === 0) return null;

    const itemsResult = await this.pool.query(
      `SELECT schema_name, table_name, operation, diff_id, sql, params,
              row_diff, rows_affected, position
       FROM dual_db_manager.config_replicate_run_items
       WHERE run_id = $1 ORDER BY position`,
      [id]
    );

    return {
      run: mapRun(runResult.rows[0]),
      items: itemsResult.rows.map((r: any) => ({
        schema: r.schema_name,
        table: r.table_name,
        operation: r.operation,
        diffId: r.diff_id,
        sql: r.sql,
        params: r.params,
        rowDiff: r.row_diff,
        rowsAffected: r.rows_affected,
        position: r.position,
      })),
    };
  }
}

export default new ConfigReplicateRunsService();
