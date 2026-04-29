import { createClient } from 'redis';
import RedisManagerPools from '../../config/redis-pools';
import redisClient from '../../config/redis';
import { RedisScanResponse } from '../../types';
import logger from '../../utils/logger';

const MAX_PREVIEW_KEYS = 10000;
const DELETE_BATCH_SIZE = 100; // smaller batches to avoid overwhelming cluster
const SCAN_DELAY_MS = 100;
const SCAN_PROGRESS_TTL = 600; // 10 minutes

function progressKey(executionId: string): string {
  return `redis-scan:${executionId}`;
}

function cancelKey(executionId: string): string {
  return `redis-scan-cancel:${executionId}`;
}

async function saveProgress(executionId: string, response: RedisScanResponse): Promise<void> {
  await redisClient.setEx(
    progressKey(executionId),
    SCAN_PROGRESS_TTL,
    JSON.stringify(response)
  );
}

async function isCancelled(executionId: string): Promise<boolean> {
  const flag = await redisClient.get(cancelKey(executionId));
  return flag === '1';
}

export async function getScanStatus(executionId: string): Promise<RedisScanResponse | null> {
  const data = await redisClient.get(progressKey(executionId));
  if (!data) return null;
  return JSON.parse(data);
}

/**
 * Request cancellation of a running scan
 */
export async function cancelScan(executionId: string): Promise<boolean> {
  const status = await getScanStatus(executionId);
  if (!status) return false;
  if (status.status !== 'running') return false;

  // Set cancellation flag (TTL same as progress)
  await redisClient.setEx(cancelKey(executionId), SCAN_PROGRESS_TTL, '1');
  logger.info('Redis SCAN cancellation requested', { executionId });
  return true;
}

export async function startScan(
  executionId: string,
  serviceName: string,
  pattern: string,
  cloud: string,
  action: 'preview' | 'delete',
  scanCount: number = 100
): Promise<void> {
  const pools = RedisManagerPools.getInstance();

  const allClouds = pools.getCloudsForService(serviceName);
  const cloudsToScan = cloud === 'both' ? allClouds : [cloud];

  for (const c of cloudsToScan) {
    if (!allClouds.includes(c)) {
      throw new Error(`Invalid cloud: ${c} for service ${serviceName}`);
    }
  }

  // Initialize progress
  const response: RedisScanResponse = {
    id: executionId,
    status: 'running',
    action,
    pattern,
    clouds: {},
  };

  for (const c of cloudsToScan) {
    response.clouds[c] = {
      cloudName: c,
      nodesTotal: 0,
      nodesScanned: 0,
      keysFound: 0,
      keysDeleted: 0,
      keys: [],
      status: 'scanning',
    };
  }

  await saveProgress(executionId, response);

  scanAllClouds(executionId, serviceName, cloudsToScan, pattern, action, scanCount, response).catch((err) => {
    logger.error('Scan operation failed:', err);
  });
}

async function scanAllClouds(
  executionId: string,
  serviceName: string,
  clouds: string[],
  pattern: string,
  action: 'preview' | 'delete',
  scanCount: number,
  response: RedisScanResponse
): Promise<void> {
  try {
    await Promise.all(
      clouds.map((cloudName) =>
        scanCloud(executionId, serviceName, cloudName, pattern, action, scanCount, response)
      )
    );

    // Determine overall status
    const statuses = Object.values(response.clouds).map((c) => c.status);
    if (statuses.some((s) => s === 'cancelled')) {
      response.status = 'cancelled';
    } else if (statuses.some((s) => s === 'error')) {
      response.status = 'failed';
    } else {
      response.status = 'completed';
    }
    await saveProgress(executionId, response);
  } catch (error: any) {
    response.status = 'failed';
    await saveProgress(executionId, response);
  }
}

