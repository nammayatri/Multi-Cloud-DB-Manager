import { createCluster, createClient } from 'redis';
import type { RedisClusterType, RedisClientType } from 'redis';
import { RedisConfigJson, RedisServiceConfig, RedisCloudConfig } from '../types';
import { loadRedisConfig } from './redis-config-loader';
import logger from '../utils/logger';

const keepAlive = parseInt(process.env.REDIS_KEEPALIVE_MS || '60000');

type RedisClusterClient = RedisClusterType<any, any, any>;
type RedisStandaloneClient = RedisClientType<any, any, any>;
// Public client type — both cluster and standalone clients expose the same
// command surface used by RedisCommandExecutor (sendCommand, get, set, scan, …).
export type RedisAnyClient = RedisClusterClient | RedisStandaloneClient;

interface ClusterMasterNode {
  id: string;
  host: string;
  port: number;
}

function key(serviceName: string, cloudName: string): string {
  return `${serviceName}:${cloudName}`;
}

// clusterMode defaults to true so existing services keep their current behavior
// when the field is absent from config.
function isClusterMode(svc: RedisServiceConfig): boolean {
  return svc.clusterMode !== false;
}

class RedisManagerPools {
  private static instance: RedisManagerPools | null = null;

  private clients: Map<string, RedisAnyClient> = new Map();
  private config: RedisConfigJson | null = null;

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

  /** All configured service definitions (read-only). */
  public getServices(): RedisServiceConfig[] {
    return this.config ? this.config.services : [];
  }

  public getServiceNames(): string[] {
    return this.getServices().map(s => s.name);
  }

  /** Resolve a service by name, throwing if not found. */
  private getService(serviceName: string): RedisServiceConfig {
    if (!this.config) throw new Error('Redis Manager is not configured');
    const svc = this.config.services.find(s => s.name === serviceName);
    if (!svc) {
      throw new Error(
        `Redis service not found: ${serviceName}. Available: ${this.getServiceNames().join(', ')}`
      );
    }
    return svc;
  }

  /** All cloud names for a given service (primary + secondary). */
  public getCloudsForService(serviceName: string): string[] {
    const svc = this.getService(serviceName);
    return [svc.primary.cloudName, ...svc.secondary.map(s => s.cloudName)];
  }

  /** Find a (service, cloud) → cloud config; throws if not found. */
  private resolveCloudConfig(serviceName: string, cloudName: string): RedisCloudConfig {
    const svc = this.getService(serviceName);
    if (cloudName === svc.primary.cloudName) return svc.primary;
    const sec = svc.secondary.find(s => s.cloudName === cloudName);
    if (!sec) {
      const available = [svc.primary.cloudName, ...svc.secondary.map(s => s.cloudName)];
      throw new Error(
        `Redis cloud not found: ${cloudName} for service ${serviceName}. Available: ${available.join(', ')}`
      );
    }
    return sec;
  }

  /** Lazily get a Redis client for a (service, cloud) pair — cluster or standalone. */
  public async getClient(serviceName: string, cloudName: string): Promise<RedisAnyClient> {
    const k = key(serviceName, cloudName);
    const existing = this.clients.get(k);
    if (existing) return existing;

    const svc = this.getService(serviceName);
    const cloudConfig = this.resolveCloudConfig(serviceName, cloudName);
    const cluster = isClusterMode(svc);
    const mode = cluster ? 'cluster' : 'standalone';

    logger.info(
      `Redis Manager: Connecting to ${k} (${mode}) at ${cloudConfig.host}:${cloudConfig.port}`
    );

    let errorCount = 0;
    const reconnectStrategy = (retries: number) => {
      if (retries >= 10) {
        logger.error(
          `Redis Manager [${k}]: giving up after ${retries} retries, will reconnect on next request`
        );
        this.clients.delete(k);
        return new Error('Max retries reached');
      }
      return Math.min(500 * Math.pow(2, retries), 30000);
    };

    let client: RedisAnyClient;
    if (cluster) {
      client = createCluster({
        rootNodes: [{ url: `redis://${cloudConfig.host}:${cloudConfig.port}` }],
        defaults: {
          socket: { connectTimeout: 10000, keepAlive, reconnectStrategy },
        },
      });
    } else {
      client = createClient({
        socket: {
          host: cloudConfig.host,
          port: cloudConfig.port,
          connectTimeout: 10000,
          keepAlive,
          reconnectStrategy,
        },
      });
    }

    client.on('error', (err: Error) => {
      errorCount++;
      if (errorCount === 1 || errorCount % 10 === 0) {
        logger.error(`Redis Manager [${k}] error (count: ${errorCount}): ${err.message}`);
      }
    });

    client.on('connect', () => {
      if (errorCount > 0) {
        logger.info(`Redis Manager [${k}] reconnected after ${errorCount} errors`);
      }
      errorCount = 0;
    });

    await client.connect();
    logger.info(`Redis Manager: Connected to ${k} (${mode})`);

    this.clients.set(k, client);
    return client;
  }

  /** True if a service uses standalone Redis (single-node) rather than cluster. */
  public isStandalone(serviceName: string): boolean {
    return !isClusterMode(this.getService(serviceName));
  }

  /**
   * Get the set of nodes to scan for a (service, cloud).
   * - Cluster mode: enumerate masters via CLUSTER NODES on the seed.
   * - Standalone mode: a single virtual "node" pointing at the configured host.
   */
  public async getClusterMasters(
    serviceName: string,
    cloudName: string
  ): Promise<ClusterMasterNode[]> {
    const svc = this.getService(serviceName);
    const cloudConfig = this.resolveCloudConfig(serviceName, cloudName);

    if (!isClusterMode(svc)) {
      // Standalone: SCAN runs against the single configured host.
      return [{ id: 'standalone', host: cloudConfig.host, port: cloudConfig.port }];
    }

    const seedClient = createClient({
      socket: {
        host: cloudConfig.host,
        port: cloudConfig.port,
        connectTimeout: 10000,
      },
    });

    try {
      await seedClient.connect();
      const nodesOutput = (await seedClient.sendCommand(['CLUSTER', 'NODES'])) as string;

      const masters: ClusterMasterNode[] = [];
      const lines = nodesOutput.split('\n').filter(line => line.trim());

      for (const line of lines) {
        const parts = line.split(' ');
        if (parts.length >= 3) {
          const nodeId = parts[0];
          const addressPart = parts[1];
          const flags = parts[2];

          if (flags.includes('master') && !flags.includes('fail')) {
            const [hostPort] = addressPart.split('@');
            const [host, portStr] = hostPort.split(':');
            masters.push({ id: nodeId, host, port: parseInt(portStr, 10) });
          }
        }
      }

      logger.info(
        `Redis Manager: Found ${masters.length} master nodes for ${serviceName}:${cloudName}`
      );
      return masters;
    } finally {
      await seedClient.quit().catch(() => {});
    }
  }

  /** Shutdown all cluster clients. */
  public async shutdown(): Promise<void> {
    logger.info('Redis Manager: Shutting down cluster clients...');
    const shutdownPromises = Array.from(this.clients.entries()).map(async ([k, client]) => {
      try {
        await client.quit();
        logger.info(`Redis Manager: ${k} client closed`);
      } catch (error) {
        logger.error(`Redis Manager: Error closing ${k} client:`, error);
      }
    });

    await Promise.all(shutdownPromises);
    this.clients.clear();
    logger.info('Redis Manager: All clients closed');
  }
}

export default RedisManagerPools;
