import fs from 'fs';
import path from 'path';
import { Pool, PoolClient } from 'pg';
import DatabasePools from '../../config/database';
import logger from '../../utils/logger';
import { configJsonSchema, patchesJsonSchema } from './configSyncAssets.schema';

export type ConfigSyncAssetName = 'config.json' | 'patches.json';
const ASSET_NAMES: ConfigSyncAssetName[] = ['config.json', 'patches.json'];

const RUNTIME_ASSETS_DIR = path.join(__dirname, '../../../config-sync/assets');
// Seed-only content, baked into the image at build time — distinct from
// RUNTIME_ASSETS_DIR above, which is exclusively runtime-generated (written by
// writeToDisk() from Postgres, never present in the image itself). Only
// config.json has real seed content to ship (audited, non-secret, committed
// to git); patches.json has no public seed source at all — it can carry real
// secrets (see the PEM-key incident), so it's gitignored and starts as an
// empty object instead, filled in via the UI after first deploy.
const SEED_DIR = path.join(__dirname, '../../../config-sync/seed');

export interface ConfigSyncAsset {
  name: ConfigSyncAssetName;
  content: any;
  updatedBy: string | null;
  updatedByUsername: string | null;
  updatedAt: string;
}

// A history entry as listed (no content — content column can be 40KB+ for
// config.json, and the list view only needs to show "when, by whom").
export interface ConfigSyncAssetHistoryEntry {
  id: string;
  name: ConfigSyncAssetName;
  updatedBy: string | null;
  updatedByUsername: string | null;
  updatedAt: string;
}

export interface ConfigSyncAssetHistoryDetail extends ConfigSyncAssetHistoryEntry {
  content: any;
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS dual_db_manager.config_sync_assets (
    name VARCHAR(50) PRIMARY KEY,
    content JSONB NOT NULL,
    updated_by UUID REFERENCES dual_db_manager.users(id) ON DELETE SET NULL,
    updated_by_username VARCHAR(200),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  );

  -- Append-only: every save (including the initial disk seed and every
  -- restore) gets its own row here, so nothing is ever lost even though
  -- config_sync_assets itself only holds the current value.
  CREATE TABLE IF NOT EXISTS dual_db_manager.config_sync_asset_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) NOT NULL,
    content JSONB NOT NULL,
    updated_by UUID REFERENCES dual_db_manager.users(id) ON DELETE SET NULL,
    updated_by_username VARCHAR(200),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_config_sync_asset_history_name
    ON dual_db_manager.config_sync_asset_history(name, updated_at DESC);
