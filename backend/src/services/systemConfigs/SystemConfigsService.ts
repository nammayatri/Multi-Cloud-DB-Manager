import { PoolClient } from 'pg';
import DatabasePools from '../../config/database';
import QueryValidator from '../query/QueryValidator';
import { AppError } from '../../middleware/error.middleware';

export interface SystemConfigRow {
  id: string;
  configValue: string | null;
}

class SystemConfigsService {
  private async withSchema<T>(
    cloud: string,
    database: string,
    pgSchema: string,
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const validation = QueryValidator.validateSchemaName(pgSchema);
    if (!validation.valid) {
      throw new AppError(validation.error || 'Invalid schema name', 400);
    }

    const pool = DatabasePools.getInstance().getPoolByName(cloud, database);
    if (!pool) {
      throw new AppError(`Pool not found for ${cloud}_${database}`, 404);
    }

    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${pgSchema}, public`);
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async listConfigs(cloud: string, database: string, pgSchema: string): Promise<SystemConfigRow[]> {
    return this.withSchema(cloud, database, pgSchema, async (client) => {
      const result = await client.query('SELECT id, config_value FROM system_configs ORDER BY id');
      return result.rows.map((row) => ({ id: row.id, configValue: row.config_value }));
    });
  }

  async updateConfig(
    cloud: string,
    database: string,
    pgSchema: string,
    id: string,
    configValue: string
  ): Promise<SystemConfigRow> {
    try {
      JSON.parse(configValue);
    } catch {
      throw new AppError('configValue must be valid JSON', 400);
    }

    return this.withSchema(cloud, database, pgSchema, async (client) => {
      const result = await client.query(
        'UPDATE system_configs SET config_value = $1 WHERE id = $2 RETURNING id, config_value',
        [configValue, id]
      );
      if (result.rowCount === 0) {
        throw new AppError(`No system_configs row with id '${id}'`, 404);
      }
      return { id: result.rows[0].id, configValue: result.rows[0].config_value };
    });
  }
}

export default new SystemConfigsService();
