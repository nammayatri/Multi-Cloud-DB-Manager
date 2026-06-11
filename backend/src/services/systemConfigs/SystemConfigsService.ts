import { Pool } from 'pg';
import { z } from 'zod';
import DatabasePools from '../../config/database';
import SystemConfigsConfig from '../../config/system-configs-config-loader';
import dashboardAuthService from './DashboardAuthService';
import logger from '../../utils/logger';
import { AppError } from '../../middleware/error.middleware';
import { SystemConfigExecuteResult, SystemConfigTargetJson, SystemConfigTargetKey } from '../../types';

const RUN_QUERY_TIMEOUT_MS = 30000;

// Mirrors the schema/table identifier validation done at config load —
// identifiers are interpolated into SQL, so re-check before every query.
const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const intSchema = z.number().int();

/**
 * Mirror of the Namma Yatri 'Tables' Haskell type that config_value must
 * decode as. The dashboard's runQuery rejects any setClause value that does
 * not decode as this type. Haskell (Int,Int) tuples serialize as 2-element
 * JSON arrays. Unknown extra fields are ignored by the server (aeson generic
 * decode), so this schema is intentionally NOT .strict().
 */
export const tablesSchema = z.object({
  disableForKV: z.array(z.string()),
  kvTablesTtl: z.record(intSchema),
  useCAC: z.array(z.string()),
  useCACForFrontend: z.boolean(),
  readFromMasterDb: z.array(z.string()),
  defaultShardMod: intSchema,
  tableShardModRange: z.record(z.tuple([intSchema, intSchema])),
  tableRedisKeyPrefix: z.record(z.string()),
  allTablesDisabled: z.boolean().nullish(),
  enableSecondaryCloudRead: z.boolean().nullish(),
  tablesForSecondaryCloudRead: z.array(z.string()).nullish(),
  enableAllTablesForSecondaryCloudRead: z.boolean().nullish(),
  drainerTtlConfigs: z.record(intSchema).nullish(),
  enableFindAllForMultiCloud: z.boolean().nullish(),
});

interface RunQueryBody {
  queryType: 'UPDATE';
  tableName: string;
  setClause: { config_value: string };
  whereClause: { id: string };
}

