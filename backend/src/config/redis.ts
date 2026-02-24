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

function buildClient(): RedisClient {
  if (isCluster) {
    logger.info('Connecting to Redis Cluster');
    return createCluster({
      rootNodes: [{ url: `redis://${host}:${port}` }],
    }) as unknown as RedisClient;
  }

  logger.info('Connecting to standalone Redis');
  return createClient({
    socket: { host, port },
  }) as unknown as RedisClient;
}

const redisClient = buildClient();

redisClient.on('error', (err: Error) => {
  logger.error('Redis client error:', err);
});

redisClient.on('connect', () => {
  logger.info('Redis client connected');
});

// Connect immediately
redisClient.connect().catch((err: Error) => {
  logger.error('Failed to connect to Redis:', err);
});

export default redisClient;
