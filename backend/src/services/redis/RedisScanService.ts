import { createClient } from 'redis';
import RedisManagerPools from '../../config/redis-pools';
import redisClient from '../../config/redis';
import { RedisScanProgress, RedisScanResponse } from '../../types';
import logger from '../../utils/logger';

const MAX_PREVIEW_KEYS = 10000;
const DELETE_BATCH_SIZE = 1000;
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
  pattern: string,
  cloud: string,
  action: 'preview' | 'delete',
  scanCount: number = 100
): Promise<void> {
  const pools = RedisManagerPools.getInstance();

  // Determine which clouds to scan
  const allClouds = pools.getAllCloudNames();
  const cloudsToScan = cloud === 'both' ? allClouds : [cloud];

  // Validate clouds
  for (const c of cloudsToScan) {
    if (!allClouds.includes(c)) {
      throw new Error(`Invalid cloud: ${c}`);
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

  // Process each cloud (don't await - fire and forget for async operation)
  scanAllClouds(executionId, cloudsToScan, pattern, action, scanCount, response).catch((err) => {
    logger.error('Scan operation failed:', err);
  });
}

async function scanAllClouds(
  executionId: string,
  clouds: string[],
  pattern: string,
  action: 'preview' | 'delete',
  scanCount: number,
  response: RedisScanResponse
): Promise<void> {
  try {
    // Process all clouds concurrently
    await Promise.all(
      clouds.map((cloudName) =>
        scanCloud(executionId, cloudName, pattern, action, scanCount, response)
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
  cloudName: string,
  pattern: string,
  action: 'preview' | 'delete',
  scanCount: number,
  response: RedisScanResponse
): Promise<void> {
  const pools = RedisManagerPools.getInstance();
  const progress = response.clouds[cloudName];

  try {
    // Get cluster master nodes
    const masters = await pools.getClusterMasters(cloudName);
    progress.nodesTotal = masters.length;
    await saveProgress(executionId, response);

    const allKeys: string[] = [];

    // SCAN each master node
    for (const master of masters) {
      // Check cancellation before each node
      if (await isCancelled(executionId)) {
        progress.status = 'cancelled';
        await saveProgress(executionId, response);
        return;
      }

      try {
        const nodeClient = createClient({
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
            // Check cancellation between SCAN iterations
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

              // Always populate keys[] for live display (capped at MAX_PREVIEW_KEYS)
              if (progress.keys && progress.keys.length < MAX_PREVIEW_KEYS) {
                const remaining = MAX_PREVIEW_KEYS - progress.keys.length;
                progress.keys.push(...result.keys.slice(0, remaining));
              }

              await saveProgress(executionId, response);
            }

            // Non-blocking delay
            if (cursor !== 0) {
              await sleep(SCAN_DELAY_MS);
            }

            // Safety cap for preview
            if (action === 'preview' && allKeys.length >= MAX_PREVIEW_KEYS) {
              break;
            }
          } while (cursor !== 0);
        } finally {
          await nodeClient.quit().catch(() => {});
        }
      } catch (nodeError: any) {
        logger.error(`SCAN failed on node ${master.host}:${master.port}:`, nodeError);
        // Continue with other nodes
      }

      progress.nodesScanned++;
      await saveProgress(executionId, response);
    }

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

      const clusterClient = await pools.getClient(cloudName);

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
