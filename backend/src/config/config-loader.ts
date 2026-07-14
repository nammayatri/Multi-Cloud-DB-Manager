import fs from 'fs';
import path from 'path';
import { DatabasesConfigJson, DatabaseConfigJson, CloudConfigJson } from '../types';
import logger from '../utils/logger';

/**
 * Load database configuration from multiple sources (priority order):
 * 1. DATABASE_CONFIGS environment variable (base64-encoded JSON)
 * 2. Kubernetes ConfigMap/Secret mounted at /config/databases.json
 * 3. Local file at backend/config/databases.json
 * 4. Environment variables (fallback)
 */
export function loadDatabaseConfig(): DatabasesConfigJson | null {
  // Try DATABASE_CONFIGS environment variable first (base64-encoded JSON)
  if (process.env.DATABASE_CONFIGS) {
    logger.info('Loading database configuration from DATABASE_CONFIGS environment variable');
    return loadFromBase64Env();
  }

  // Try Kubernetes mounted config (ConfigMap or Secret)
  const k8sConfigPath = '/config/databases.json';
  if (fs.existsSync(k8sConfigPath)) {
    logger.info('Loading database configuration from Kubernetes mount', { path: k8sConfigPath });
    return loadFromJsonFile(k8sConfigPath);
  }

  // Try local config file
  const configPath = path.join(__dirname, '../../config/databases.json');
  if (fs.existsSync(configPath)) {
    logger.info('Loading database configuration from local file', { path: configPath });
    return loadFromJsonFile(configPath);
  }

  logger.warn('databases.json not found in any location, using environment variables fallback');
  return null;
}

/**
 * Load configuration from base64-encoded DATABASE_CONFIGS environment variable
 */
function loadFromBase64Env(): DatabasesConfigJson | null {
  try {
    const base64Config = process.env.DATABASE_CONFIGS;
    if (!base64Config) {
      return null;
    }

    // Decode base64 to JSON string
    const jsonString = Buffer.from(base64Config, 'base64').toString('utf-8');

    // Substitute environment variables: ${VAR_NAME}
    const substituted = jsonString.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      // Check if it's a Kubernetes secret reference
      if (varName.startsWith('SECRET:')) {
        const parts = varName.split(':');
        if (parts.length === 3) {
          const [, secretName, keyName] = parts;
          const secretPath = `/secrets/${secretName}/${keyName}`;
          if (fs.existsSync(secretPath)) {
            try {
              return fs.readFileSync(secretPath, 'utf-8').trim();
            } catch (error) {
              logger.warn(`Failed to read Kubernetes secret at ${secretPath}:`, error);
              return match;
            }
          }
        }
      }

      // Regular environment variable
      const value = process.env[varName];
      if (!value) {
        logger.warn(`Environment variable ${varName} not found, using placeholder`);
        return match;
      }
      return value;
    });

    // Parse JSON, normalizing the grouped databasesByName format if present
    const config: DatabasesConfigJson = normalizeConfig(JSON.parse(substituted));

    // Validate structure
    validateConfig(config);

    logger.info('Database configuration loaded from DATABASE_CONFIGS env variable', {
      primaryCloud: config.primary.cloudName,
      primaryDatabases: config.primary.db_configs.length,
      secondaryClouds: config.secondary.length
    });

    return config;
  } catch (error) {
    logger.error('Failed to load database configuration from DATABASE_CONFIGS:', error);
    throw new Error(`Invalid DATABASE_CONFIGS: ${error}`);
  }
}

/**
 * Load configuration from a JSON file with environment variable substitution
 */
function loadFromJsonFile(filePath: string): DatabasesConfigJson | null {

  try {
    // Read JSON file
    const configContent = fs.readFileSync(filePath, 'utf-8');

    // Substitute environment variables: ${VAR_NAME}
    // Also supports Kubernetes secret references: ${SECRET:secret-name:key-name}
    const substituted = configContent.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      // Check if it's a Kubernetes secret reference
      if (varName.startsWith('SECRET:')) {
        const parts = varName.split(':');
        if (parts.length === 3) {
          const [, secretName, keyName] = parts;
          const secretPath = `/secrets/${secretName}/${keyName}`;
          if (fs.existsSync(secretPath)) {
            try {
              return fs.readFileSync(secretPath, 'utf-8').trim();
            } catch (error) {
              logger.warn(`Failed to read Kubernetes secret at ${secretPath}:`, error);
              return match;
            }
          }
        }
      }

      // Regular environment variable
      const value = process.env[varName];
      if (!value) {
        logger.warn(`Environment variable ${varName} not found, using placeholder`);
        return match;
      }
      return value;
    });

    // Parse JSON, normalizing the grouped databasesByName format if present
    const config: DatabasesConfigJson = normalizeConfig(JSON.parse(substituted));

    // Validate structure
    validateConfig(config);

    logger.info('Database configuration loaded successfully', {
      source: filePath,
      primaryCloud: config.primary.cloudName,
      primaryDatabases: config.primary.db_configs.length,
      secondaryClouds: config.secondary.length
    });

    return config;
  } catch (error) {
    logger.error('Failed to load database configuration from JSON:', error);
    throw new Error(`Invalid database configuration: ${error}`);
  }
}

