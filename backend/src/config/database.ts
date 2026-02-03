import dotenv from 'dotenv';
dotenv.config();

import { Pool, PoolConfig as PgPoolConfig } from 'pg';
import logger from '../utils/logger';
import { DatabaseConfig, DatabaseInfo, CloudConfiguration, SchemaInfo } from '../types';
import { loadDatabaseConfig, convertEnvToJson } from './config-loader';

// Connection pool configuration with reliability settings
const createPoolConfig = (dbConfig: DatabaseConfig | DatabaseInfo): PgPoolConfig => ({
  host: dbConfig.host,
  port: dbConfig.port,
  user: dbConfig.user,
  password: dbConfig.password,
  database: dbConfig.database,

  // Connection pool settings for high reliability
  max: 20, // Maximum connections
  min: 2, // Minimum idle connections
  idleTimeoutMillis: 30000, // Close idle connections after 30s
  connectionTimeoutMillis: 10000, // Timeout for acquiring connection

  // Statement timeout (prevent long-running queries from blocking)
  statement_timeout: 300000, // 5 minutes max per query

  // Connection lifecycle
  allowExitOnIdle: false, // Keep pool alive

  // Application name for monitoring
  application_name: 'dual-db-manager',
});

class DatabasePools {
  private static instance: DatabasePools;

  // Legacy public pools (for backward compatibility)
  public cloud1_db1!: Pool;
  public cloud1_db2!: Pool;
  public cloud2_db1!: Pool;
  public cloud2_db2!: Pool;
  public history!: Pool;

  // New internal structures
  private pools: Map<string, Pool> = new Map();
  private schemaCache: Map<string, SchemaInfo> = new Map();
  private cloudConfig: CloudConfiguration;

  private constructor() {
    // Load configuration from JSON or environment variables
    const jsonConfig = loadDatabaseConfig();

    if (jsonConfig) {
      // Use JSON configuration
      this.cloudConfig = this.convertJsonToCloudConfig(jsonConfig);
      this.initializeFromJson(jsonConfig);
    } else {
      // Fall back to environment variables
      const envConfig = convertEnvToJson();
      this.cloudConfig = this.convertJsonToCloudConfig(envConfig);
      this.initializeFromJson(envConfig);
    }

    // Setup error handlers for all pools
    this.setupErrorHandlers();

    // Test connections on startup
    this.testConnections();

    logger.info('Database connection pools initialized', {
      primaryCloud: this.cloudConfig.primaryCloud,
      primaryDatabases: this.cloudConfig.primaryDatabases.length,
      secondaryClouds: this.cloudConfig.secondaryClouds.length,
      totalPools: this.pools.size
    });
  }

  /**
   * Convert JSON configuration to internal CloudConfiguration format
   */
  private convertJsonToCloudConfig(jsonConfig: any): CloudConfiguration {
    return {
      primaryCloud: jsonConfig.primary.cloudName,
      primaryDatabases: jsonConfig.primary.db_configs.map((db: any) => ({
        cloudType: jsonConfig.primary.cloudName,
        databaseName: db.name,
        label: db.label,
        host: db.host,
        port: db.port,
        user: db.user,
        password: db.password,
        database: db.database,
        schemas: db.schemas,
        defaultSchema: db.defaultSchema
      })),
      secondaryClouds: jsonConfig.secondary.map((c: any) => c.cloudName),
      secondaryDatabases: Object.fromEntries(
        jsonConfig.secondary.map((cloud: any) => [
          cloud.cloudName,
          cloud.db_configs.map((db: any) => ({
            cloudType: cloud.cloudName,
            databaseName: db.name,
            label: db.label,
            host: db.host,
            port: db.port,
            user: db.user,
            password: db.password,
            database: db.database,
            schemas: db.schemas,
            defaultSchema: db.defaultSchema
          }))
        ])
      )
    };
  }

