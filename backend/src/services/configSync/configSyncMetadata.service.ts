import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import logger from '../../utils/logger';

export interface PublishedVersionEntry {
  version: number;
  metadata: string;
  created_at: string;
  uploaded_by: string | null;
  status: 'stable' | 'not_stable' | 'not_verified';
  verified_by: string | null;
  verified_at: string | null;
}

/**
 * Pure S3 writer for metadata.json — no read-modify-write logic here at all.
 * Postgres (config_sync_versions table, see configSyncVersions.service.ts)
 * is the actual source of truth for versions/status; this class just mirrors
 * whatever list it's handed out to S3, wholesale, for external consumers
 * (the nammayatri test-dashboard's config-sync server) that read
 * metadata.json directly and have no access to this database.
 */
export class ConfigSyncMetadataService {
  private client(): S3Client {
    // No hardcoded default — the SDK falls back to its own default provider
    // chain (e.g. AWS_DEFAULT_REGION, instance metadata) if AWS_REGION is unset.
    return new S3Client({ region: process.env.AWS_REGION });
  }

  private metadataKey(direction: string): string {
    return `${direction}/metadata.json`;
  }

  public async writeVersions(bucket: string, direction: string, versions: PublishedVersionEntry[]): Promise<void> {
    const sorted = [...versions].sort((a, b) => b.version - a.version);
    await this.client().send(new PutObjectCommand({
      Bucket: bucket,
      Key: this.metadataKey(direction),
      Body: JSON.stringify({ available_versions: sorted }, null, 2),
      ContentType: 'application/json',
    }));
    logger.info('Config Sync: synced metadata.json to S3', {
      bucket, direction, versionCount: sorted.length,
    });
  }
}

export default new ConfigSyncMetadataService();