/**
 * Normalize a parsed config into the legacy { primary, secondary[] } shape,
 * plus a per-database `databaseRoles` map.
 *
 * Supports two authoring formats transparently:
 *   1. Legacy   — { primary: {...}, secondary: [...] }  → returned as-is
 *   2. Grouped  — { databasesByName: { <name>: { label, clouds: [...] } } }
 *                 → converted here
 *
 * Cloud roles are PER DATABASE: each database names its own primary cloud (its
 * write target + replication publisher) and any number of secondaries. Different
 * databases may use different primary clouds (e.g. Driver aws-primary while Rider
 * is gcp-primary). Each database must have exactly one `primary` cloud entry.
 *
 * The { primary, secondary[] } buckets we emit are only used to CREATE POOLS
 * (which are keyed by cloud+db and don't care about role), so we bucket purely
 * by cloud and cover every (cloud, database) pair. Routing (INSERT, replication,
 * fan-out) reads the accurate `databaseRoles` map instead. Any extra top-level
 * keys (history, slack, readReplicas, migrations, environment, …) pass through.
 */
function normalizeConfig(raw: any): DatabasesConfigJson {
  // Already in legacy format (or malformed — let validateConfig report it)
  if (!raw || typeof raw !== 'object' || !raw.databasesByName) {
    return raw as DatabasesConfigJson;
  }

  logger.info('Detected grouped "databasesByName" config format — normalizing (per-database cloud roles)');

  // All db_configs grouped by cloud (for pool creation) — first-seen order.
  const cloudToDbConfigs = new Map<string, DatabaseConfigJson[]>();
  // Per-database roles (the source of truth for routing).
  const databaseRoles: { [db: string]: { primaryCloud: string; secondaryClouds: string[] } } = {};

  for (const [name, group] of Object.entries<any>(raw.databasesByName)) {
    if (!group || !Array.isArray(group.clouds) || group.clouds.length === 0) {
      throw new Error(`Invalid grouped config: database "${name}" must have a non-empty "clouds" array`);
    }

    let primaryCloud: string | undefined;
    const secondaryClouds: string[] = [];

    for (const cloud of group.clouds) {
      if (!cloud || !cloud.cloudType) {
        throw new Error(`Invalid grouped config: a cloud entry for "${name}" is missing "cloudType"`);
      }

      // Role is explicit; fall back to inferring it from pub/sub naming.
      const role: 'primary' | 'secondary' | undefined =
        cloud.role ??
        (cloud.publicationName ? 'primary' : cloud.subscriptionName ? 'secondary' : undefined);

      if (role !== 'primary' && role !== 'secondary') {
        throw new Error(
          `Invalid grouped config: cloud "${cloud.cloudType}" for database "${name}" needs a "role" of "primary" or "secondary"`
        );
      }

      if (role === 'primary') {
        if (primaryCloud) {
          throw new Error(
            `Invalid grouped config: database "${name}" has more than one primary cloud (${primaryCloud}, ${cloud.cloudType}); each database may have only one primary`
          );
        }
        primaryCloud = cloud.cloudType;
      } else {
        secondaryClouds.push(cloud.cloudType);
      }

      const dbConfig: DatabaseConfigJson = {
        name,
        label: cloud.label || group.label || name,
        host: cloud.host,
        port: cloud.port,
        user: cloud.user,
        password: cloud.password,
        database: cloud.database,
        schemas: cloud.schemas,
        defaultSchema: cloud.defaultSchema,
        ...(cloud.publicationName ? { publicationName: cloud.publicationName } : {}),
        ...(cloud.subscriptionName ? { subscriptionName: cloud.subscriptionName } : {}),
        ...(cloud.indexCreateBlockedTables ? { indexCreateBlockedTables: cloud.indexCreateBlockedTables } : {}),
      };

      if (!cloudToDbConfigs.has(cloud.cloudType)) {
        cloudToDbConfigs.set(cloud.cloudType, []);
      }
      cloudToDbConfigs.get(cloud.cloudType)!.push(dbConfig);
    }

    if (!primaryCloud) {
      throw new Error(`Invalid grouped config: database "${name}" has no "primary" cloud entry`);
    }
    databaseRoles[name] = { primaryCloud, secondaryClouds };
  }

  const cloudNames = [...cloudToDbConfigs.keys()];
  if (cloudNames.length === 0) {
    throw new Error('Invalid grouped config: no cloud entries found');
  }

  // Bucket by cloud for pool creation. The "global" primary is just the first
  // cloud that is a primary for some database — a legacy default; real routing
  // uses databaseRoles. Every (cloud, db) pair is covered so all pools are made.
  const firstDb = Object.keys(databaseRoles)[0];
  const globalPrimaryCloud = databaseRoles[firstDb].primaryCloud;
  const primary: CloudConfigJson = {
    cloudName: globalPrimaryCloud,
    db_configs: cloudToDbConfigs.get(globalPrimaryCloud)!,
  };
  const secondary: CloudConfigJson[] = cloudNames
    .filter(c => c !== globalPrimaryCloud)
    .map(cloudName => ({ cloudName, db_configs: cloudToDbConfigs.get(cloudName)! }));

  // Drop databasesByName; carry every other top-level key through unchanged.
  const { databasesByName, ...rest } = raw;

  return {
    ...rest,
    primary,
    secondary,
    databaseRoles,
  } as DatabasesConfigJson;
}