  /**
   * Initialize database pools from JSON configuration
   */
  private initializeFromJson(jsonConfig: any): void {
    // Create pools for primary cloud
    for (const dbConfig of jsonConfig.primary.db_configs) {
      const key = `${jsonConfig.primary.cloudName}_${dbConfig.name}`;
      const pool = new Pool(createPoolConfig(dbConfig));
      this.pools.set(key, pool);

      // Cache schema info
      this.schemaCache.set(key, {
        databaseName: dbConfig.name,
        cloudType: jsonConfig.primary.cloudName,
        label: dbConfig.label,
        schemas: dbConfig.schemas,
        defaultSchema: dbConfig.defaultSchema
      });

      logger.debug(`Created pool: ${key}`, {
        database: dbConfig.database,
        schemas: dbConfig.schemas.length
      });
    }

    // Create pools for secondary clouds
    for (const cloud of jsonConfig.secondary) {
      for (const dbConfig of cloud.db_configs) {
        const key = `${cloud.cloudName}_${dbConfig.name}`;
        const pool = new Pool(createPoolConfig(dbConfig));
        this.pools.set(key, pool);

        // Cache schema info
        this.schemaCache.set(key, {
          databaseName: dbConfig.name,
          cloudType: cloud.cloudName,
          label: dbConfig.label,
          schemas: dbConfig.schemas,
          defaultSchema: dbConfig.defaultSchema
        });

        logger.debug(`Created pool: ${key}`, {
          database: dbConfig.database,
          schemas: dbConfig.schemas.length
        });
      }
    }

    // Create history pool
    this.history = new Pool(createPoolConfig(jsonConfig.history));
    logger.debug('Created history pool', {
      database: jsonConfig.history.database
    });

    // Set legacy public pools for backward compatibility
    this.cloud1_db1 = this.pools.get('cloud1_db1') || this.history;
    this.cloud1_db2 = this.pools.get('cloud1_db2') || this.history;
    this.cloud2_db1 = this.pools.get('cloud2_db1') || this.history;
    this.cloud2_db2 = this.pools.get('cloud2_db2') || this.history;
  }

  public static getInstance(): DatabasePools {
    if (!DatabasePools.instance) {
      DatabasePools.instance = new DatabasePools();
    }
    return DatabasePools.instance;
  }

  /**
   * Get cloud configuration
   */
  public getCloudConfig(): CloudConfiguration {
    return this.cloudConfig;
  }

  /**
   * Get schema information for a specific database
   */
  public getSchemaInfo(cloudName: string, databaseName: string): SchemaInfo | null {
    const key = `${cloudName}_${databaseName}`;
    return this.schemaCache.get(key) || null;
  }

  /**
   * Get all schema information
   */
  public getAllSchemaInfo(): Map<string, SchemaInfo> {
    return new Map(this.schemaCache);
  }

  /**
   * Get pool by cloud and database name
   */
  public getPoolByName(cloudName: string, databaseName: string): Pool | null {
    const key = `${cloudName}_${databaseName}`;
    return this.pools.get(key) || null;
  }

  private setupErrorHandlers() {
    // Setup error handlers for all pools in the map
    this.pools.forEach((pool, name) => {
      pool.on('error', (err) => {
        logger.error(`Unexpected error on ${name} pool:`, err);
      });

      pool.on('connect', () => {
        logger.debug(`New connection established in ${name} pool`);
      });

      pool.on('remove', () => {
        logger.debug(`Connection removed from ${name} pool`);
      });
    });

    // Setup error handler for history pool
    this.history.on('error', (err) => {
      logger.error('Unexpected error on history pool:', err);
    });
  }

  private async testConnections() {
    // Test all pools in the map
    for (const [name, pool] of this.pools.entries()) {
      try {
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        logger.info(`✓ ${name} pool connection successful`);
      } catch (error) {
        logger.error(`✗ ${name} pool connection failed:`, error);
      }
    }

    // Test history pool
    try {
      const client = await this.history.connect();
      await client.query('SELECT 1');
      client.release();
      logger.info('✓ history pool connection successful');
    } catch (error) {
      logger.error('✗ history pool connection failed:', error);
    }
  }

  /**
   * Get pool by legacy schema naming (for backward compatibility)
   * @param cloud 'aws' or 'gcp'
   * @param schema 'primary' or 'secondary'
   */
  public getPool(cloud: 'aws' | 'gcp', schema: 'primary' | 'secondary'): Pool {
    // Map primary/secondary to internal pool names (bpp/bap)
    const internalSchema = schema === 'primary' ? 'bpp' : 'bap';
    const key = `${cloud}_${internalSchema}`;
    const pool = this.pools.get(key);

    if (!pool) {
      logger.error(`Pool not found: ${key}`);
      throw new Error(`Database pool not found: ${key}`);
    }

    return pool;
  }

  public async shutdown() {
    logger.info('Shutting down database pools...');

    const shutdownPromises = Array.from(this.pools.values()).map(pool => pool.end());
    shutdownPromises.push(this.history.end());

    await Promise.all(shutdownPromises);

    logger.info('All database pools closed');
  }
}

export default DatabasePools;
