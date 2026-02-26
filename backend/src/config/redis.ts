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
}

/**
 * Self-healing Redis client wrapper.
 * Caps reconnect at 5 retries (~10s), then destroys and
 * recreates the underlying client on next use.
 */
class SelfHealingRedisClient {
  private client: RedisClient | null = null;
  private connecting: Promise<void> | null = null;

  private buildClient(): RedisClient {
    let errorCount = 0;

    const reconnectStrategy = (retries: number) => {
      // Retry at 1s, 2s, 3s, 4s — give up after ~10s total
      // Then destroy client so next request creates a fresh one
      if (retries >= 5) {
        logger.error(`Redis session: giving up after ${retries} retries (~10s), will recreate on next request`);
        const deadClient = this.client;
        this.client = null;
        this.connecting = null;
        if (deadClient) deadClient.quit().catch(() => {});
        return new Error('Max retries reached');
      }
      const delay = (retries + 1) * 1000; // 1s, 2s, 3s, 4s, 5s
      logger.warn(`Redis session reconnect attempt #${retries + 1}, next retry in ${delay}ms`);
      return delay;
    };

    let rawClient: any;
    if (isCluster) {
      logger.info('Connecting to Redis Cluster (session)');
      rawClient = createCluster({
        rootNodes: [{ url: `redis://${host}:${port}` }],
        defaults: {
          socket: {
            connectTimeout: 10000,
            keepAlive,
            reconnectStrategy,
          },
        },
      });
    } else {
      logger.info('Connecting to standalone Redis (session)');
      rawClient = createClient({
        socket: { host, port, connectTimeout: 10000, keepAlive, reconnectStrategy },
      });
    }

    rawClient.on('error', (err: Error) => {
      errorCount++;
      if (errorCount === 1 || errorCount % 10 === 0) {
        logger.error(`Redis session error (count: ${errorCount}): ${err.message}`);
      }
    });

    rawClient.on('connect', () => {
      if (errorCount > 0) {
        logger.info(`Redis session reconnected after ${errorCount} errors`);
      } else {
        logger.info('Redis session connected');
      }
      errorCount = 0;
    });

    return rawClient as RedisClient;
  }

  private async getClient(): Promise<RedisClient> {
    if (this.client?.isOpen) {
      return this.client;
    }

    // If already connecting, wait for it
    if (this.connecting) {
      await this.connecting;
      if (this.client?.isOpen) return this.client;
    }

    // Create fresh client
    this.client = this.buildClient();
    this.connecting = this.client.connect().then(() => {
      this.connecting = null;
    }).catch((err: Error) => {
      logger.error(`Redis session: failed to connect: ${err.message}`);
      this.client = null;
      this.connecting = null;
      throw err;
    });

    await this.connecting;
    return this.client!;
  }

  // --- Public API (same interface as before) ---

  async get(key: string): Promise<string | null> {
    const c = await this.getClient();
    return c.get(key);
  }

  async set(key: string, value: string): Promise<string | null> {
    const c = await this.getClient();
    return c.set(key, value);
  }

  async setEx(key: string, seconds: number, value: string): Promise<string> {
    const c = await this.getClient();
    return c.setEx(key, seconds, value);
  }

  async connect(): Promise<void> {
    await this.getClient();
  }

  async quit(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.connecting = null;
    }
  }

  get isOpen(): boolean {
    return this.client?.isOpen ?? false;
  }
}

const redisClient = new SelfHealingRedisClient();

// Connect immediately on startup
redisClient.connect().catch((err: Error) => {
  logger.error('Failed initial Redis connection:', err);
});

export default redisClient as unknown as RedisClient;