/**
 * Validate the configuration structure
 */
function validateConfig(config: DatabasesConfigJson): void {
  if (!config.primary || !config.primary.cloudName || !config.primary.db_configs) {
    throw new Error('Invalid configuration: missing primary cloud configuration');
  }

  if (!Array.isArray(config.primary.db_configs) || config.primary.db_configs.length === 0) {
    throw new Error('Invalid configuration: primary cloud must have at least one database');
  }

  if (!Array.isArray(config.secondary)) {
    throw new Error('Invalid configuration: secondary must be an array');
  }

  // Validate each database config
  const allConfigs = [
    ...config.primary.db_configs,
    ...config.secondary.flatMap(c => c.db_configs)
  ];

  for (const db of allConfigs) {
    if (!db.name || !db.label || !db.host || !db.database) {
      throw new Error(`Invalid database configuration: missing required fields for ${db.name || 'unknown'}`);
    }

    if (!Array.isArray(db.schemas)) {
      throw new Error(`Invalid database configuration: schemas must be an array for ${db.name}`);
    }

    if (!db.defaultSchema) {
      throw new Error(`Invalid database configuration: missing defaultSchema for ${db.name}`);
    }
  }

  // Validate history config
  if (!config.history || !config.history.host || !config.history.database) {
    throw new Error('Invalid configuration: missing or incomplete history database configuration');
  }

  logger.debug('Database configuration validation passed');
}

/**
 * Convert environment variables to JSON configuration format (fallback)
 */
export function convertEnvToJson(): DatabasesConfigJson {
  logger.info('Using environment variables for database configuration');

  return {
    primary: {
      cloudName: 'aws',
      db_configs: [
        {
          name: 'bpp',
          label: 'Driver (BPP)',
          host: process.env.AWS_DB_HOST!,
          port: parseInt(process.env.AWS_DB_PORT || '5432'),
          user: process.env.AWS_DB_USER!,
          password: process.env.AWS_DB_PASSWORD!,
          database: process.env.CLOUD1_DB1 || process.env.CLOUD1_DB1!,
          schemas: (process.env.PRIMARY_SCHEMAS || process.env.DB1_SCHEMAS || '')
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0),
          defaultSchema: process.env.PRIMARY_DEFAULT_SCHEMA || process.env.DB1_DEFAULT_SCHEMA || 'myapp_schema1'
        },
        {
          name: 'bap',
          label: 'Rider (BAP)',
          host: process.env.AWS_DB_HOST!,
          port: parseInt(process.env.AWS_DB_PORT || '5432'),
          user: process.env.AWS_DB_USER!,
          password: process.env.AWS_DB_PASSWORD!,
          database: process.env.CLOUD1_DB2 || process.env.CLOUD1_DB2!,
          schemas: (process.env.SECONDARY_SCHEMAS || process.env.DB2_SCHEMAS || '')
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0),
          defaultSchema: process.env.SECONDARY_DEFAULT_SCHEMA || process.env.DB2_DEFAULT_SCHEMA || 'myapp_schema2'
        }
      ]
    },
    secondary: [
      {
        cloudName: 'gcp',
        db_configs: [
          {
            name: 'bpp',
            label: 'Driver (BPP)',
            host: process.env.GCP_DB_HOST!,
            port: parseInt(process.env.GCP_DB_PORT || '5432'),
            user: process.env.GCP_DB_USER!,
            password: process.env.GCP_DB_PASSWORD!,
            database: process.env.CLOUD2_DB1 || process.env.CLOUD2_DB1!,
            schemas: [],
            defaultSchema: 'myapp_schema1'
          },
          {
            name: 'bap',
            label: 'Rider (BAP)',
            host: process.env.GCP_DB_HOST!,
            port: parseInt(process.env.GCP_DB_PORT || '5432'),
            user: process.env.GCP_DB_USER!,
            password: process.env.GCP_DB_PASSWORD!,
            database: process.env.CLOUD2_DB2 || process.env.CLOUD2_DB2!,
            schemas: [],
            defaultSchema: 'myapp_schema2'
          }
        ]
      }
    ],
    history: {
      host: process.env.HISTORY_DB_HOST!,
      port: parseInt(process.env.HISTORY_DB_PORT || '5432'),
      user: process.env.HISTORY_DB_USER!,
      password: process.env.HISTORY_DB_PASSWORD!,
      database: process.env.HISTORY_DB_NAME!
    }
  };
}
