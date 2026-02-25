import { createCluster, createClient } from 'redis';
import type { RedisClusterType } from 'redis';
import { RedisConfigJson } from '../types';
import { loadRedisConfig } from './redis-config-loader';
import logger from '../utils/logger';

type RedisClusterClient = RedisClusterType<any, any, any>;

interface ClusterMasterNode {
  id: string;
  host: string;
  port: number;
}

class RedisManagerPools {
  private static instance: RedisManagerPools | null = null;

  private clients: Map<string, RedisClusterClient> = new Map();
  private config: RedisConfigJson | null = null;
  private initialized = false;

  private constructor() {
    this.config = loadRedisConfig();
    if (!this.config) {
      logger.warn('Redis Manager: No configuration found, Redis Manager will be unavailable');
    }
  }

  public static getInstance(): RedisManagerPools {
    if (!RedisManagerPools.instance) {
      RedisManagerPools.instance = new RedisManagerPools();
    }
    return RedisManagerPools.instance;
  }

  public isConfigured(): boolean {
    return this.config !== null;
  }

  /**
   * Lazily initialize and get a cluster client for a cloud
   */
  public async getClient(cloudName: string): Promise<RedisClusterClient> {
    if (!this.config) {
      throw new Error('Redis Manager is not configured');
    }

    const existing = this.clients.get(cloudName);
    if (existing) {
      return existing;
    }

    // Find config for cloud
    const cloudConfig = cloudName === this.config.primary.cloudName
      ? this.config.primary
      : this.config.secondary.find(s => s.cloudName === cloudName);

    if (!cloudConfig) {
      throw new Error(`Redis cloud not found: ${cloudName}`);
    }

    logger.info(`Redis Manager: Connecting to ${cloudName} cluster at ${cloudConfig.host}:${cloudConfig.port}`);

    let errorCount = 0;
    const client = createCluster({
      rootNodes: [{ url: `redis://${cloudConfig.host}:${cloudConfig.port}` }],
      defaults: {
        socket: {
          connectTimeout: 10000,
          reconnectStrategy: (retries: number) => {
            // Give up after 10 retries (~5 min with backoff).
            // Client is evicted from cache so next request creates a fresh one.
            if (retries >= 10) {
              logger.error(`Redis Manager [${cloudName}]: giving up after ${retries} retries, will reconnect on next request`);
              this.clients.delete(cloudName);
              return new Error('Max retries reached');
            }
            return Math.min(500 * Math.pow(2, retries), 30000);
          },
        },
      },
    });

    client.on('error', (err: Error) => {
      errorCount++;
      if (errorCount === 1 || errorCount % 10 === 0) {
        logger.error(`Redis Manager [${cloudName}] error (count: ${errorCount}): ${err.message}`);
      }
    });

    client.on('connect', () => {
      if (errorCount > 0) {
        logger.info(`Redis Manager [${cloudName}] reconnected after ${errorCount} errors`);
      }
      errorCount = 0;
    });

    await client.connect();
    logger.info(`Redis Manager: Connected to ${cloudName} cluster`);

    this.clients.set(cloudName, client as RedisClusterClient);
    return client as RedisClusterClient;
  }

  /**
   * Get all configured cloud names
   */
  public getAllCloudNames(): string[] {
    if (!this.config) return [];
    return [
      this.config.primary.cloudName,
      ...this.config.secondary.map(s => s.cloudName),
    ];
  }

  /**
   * Get master nodes for a cloud cluster by running CLUSTER NODES on seed
   */
  public async getClusterMasters(cloudName: string): Promise<ClusterMasterNode[]> {
    if (!this.config) {
      throw new Error('Redis Manager is not configured');
    }

    const cloudConfig = cloudName === this.config.primary.cloudName
      ? this.config.primary
      : this.config.secondary.find(s => s.cloudName === cloudName);

    if (!cloudConfig) {
      throw new Error(`Redis cloud not found: ${cloudName}`);
    }

    // Connect to seed node to get cluster topology
    const seedClient = createClient({
      socket: {
        host: cloudConfig.host,
        port: cloudConfig.port,
        connectTimeout: 10000,
      },
    });

    try {
      await seedClient.connect();
      const nodesOutput = await seedClient.sendCommand(['CLUSTER', 'NODES']) as string;

      const masters: ClusterMasterNode[] = [];
      const lines = nodesOutput.split('\n').filter(line => line.trim());

      for (const line of lines) {
        const parts = line.split(' ');
        if (parts.length >= 3) {
          const nodeId = parts[0];
          const addressPart = parts[1]; // host:port@cport
          const flags = parts[2];

          if (flags.includes('master') && !flags.includes('fail')) {
            const [hostPort] = addressPart.split('@');
            const [host, portStr] = hostPort.split(':');
            masters.push({
              id: nodeId,
              host,
              port: parseInt(portStr, 10),
            });
          }
        }
      }

      logger.info(`Redis Manager: Found ${masters.length} master nodes for ${cloudName}`);
      return masters;
    } finally {
      await seedClient.quit().catch(() => {});
    }
  }

  /**
   * Shutdown all cluster clients
   */
  public async shutdown(): Promise<void> {
    logger.info('Redis Manager: Shutting down cluster clients...');
    const shutdownPromises = Array.from(this.clients.entries()).map(async ([name, client]) => {
      try {
        await client.quit();
        logger.info(`Redis Manager: ${name} client closed`);
      } catch (error) {
        logger.error(`Redis Manager: Error closing ${name} client:`, error);
      }
    });

    await Promise.all(shutdownPromises);
    this.clients.clear();
    logger.info('Redis Manager: All clients closed');
  }
}

export default RedisManagerPools;