`;

function assetPathOnDisk(name: ConfigSyncAssetName): string {
  return path.join(RUNTIME_ASSETS_DIR, name);
}

function mapRow(row: any): ConfigSyncAsset {
  return {
    name: row.name,
    content: row.content,
    updatedBy: row.updated_by,
    updatedByUsername: row.updated_by_username,
    updatedAt: row.updated_at,
  };
}

function mapHistoryRow(row: any): ConfigSyncAssetHistoryDetail {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    updatedBy: row.updated_by,
    updatedByUsername: row.updated_by_username,
    updatedAt: row.updated_at,
  };
}

/**
 * Owns config.json / patches.json as DB Manager's own data (Postgres), not
 * static files in the nammayatri repo — DB Manager's team now owns these
 * going forward. config_transfer.py still only ever reads them from disk
 * (assets/config.json, assets/patches.json — no env-var override for that
 * path), so writeToDisk() is the bridge: called once at server startup and
 * again immediately before every export/patch run, so the subprocess always
 * sees the latest DB content.
 */
export class ConfigSyncAssetsService {
  private get pool(): Pool {
    return DatabasePools.getInstance().history;
  }

  public async initializeSchema(): Promise<void> {
    try {
      await this.pool.query(CREATE_TABLE);

      // Serialize seed/backfill across concurrent callers (multiple pods —
      // or, as happened locally, multiple stray dev processes — running
      // initializeSchema() around the same time) with a session advisory
      // lock held on ONE connection for the duration. Without this, two
      // callers can both pass a "does this exist yet" check before either
      // has inserted, producing duplicate rows — which is exactly what
      // happened here before this lock was added.
      const client = await this.pool.connect();
      try {
        await client.query("SELECT pg_advisory_lock(hashtext('config_sync_assets_init'))");
        await this.seedFromDiskIfEmpty(client);
        await this.backfillHistoryIfMissing(client);
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext('config_sync_assets_init'))").catch(() => {});
        client.release();
      }

      logger.info('Config Sync assets schema initialized');
    } catch (error) {
      logger.error('Failed to initialize Config Sync assets schema:', error);
      throw error;
    }
  }

  /**
   * config_sync_asset_history was added after config_sync_assets already
   * existed on some deployments — seedFromDiskIfEmpty() only backfills
   * history when it ALSO inserts the current row (fresh deploy), so a
   * deployment that already had rows here got no history at all. Give any
   * such asset one baseline history entry from its current value, so the
   * history dialog isn't empty on first open.
   */
  private async backfillHistoryIfMissing(client: PoolClient): Promise<void> {
    for (const name of ASSET_NAMES) {
      const assetResult = await client.query(
        'SELECT * FROM dual_db_manager.config_sync_assets WHERE name = $1',
        [name]
      );
      const asset = assetResult.rows[0] ? mapRow(assetResult.rows[0]) : null;
      if (!asset) continue;

      const existingHistory = await client.query(
        'SELECT 1 FROM dual_db_manager.config_sync_asset_history WHERE name = $1 LIMIT 1',
        [name]
      );
      if ((existingHistory.rowCount ?? 0) > 0) continue;

      await client.query(
        `INSERT INTO dual_db_manager.config_sync_asset_history (name, content, updated_by, updated_by_username, updated_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [name, JSON.stringify(asset.content), asset.updatedBy, asset.updatedByUsername, asset.updatedAt]
      );
      logger.info(`Config Sync: backfilled baseline history entry for ${name}`);
    }
  }

  /**
   * First deploy after this migration: the table is empty. config.json has
   * real, already-audited seed content baked into the image (SEED_DIR)
   * — seed from that once so nothing is lost. patches.json has no public
   * seed source (it can carry real secrets, so it's never committed) —
   * it starts as an empty object instead. Subsequent runs are DB-authoritative
   * either way; this never overwrites an existing row.
   */
  private async seedFromDiskIfEmpty(client: PoolClient): Promise<void> {
    for (const name of ASSET_NAMES) {
      const existing = await client.query(
        'SELECT 1 FROM dual_db_manager.config_sync_assets WHERE name = $1',
        [name]
      );
      if ((existing.rowCount ?? 0) > 0) continue;

      let content: any;
      if (name === 'config.json') {
        const seedPath = path.join(SEED_DIR, name);
        if (!fs.existsSync(seedPath)) {
          logger.warn(`Config Sync: cannot seed ${name} — not found on disk at ${seedPath}`);
          continue;
        }
        content = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
      } else {
        content = {};
      }

      await client.query(
        `INSERT INTO dual_db_manager.config_sync_assets (name, content, updated_by_username)
         VALUES ($1, $2, 'seed-from-disk')
         ON CONFLICT (name) DO NOTHING`,
        [name, JSON.stringify(content)]
      );
      await client.query(
        `INSERT INTO dual_db_manager.config_sync_asset_history (name, content, updated_by_username)
         VALUES ($1, $2, 'seed-from-disk')`,
        [name, JSON.stringify(content)]
      );
      logger.info(`Config Sync: seeded ${name} into Postgres`);
    }
  }

  public async getAll(): Promise<ConfigSyncAsset[]> {
    const result = await this.pool.query(
      'SELECT * FROM dual_db_manager.config_sync_assets ORDER BY name'
    );
    return result.rows.map(mapRow);
  }

  public async get(name: ConfigSyncAssetName): Promise<ConfigSyncAsset | null> {
    const result = await this.pool.query(
      'SELECT * FROM dual_db_manager.config_sync_assets WHERE name = $1',
      [name]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  public async update(
    name: ConfigSyncAssetName,
    content: any,
    userId: string | undefined,
    username: string | undefined
  ): Promise<ConfigSyncAsset> {
    if (!ASSET_NAMES.includes(name)) {
      throw new Error(`Unknown Config Sync asset '${name}'. Must be one of: ${ASSET_NAMES.join(', ')}`);
    }
    // Structural validation against config_transfer.py's actual expected
    // shape — catches "valid JSON, wrong keys" at save time instead of
    // letting it silently succeed and only fail the next time someone
    // actually runs Export & Patch.
    const schema = name === 'config.json' ? configJsonSchema : patchesJsonSchema;
    const parsed = schema.safeParse(content);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const where = firstIssue.path.join('.') || '(root)';
      throw new Error(`${name} does not match the expected structure at "${where}": ${firstIssue.message}`);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `INSERT INTO dual_db_manager.config_sync_assets (name, content, updated_by, updated_by_username, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (name) DO UPDATE SET
           content = EXCLUDED.content,
           updated_by = EXCLUDED.updated_by,
           updated_by_username = EXCLUDED.updated_by_username,
           updated_at = NOW()
         RETURNING *`,
        [name, JSON.stringify(content), userId || null, username || null]
      );

      // Every save gets its own append-only history row — this is what
      // getHistory()/restore() read from.
      await client.query(
        `INSERT INTO dual_db_manager.config_sync_asset_history (name, content, updated_by, updated_by_username)
         VALUES ($1, $2, $3, $4)`,
        [name, JSON.stringify(content), userId || null, username || null]
      );

      await client.query('COMMIT');
      return mapRow(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(err => logger.error('Rollback failed:', err));
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Most recent versions first, content excluded (can be 40KB+) — the
   * history dialog lists these, then fetches one full version on demand via
   * getHistoryEntry().
   */
  public async getHistory(name: ConfigSyncAssetName, limit = 50): Promise<ConfigSyncAssetHistoryEntry[]> {
    const result = await this.pool.query(
      `SELECT id, name, updated_by, updated_by_username, updated_at
       FROM dual_db_manager.config_sync_asset_history
       WHERE name = $1
       ORDER BY updated_at DESC
       LIMIT $2`,
      [name, limit]
    );
    return result.rows.map(row => ({
      id: row.id,
      name: row.name,
      updatedBy: row.updated_by,
      updatedByUsername: row.updated_by_username,
      updatedAt: row.updated_at,
    }));
  }

  public async getHistoryEntry(id: string): Promise<ConfigSyncAssetHistoryDetail | null> {
    const result = await this.pool.query(
      'SELECT * FROM dual_db_manager.config_sync_asset_history WHERE id = $1',
      [id]
    );
    return result.rows[0] ? mapHistoryRow(result.rows[0]) : null;
  }

  /**
   * Restoring is just another save — it goes through update(), so it lands
   * as a new current row AND a new history entry (history is append-only;
   * restoring an old version never deletes anything).
   */
  public async restore(
    id: string,
    userId: string | undefined,
    username: string | undefined
  ): Promise<ConfigSyncAsset> {
    const entry = await this.getHistoryEntry(id);
    if (!entry) {
      throw new Error(`History entry '${id}' not found`);
    }
    return this.update(entry.name, entry.content, userId, username);
  }

  /**
   * Write both assets from Postgres out to the vendored file paths
   * config_transfer.py hardcodes. Idempotent, safe to call on every server
   * start and before every job run.
   */
  public async writeToDisk(): Promise<void> {
    const assets = await this.getAll();
    if (assets.length === 0) {
      // Schema not initialized yet (e.g. RUN_MIGRATIONS=false) — leave the
      // vendored on-disk files as the source of truth in that case.
      return;
    }
    fs.mkdirSync(RUNTIME_ASSETS_DIR, { recursive: true });
    for (const asset of assets) {
      fs.writeFileSync(assetPathOnDisk(asset.name), JSON.stringify(asset.content, null, 2));
    }
  }
}

export default new ConfigSyncAssetsService();
