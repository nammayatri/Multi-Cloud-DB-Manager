import fs from 'fs';
import path from 'path';
import { RedisConfigJson } from '../types';
import logger from '../utils/logger';

/**
 * Load Redis configuration from multiple sources (priority order):
 * 1. REDIS_CONFIGS environment variable (base64-encoded JSON)
 * 2. Kubernetes ConfigMap/Secret mounted at /config/redis.json
 * 3. Local file at backend/config/redis.json
 */
export function loadRedisConfig(): RedisConfigJson | null {
  // Try REDIS_CONFIGS environment variable first (base64-encoded JSON)
  if (process.env.REDIS_CONFIGS) {
    logger.info('Loading Redis configuration from REDIS_CONFIGS environment variable');
    return loadFromBase64Env();
  }

  // Try Kubernetes mounted config
  const k8sConfigPath = '/config/redis.json';
  if (fs.existsSync(k8sConfigPath)) {
    logger.info('Loading Redis configuration from Kubernetes mount', { path: k8sConfigPath });
    return loadFromJsonFile(k8sConfigPath);
  }

  // Try local config file
  const configPath = path.join(__dirname, '../../config/redis.json');
  if (fs.existsSync(configPath)) {
    logger.info('Loading Redis configuration from local file', { path: configPath });
    return loadFromJsonFile(configPath);
  }

  logger.warn('redis.json not found in any location, Redis Manager will be disabled');
  return null;
}

/**
 * Load configuration from base64-encoded REDIS_CONFIGS environment variable
 */
function loadFromBase64Env(): RedisConfigJson | null {
  try {
    const base64Config = process.env.REDIS_CONFIGS;
    if (!base64Config) {
      return null;
    }

    const jsonString = Buffer.from(base64Config, 'base64').toString('utf-8');
    const substituted = substituteEnvVars(jsonString);
    const config: RedisConfigJson = JSON.parse(substituted);

    validateConfig(config);

    logger.info('Redis configuration loaded from REDIS_CONFIGS env variable', {
      primaryCloud: config.primary.cloudName,
      secondaryClouds: config.secondary.length,
    });

    return config;
  } catch (error) {
    logger.error('Failed to load Redis configuration from REDIS_CONFIGS:', error);
    throw new Error(`Invalid REDIS_CONFIGS: ${error}`);
  }
}

/**
 * Load configuration from a JSON file with environment variable substitution
 */
function loadFromJsonFile(filePath: string): RedisConfigJson | null {
  try {
    const configContent = fs.readFileSync(filePath, 'utf-8');
    const substituted = substituteEnvVars(configContent);
    const config: RedisConfigJson = JSON.parse(substituted);

    validateConfig(config);

    logger.info('Redis configuration loaded successfully', {
      source: filePath,
      primaryCloud: config.primary.cloudName,
      secondaryClouds: config.secondary.length,
    });

    return config;
  } catch (error) {
    logger.error('Failed to load Redis configuration from JSON:', error);
    throw new Error(`Invalid Redis configuration: ${error}`);
  }
}

/**
 * Substitute ${VAR_NAME} placeholders with environment variables
 */
function substituteEnvVars(content: string): string {
  return content.replace(/\$\{([^}]+)\}/g, (match, varName) => {
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
}

/**
 * Validate the Redis configuration structure
 */
function validateConfig(config: RedisConfigJson): void {
  if (!config.primary || !config.primary.cloudName || !config.primary.host || !config.primary.port) {
    throw new Error('Invalid Redis configuration: missing primary cloud configuration (cloudName, host, port required)');
  }

  if (!Array.isArray(config.secondary)) {
    throw new Error('Invalid Redis configuration: secondary must be an array');
  }

  for (const sec of config.secondary) {
    if (!sec.cloudName || !sec.host || !sec.port) {
      throw new Error(`Invalid Redis configuration: missing required fields for secondary cloud ${sec.cloudName || 'unknown'}`);
    }
  }

  logger.debug('Redis configuration validation passed');
}
