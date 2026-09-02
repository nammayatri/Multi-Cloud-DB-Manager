import { Pool } from 'pg';
import DatabasePools from '../../config/database';
import logger from '../../utils/logger';
import configSyncMetadataService from './configSyncMetadata.service';

export type VersionStatus = 'stable' | 'not_stable' | 'not_verified';

export interface ConfigSyncVersion {
  id: string;
  direction: string;
  version: number;
  description: string | null;
  uploadedBy: string | null;
  uploadedByUsername: string | null;
  status: VersionStatus;
  verifiedBy: string | null;
  verifiedByUsername: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS dual_db_manager.config_sync_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    direction VARCHAR(100) NOT NULL,
    version INT NOT NULL,
    description TEXT,
    uploaded_by UUID REFERENCES dual_db_manager.users(id) ON DELETE SET NULL,
    uploaded_by_username VARCHAR(200),
    status VARCHAR(20) NOT NULL DEFAULT 'not_verified' CHECK (status IN ('stable', 'not_stable', 'not_verified')),
    verified_by UUID REFERENCES dual_db_manager.users(id) ON DELETE SET NULL,
    verified_by_username VARCHAR(200),
    verified_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (direction, version)
  );
  CREATE INDEX IF NOT EXISTS idx_config_sync_versions_direction
    ON dual_db_manager.config_sync_versions(direction, version DESC);
`;

function mapRow(row: any): ConfigSyncVersion {
  return {
    id: row.id,
    direction: row.direction,
    version: row.version,
    description: row.description,
    uploadedBy: row.uploaded_by,
    uploadedByUsername: row.uploaded_by_username,
    status: row.status,
    verifiedBy: row.verified_by,
    verifiedByUsername: row.verified_by_username,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
  };
}

/**
 * Source of truth for "which config-sync versions exist and are they
 * verified stable" — a real Postgres table, not a read-modify-write dance
 * against a JSON file on S3. metadata.json on S3 still exists (the
 * nammayatri test-dashboard's config-sync server reads it directly and has
 * no access to this database), but it's now just a mirror: every write here
 * re-pushes the full current version list out to S3 afterward.
 */
export class ConfigSyncVersionsService {
  private get pool(): Pool {
    return DatabasePools.getInstance().history;
  }

  public async initializeSchema(): Promise<void> {
    try {
      await this.pool.query(CREATE_TABLE);
      logger.info('Config Sync versions schema initialized');
    } catch (error) {
      logger.error('Failed to initialize Config Sync versions schema:', error);
      throw error;
    }
  }

  /** Next version number for a direction — current highest + 1, or 1 if none exist yet. */
  public async getNextVersion(direction: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM dual_db_manager.config_sync_versions WHERE direction = $1',
      [direction]
    );
    return Number(result.rows[0].next);
  }

  public async listVersions(direction: string): Promise<ConfigSyncVersion[]> {
    const result = await this.pool.query(
      'SELECT * FROM dual_db_manager.config_sync_versions WHERE direction = $1 ORDER BY version DESC',
      [direction]
    );
    return result.rows.map(mapRow);
  }

  /**
   * Records a successful publish — called right after the patch subprocess's
   * S3 zip push itself succeeds. New rows always start 'not_verified': a
   * version existing doesn't mean anyone's confirmed it actually works.
   */
  public async recordUpload(params: {
    bucket: string;
    direction: string;
    version: number;
    description: string;
    uploadedBy: string | undefined;
    uploadedByUsername: string | undefined;
  }): Promise<void> {
    const { bucket, direction, version, description, uploadedBy, uploadedByUsername } = params;
    await this.pool.query(
      `INSERT INTO dual_db_manager.config_sync_versions
         (direction, version, description, uploaded_by, uploaded_by_username)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (direction, version) DO UPDATE SET
         description = EXCLUDED.description,
         uploaded_by = EXCLUDED.uploaded_by,
         uploaded_by_username = EXCLUDED.uploaded_by_username`,
      [direction, version, description, uploadedBy || null, uploadedByUsername || null]
    );
    await this.syncToS3(bucket, direction);
  }

  /**
   * Mark an existing version's stability. verified_by/verified_at are always
   * refreshed on every call, even re-marking the same status — so it's
   * always clear who most recently vouched for (or against) a version.
   */
  public async setStatus(params: {
    bucket: string;
    direction: string;
    version: number;
    status: VersionStatus;
    verifiedBy: string | undefined;
    verifiedByUsername: string | undefined;
  }): Promise<ConfigSyncVersion> {
    const { bucket, direction, version, status, verifiedBy, verifiedByUsername } = params;
    const result = await this.pool.query(
      `UPDATE dual_db_manager.config_sync_versions
       SET status = $1, verified_by = $2, verified_by_username = $3, verified_at = NOW()
       WHERE direction = $4 AND version = $5
       RETURNING *`,
      [status, verifiedBy || null, verifiedByUsername || null, direction, version]
    );
    if (result.rowCount === 0) {
      throw new Error(`Version ${version} not found for direction '${direction}'`);
    }
    await this.syncToS3(bucket, direction);
    return mapRow(result.rows[0]);
  }

  private async syncToS3(bucket: string, direction: string): Promise<void> {
    const versions = await this.listVersions(direction);
    await configSyncMetadataService.writeVersions(
      bucket, direction,
      versions.map(v => ({
        version: v.version,
        metadata: v.description || '',
        created_at: v.createdAt,
        uploaded_by: v.uploadedByUsername,
        status: v.status,
        verified_by: v.verifiedByUsername,
        verified_at: v.verifiedAt,
      }))
    );
  }
}

export default new ConfigSyncVersionsService();