async function scanCloud(
  executionId: string,
  serviceName: string,
  cloudName: string,
  pattern: string,
  action: 'preview' | 'delete',
  scanCount: number,
  response: RedisScanResponse
): Promise<void> {
  const pools = RedisManagerPools.getInstance();
  const progress = response.clouds[cloudName];
  // For standalone services this can be 1, 3, 4 etc. Cluster services always 0.
  const dbIndex = pools.getDbIndex(serviceName);

  try {
    const masters = await pools.getClusterMasters(serviceName, cloudName);
    progress.nodesTotal = masters.length;
    await saveProgress(executionId, response);

    const allKeys: string[] = [];

    // SCAN all master nodes in parallel
    const scanNode = async (master: { host: string; port: number }) => {
      if (await isCancelled(executionId)) {
        progress.status = 'cancelled';
        await saveProgress(executionId, response);
        return;
      }

      try {
        const nodeClient = createClient({
          database: dbIndex,
          socket: {
            host: master.host,
            port: master.port,
            connectTimeout: 10000,
          },
        });

        try {
          await nodeClient.connect();

          let cursor = 0;
          do {
            if (await isCancelled(executionId)) {
              progress.status = 'cancelled';
              await saveProgress(executionId, response);
              return;
            }

            const result = await nodeClient.scan(cursor, {
              MATCH: pattern,
              COUNT: scanCount,
            });

            cursor = result.cursor;

            if (result.keys.length > 0) {
              allKeys.push(...result.keys);
              progress.keysFound = allKeys.length;

              // Populate keys[] for live display (capped at MAX_PREVIEW_KEYS)
              if (progress.keys && progress.keys.length < MAX_PREVIEW_KEYS) {
                const remaining = MAX_PREVIEW_KEYS - progress.keys.length;
                progress.keys.push(...result.keys.slice(0, remaining));
              }

              await saveProgress(executionId, response);
            }

            if (cursor !== 0) {
              await sleep(SCAN_DELAY_MS);
            }

            if (action === 'preview' && allKeys.length >= MAX_PREVIEW_KEYS) {
              break;
            }
          } while (cursor !== 0);
        } finally {
          await nodeClient.quit().catch(() => {});
        }
      } catch (nodeError: any) {
        logger.error(`SCAN failed on node ${master.host}:${master.port}:`, nodeError);
      }

      progress.nodesScanned++;
      await saveProgress(executionId, response);
    };

    await Promise.all(masters.map(scanNode));

    // Check cancellation before delete phase
    if (await isCancelled(executionId)) {
      progress.status = 'cancelled';
      await saveProgress(executionId, response);
      return;
    }

    // Delete phase
    if (action === 'delete' && allKeys.length > 0) {
      progress.status = 'deleting';
      await saveProgress(executionId, response);

      const clusterClient = await pools.getClient(serviceName, cloudName);

      // Batch delete using UNLINK (async, non-blocking)
      for (let i = 0; i < allKeys.length; i += DELETE_BATCH_SIZE) {
        // Check cancellation between delete batches
        if (await isCancelled(executionId)) {
          progress.status = 'cancelled';
          await saveProgress(executionId, response);
          return;
        }

        const batch = allKeys.slice(i, i + DELETE_BATCH_SIZE);
        try {
          // Use UNLINK for async deletion - delete keys one by one through cluster client
          // which handles slot routing
          await Promise.all(batch.map((key) => clusterClient.unlink(key)));
          progress.keysDeleted += batch.length;
          await saveProgress(executionId, response);
        } catch (delError: any) {
          logger.error(`Batch delete failed at offset ${i}:`, delError);
          // Continue with next batch
        }
      }
    }

    // Only mark completed if not already cancelled
    if (progress.status !== 'cancelled') {
      progress.status = 'completed';
      await saveProgress(executionId, response);
    }
  } catch (error: any) {
    progress.status = 'error';
    progress.error = error.message;
    await saveProgress(executionId, response);
    logger.error(`SCAN failed for cloud ${cloudName}:`, error);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
