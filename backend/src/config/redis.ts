import dotenv from 'dotenv';
dotenv.config();

import { createClient, createCluster } from 'redis';
import logger from '../utils/logger';

// Env vars:
//   REDIS_HOST (default: localhost)
//   REDIS_PORT (default: 6379)
//   REDIS_CLUSTER_MODE=true  → use createCluster for cluster-mode-enabled endpoints

const isCluster = process.env.REDIS_CLUSTER_MODE === 'true';
const host = process.env.REDIS_HOST || 'localhost';
const port = parseInt(process.env.REDIS_PORT || '6379');
const keepAlive = parseInt(process.env.REDIS_KEEPALIVE_MS || '60000');

// Common interface covering all methods we use across the codebase
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<string | null>;
  setEx(key: string, seconds: number, value: string): Promise<string>;
  connect(): Promise<void>;
  quit(): Promise<void>;
  isOpen: boolean;
  on(event: string, listener: (...args: any[]) => void): void;
}

// Exponential backoff: 500ms → 1s → 2s → ... capped at 30s
// node-redis internally re-runs CLUSTER SLOTS on reconnect,
// so topology changes (autoscaling) are picked up automatically.
let errorCount = 0;
const reconnectStrategy = (retries: number) => {
  const delay = Math.min(500 * Math.pow(2, retries), 30000);
  if (retries % 10 === 0) {
    logger.warn(`Redis reconnect attempt #${retries}, next retry in ${delay}ms`);
  }
  return delay;
};

function buildClient(): RedisClient {
  if (isCluster) {
    logger.info('Connecting to Redis Cluster');
    return createCluster({
      rootNodes: [{ url: `redis://${host}:${port}` }],
      defaults: {
        socket: {
          connectTimeout: 10000,
          keepAlive,
          reconnectStrategy,
        },
      },
    }) as unknown as RedisClient;
  }

  logger.info('Connecting to standalone Redis');
  return createClient({
    socket: { host, port, connectTimeout: 10000, keepAlive, reconnectStrategy },
  }) as unknown as RedisClient;
}

const redisClient = buildClient();

// Throttle error logs — log first, then every 10th
redisClient.on('error', (err: Error) => {
  errorCount++;
  if (errorCount === 1 || errorCount % 10 === 0) {
    logger.error(`Redis client error (count: ${errorCount}): ${err.message}`);
  }
});

redisClient.on('connect', () => {
  if (errorCount > 0) {
    logger.info(`Redis client reconnected after ${errorCount} errors`);
  } else {
    logger.info('Redis client connected');
  }
  errorCount = 0;
});

// Connect immediately
redisClient.connect().catch((err: Error) => {
  logger.error('Failed to connect to Redis:', err);
});

export default redisClient;
