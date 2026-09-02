import { S3Client, GetObjectCommand, PutObjectCommand, NotFound } from '@aws-sdk/client-s3';
import logger from '../../utils/logger';

export interface AvailableVersion {
  version: number;
  metadata: string;
}

interface MetadataFile {
  available_versions: AvailableVersion[];
}

async function streamToString(body: any): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Publishes patched config to the SAME versioned layout the public bucket
 * already uses for `import --fetch` defaults (config_transfer.py's own
 * DEFAULT_FETCH_VERSIONS, e.g. "master_to_local": "v3") — NOT an
 * independent path DB Manager invented. Each successful patch+push gets
 * the next integer version for its direction:
 *
 *   s3://<bucket>/<direction>/v<n>/<direction>.zip   (the actual patched data,
 *                                                      pushed by config_transfer.py
 *                                                      itself via --s3-prefix)
 *   s3://<bucket>/<direction>/metadata.json           (this service — NOT
 *                                                      versioned, always
 *                                                      updated in place)
 *
 * metadata.json shape is intentionally minimal — this is read by
 * nammayatri's separate test dashboard as a version picker, so the fields
 * are exactly what was asked for and nothing else:
 *   { "available_versions": [ { "version": 3, "metadata": "..." }, ... ] }
 *
 * Publishing metadata.json is best-effort: the zip push already succeeded
 * by the time this runs, which is what actually matters operationally —
 * callers should log a warning on failure here, not fail the whole job.
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

  /**
   * Next integer version for this direction — current highest + 1, or 1 if
   * metadata.json doesn't exist yet. Must be computed BEFORE the patch
   * subprocess runs, since the version number determines the --s3-prefix
   * (<direction>/v<n>) it pushes the zip to.
   */
  public async getNextVersion(bucket: string, direction: string): Promise<number> {
    const existing = await this.readExisting(bucket, direction);
    if (existing.available_versions.length === 0) return 1;
    return Math.max(...existing.available_versions.map(v => v.version)) + 1;
  }

  public async publishVersion(params: {
    bucket: string;
    direction: string;
    version: number;
    description: string;
  }): Promise<void> {
    const { bucket, direction, version, description } = params;
    const existing = await this.readExisting(bucket, direction);

    // Newest first — a version picker showing this list wants the latest at
    // the top. Guard against re-publishing the same version twice (e.g. a
    // retried request) clobbering the list with a duplicate entry.
    const withoutThisVersion = existing.available_versions.filter(v => v.version !== version);
    const updated: MetadataFile = {
      available_versions: [{ version, metadata: description }, ...withoutThisVersion]
        .sort((a, b) => b.version - a.version),
    };

    await this.client().send(new PutObjectCommand({
      Bucket: bucket,
      Key: this.metadataKey(direction),
      Body: JSON.stringify(updated, null, 2),
      ContentType: 'application/json',
    }));

    logger.info('Config Sync: published S3 metadata.json', {
      bucket, direction, version, versionCount: updated.available_versions.length,
    });
  }

  private async readExisting(bucket: string, direction: string): Promise<MetadataFile> {
    try {
      const resp = await this.client().send(new GetObjectCommand({ Bucket: bucket, Key: this.metadataKey(direction) }));
      const text = await streamToString(resp.Body);
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed?.available_versions)) {
        return { available_versions: parsed.available_versions };
      }
      return { available_versions: [] };
    } catch (err: any) {
      if (err instanceof NotFound || err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
        return { available_versions: [] };
      }
      throw err;
    }
  }
}

export default new ConfigSyncMetadataService();
