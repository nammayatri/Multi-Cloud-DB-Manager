import fs from 'fs';
import path from 'path';
import { SystemConfigsConfigJson, SystemConfigTargetJson, SystemConfigTargetKey } from '../types';
import { substituteEnvVars } from './redis-config-loader';
import DatabasePools from './database';
import logger from '../utils/logger';

const TARGET_KEYS: SystemConfigTargetKey[] = ['rider', 'driver'];

// Schema names are interpolated into SQL (identifiers cannot be bind parameters),
// so they must be validated as strict identifiers before any query is built.
const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Load System Configs configuration from multiple sources (priority order):
 * 1. SYSTEM_CONFIGS_CONFIG environment variable (base64-encoded JSON)
 * 2. Kubernetes ConfigMap/Secret mounted at /config/system-configs.json
 * 3. Local file at backend/config/system-configs.json
 *
 * Never throws — a missing/broken config simply disables the System Configs
 * manager (graceful degradation; the app must boot fine without it).
 */
function loadRawConfig(): SystemConfigsConfigJson | null {
  try {
    if (process.env.SYSTEM_CONFIGS_CONFIG) {
      logger.info('Loading System Configs configuration from SYSTEM_CONFIGS_CONFIG environment variable');
      const jsonString = Buffer.from(process.env.SYSTEM_CONFIGS_CONFIG, 'base64').toString('utf-8');
      return JSON.parse(substituteEnvVars(jsonString));
    }

    const k8sConfigPath = '/config/system-configs.json';
    if (fs.existsSync(k8sConfigPath)) {
      logger.info('Loading System Configs configuration from Kubernetes mount', { path: k8sConfigPath });
      return JSON.parse(substituteEnvVars(fs.readFileSync(k8sConfigPath, 'utf-8')));
    }

    const configPath = path.join(__dirname, '../../config/system-configs.json');
    if (fs.existsSync(configPath)) {
      logger.info('Loading System Configs configuration from local file', { path: configPath });
      return JSON.parse(substituteEnvVars(fs.readFileSync(configPath, 'utf-8')));
    }

    logger.warn('system-configs.json not found in any location, System Configs manager will be disabled');
    return null;
  } catch (error) {
    logger.error('Failed to load System Configs configuration, manager will be disabled:', error);
    return null;
  }
}

/**
 * Validate one target after env substitution.
 * Returns a human-readable problem string, or null if the target is valid.
 */
function validateTarget(target: SystemConfigTargetJson): string | null {
  const fields: Array<[string, unknown]> = [
    ['label', target.label],
    ['schema', target.schema],
    ['dashboardBaseUrl', target.dashboardBaseUrl],
    ['pathPrefix', target.pathPrefix],
    ['merchantShortId', target.merchantShortId],
    ['city', target.city],
    ['email', target.email],
    ['password', target.password],
    ['readPool.cloud', target.readPool?.cloud],
    ['readPool.database', target.readPool?.database],
  ];

  for (const [name, value] of fields) {
    if (typeof value !== 'string' || value.length === 0) {
      return `missing or empty field "${name}"`;
    }
    // The substituter leaves unresolved ${VAR} placeholders literally in place —
    // a leftover '${' means the referenced env var / secret was not available.
    if (value.includes('${')) {
      return `unresolved placeholder in "${name}" (set the referenced environment variable or secret)`;
    }
  }

  if (!IDENTIFIER_PATTERN.test(target.schema)) {
    return `invalid schema identifier "${target.schema}"`;
  }

  return null;
}

/**
 * Singleton accessor for the System Configs manager configuration.
 * A target is only usable when its config is fully resolved AND its
 * readPool maps to an existing Postgres pool.
 */
class SystemConfigsConfig {
  private static instance: SystemConfigsConfig | null = null;

  private targets: Map<SystemConfigTargetKey, SystemConfigTargetJson> = new Map();
  private warnedMissingPools: Set<SystemConfigTargetKey> = new Set();

  private constructor() {
    const raw = loadRawConfig();
    if (!raw || typeof raw.targets !== 'object' || raw.targets === null) {
      return;
    }

    for (const key of TARGET_KEYS) {
      const target = raw.targets[key];
      if (!target) continue;

      const problem = validateTarget(target);
      if (problem) {
        logger.warn(`System Configs target "${key}" disabled: ${problem}`);
        continue;
      }

      this.targets.set(key, target);
    }

    if (this.targets.size > 0) {
      logger.info('System Configs manager configured', {
        targets: Array.from(this.targets.keys()),
      });
    }
  }

  public static getInstance(): SystemConfigsConfig {
    if (!SystemConfigsConfig.instance) {
      SystemConfigsConfig.instance = new SystemConfigsConfig();
    }
    return SystemConfigsConfig.instance;
  }

  /**
   * True when at least one target is fully usable (config resolved + read pool exists)
   */
  public isConfigured(): boolean {
    return TARGET_KEYS.some(key => this.getTarget(key) !== null);
  }

  /**
   * Get a target's config — null when the target is missing, has unresolved
   * placeholders, or its read pool does not exist in databases.json.
   */
  public getTarget(key: SystemConfigTargetKey): SystemConfigTargetJson | null {
    const target = this.targets.get(key);
    if (!target) return null;
    if (!this.hasReadPool(key, target)) return null;
    return target;
  }

  /**
   * Usable targets for the UI selector (no credentials/URLs exposed)
   */
  public getAvailableTargets(): Array<{ key: SystemConfigTargetKey; label: string; schema: string }> {
    const available: Array<{ key: SystemConfigTargetKey; label: string; schema: string }> = [];
    for (const key of TARGET_KEYS) {
      const target = this.getTarget(key);
      if (target) {
        available.push({ key, label: target.label, schema: target.schema });
      }
    }
    return available;
  }

  private hasReadPool(key: SystemConfigTargetKey, target: SystemConfigTargetJson): boolean {
    try {
      const pool = DatabasePools.getInstance().getPoolByName(target.readPool.cloud, target.readPool.database);
      if (!pool) {
        if (!this.warnedMissingPools.has(key)) {
          this.warnedMissingPools.add(key);
          logger.warn(
            `System Configs target "${key}" disabled: read pool ${target.readPool.cloud}_${target.readPool.database} not found in databases configuration`
          );
        }
        return false;
      }
      return true;
    } catch (error) {
      if (!this.warnedMissingPools.has(key)) {
        this.warnedMissingPools.add(key);
        logger.warn(`System Configs target "${key}" disabled: database pools unavailable`, { error: String(error) });
      }
      return false;
    }
  }
}

export default SystemConfigsConfig;