class SystemConfigsService {
  /**
   * Validate a raw config value string against the Tables type.
   * Parsing is for VALIDATION ONLY — the original string is what gets sent.
   */
  public validateConfigValue(configValue: string): { valid: boolean; errors: string[] } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(configValue);
    } catch (error: any) {
      return { valid: false, errors: [`Invalid JSON: ${error?.message || 'parse error'}`] };
    }

    const result = tablesSchema.safeParse(parsed);
    if (result.success) {
      return { valid: true, errors: [] };
    }

    const errors = result.error.errors.map(issue =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message
    );
    return { valid: false, errors };
  }

  /**
   * List config ids from <schema>.system_configs (optional substring filter)
   */
  public async listKeys(targetKey: SystemConfigTargetKey, search?: string): Promise<string[]> {
    const { target, pool } = this.resolveTarget(targetKey);
    const schema = this.safeSchema(target.schema);

    let sql = `SELECT id FROM ${schema}.system_configs`;
    const values: string[] = [];
    if (search) {
      // Escape ILIKE wildcards so the search is a literal substring match
      const escaped = search.replace(/[\\%_]/g, '\\$&');
      sql += ` WHERE id ILIKE $1`;
      values.push(`%${escaped}%`);
    }
    sql += ` ORDER BY id LIMIT 200`;

    const result = await pool.query(sql, values);
    return result.rows.map((row: { id: string }) => row.id);
  }

  /**
   * Fetch one config row's raw value
   */
  public async getConfig(
    targetKey: SystemConfigTargetKey,
    id: string
  ): Promise<{ id: string; exists: boolean; configValue: string | null }> {
    const { target, pool } = this.resolveTarget(targetKey);
    const row = await this.fetchConfigValue(pool, target.schema, id);
    if (row === undefined) {
      return { id, exists: false, configValue: null };
    }
    return { id, exists: true, configValue: row };
  }

  /**
   * Full write flow: Tables validation -> existence check -> capture old value
   * -> dashboard runQuery -> read-back verify.
   */
  public async executeUpdate(
    targetKey: SystemConfigTargetKey,
    id: string,
    configValue: string
  ): Promise<SystemConfigExecuteResult> {
    const startedAt = Date.now();
    const { target, pool } = this.resolveTarget(targetKey);
    const schema = this.safeSchema(target.schema);

    // 1. Pre-validate against the Tables type — the dashboard would reject
    //    anything else with an opaque 400, so fail early with field-level errors.
    const validation = this.validateConfigValue(configValue);
    if (!validation.valid) {
      throw new AppError(`Config value failed Tables validation: ${validation.errors.join('; ')}`, 400);
    }

    // 2. Existence check + capture old value. runQuery returns 200 even when
    //    the WHERE matches nothing (silent no-op), and it can never INSERT
    //    into system_configs, so a missing id is a hard 404 up front.
    const oldValue = await this.fetchConfigValue(pool, target.schema, id);
    if (oldValue === undefined) {
      throw new AppError(
        `Config id "${id}" does not exist in ${schema}.system_configs. The dashboard's runQuery cannot INSERT into system_configs ` +
          `(every setClause value must decode as the Tables type, which an id string never does) — ` +
          `create the row via the DB Manager SQL console first.`,
        404
      );
    }

    // 3. Dashboard runQuery. config_value is the RAW string the user submitted —
    //    never parse->stringify before sending (key reorder / number mangling
    //    would produce a structurally different write).
    const body: RunQueryBody = {
      queryType: 'UPDATE',
      tableName: `${schema}.system_configs`,
      setClause: { config_value: configValue },
      whereClause: { id },
    };
    const dashboardStatus = await this.callRunQuery(targetKey, target, body);

    // 4. Read-back verify: a 2xx only means "SQL executed". If the read pool
    //    (possibly a replica) does not show the new value yet, report 'pending'
    //    rather than failing — the write itself succeeded.
    let verified: 'verified' | 'pending' = 'pending';
    try {
      const afterValue = await this.fetchConfigValue(pool, target.schema, id);
      if (afterValue === configValue) {
        verified = 'verified';
      }
    } catch (error) {
      logger.warn('System config read-back verify failed, reporting pending', {
        target: targetKey,
        id,
        error: String(error),
      });
    }

    logger.info('System config update executed', {
      target: targetKey,
      id,
      dashboardStatus,
      verified,
      durationMs: Date.now() - startedAt,
    });

    return { oldValue, verified, dashboardStatus, durationMs: Date.now() - startedAt };
  }

  /**
   * SELECT config_value for an id — returns undefined when the row is missing.
   */
  private async fetchConfigValue(pool: Pool, schema: string, id: string): Promise<string | null | undefined> {
    const safe = this.safeSchema(schema);
    const result = await pool.query(`SELECT config_value FROM ${safe}.system_configs WHERE id = $1`, [id]);
    if (result.rows.length === 0) return undefined;
    return this.asRawString(result.rows[0].config_value);
  }

  /**
   * config_value is expected to be a text column; if the driver ever returns a
   * parsed object (json/jsonb column), fall back to stringifying — exact-match
   * verification may then report 'pending', which is the safe direction.
   */
  private asRawString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }

  private safeSchema(schema: string): string {
    if (!IDENTIFIER_PATTERN.test(schema)) {
      throw new AppError(`Invalid schema identifier: ${schema}`, 500);
    }
    return schema;
  }

  private resolveTarget(targetKey: SystemConfigTargetKey): { target: SystemConfigTargetJson; pool: Pool } {
    const target = SystemConfigsConfig.getInstance().getTarget(targetKey);
    if (!target) {
      throw new AppError('System Configs manager is not configured', 503);
    }
    const pool = DatabasePools.getInstance().getPoolByName(target.readPool.cloud, target.readPool.database);
    if (!pool) {
      throw new AppError('System Configs manager is not configured', 503);
    }
    return { target, pool };
  }

  /**
   * POST runQuery with the cached token; on 401 invalidate + re-login + retry
   * exactly once. 403 is an access-matrix problem — never retried.
   */
  private async callRunQuery(
    targetKey: SystemConfigTargetKey,
    target: SystemConfigTargetJson,
    body: RunQueryBody
  ): Promise<number> {
    let token = await dashboardAuthService.getToken(targetKey, target);
    let res = await this.postRunQuery(target, token, body);

    if (res.status === 401) {
      dashboardAuthService.invalidateToken(targetKey);
      token = await dashboardAuthService.getToken(targetKey, target);
      res = await this.postRunQuery(target, token, body);
    }

    if (res.ok) {
      return res.status;
    }

    const errBody = await this.safeJson(res);
    const detail =
      (typeof errBody?.errorMessage === 'string' && errBody.errorMessage) ||
      (typeof errBody?.errorCode === 'string' && errBody.errorCode) ||
      `HTTP ${res.status}`;

    if (res.status === 400) {
      throw new AppError(`Dashboard rejected the update: ${detail}`, 400);
    }
    if (res.status === 403) {
      throw new AppError(`Dashboard access denied (service-account access matrix): ${detail}`, 502);
    }
    throw new AppError(`Dashboard runQuery failed (HTTP ${res.status}): ${detail}`, 502);
  }

  private async postRunQuery(target: SystemConfigTargetJson, token: string, body: RunQueryBody): Promise<Response> {
    const base = target.dashboardBaseUrl.replace(/\/+$/, '');
    // pathPrefix may contain a slash ('bpp/driver-offer') — only the merchant
    // and city segments are user-ish data needing URL encoding.
    const prefix = target.pathPrefix.replace(/^\/+|\/+$/g, '');
    const url = `${base}/${prefix}/${encodeURIComponent(target.merchantShortId)}/${encodeURIComponent(target.city)}/system/runQuery`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RUN_QUERY_TIMEOUT_MS);
    try {
      return await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          // Literal header name "token" — NOT Authorization/Bearer
          token,
        },
        body: JSON.stringify(body),
      });
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new AppError('Dashboard runQuery timed out', 502);
      }
      throw new AppError(`Dashboard runQuery failed: ${error?.message || 'network error'}`, 502);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async safeJson(res: Response): Promise<any | null> {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
}

export default new SystemConfigsService();
