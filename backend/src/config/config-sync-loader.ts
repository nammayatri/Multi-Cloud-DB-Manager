import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';
import { buildEnvironmentsJsonFromDatabaseConfigs } from '../services/configSync/environmentsFromDatabaseConfigs';

const CONFIG_SYNC_DIR = path.join(__dirname, '../../config-sync');
const LOCAL_ENV_PATH = path.join(CONFIG_SYNC_DIR, 'assets', 'environments.json');

export interface ConfigSyncPaths {
  /** config-sync/config_transfer.py */
  scriptPath: string;
  /** config-sync/ — cwd the subprocess is spawned with */
  scriptDir: string;
  /** wherever environments.json actually is (derived, or the local file) */
  environmentsJsonPath: string;
}

/**
 * Resolve where config_transfer.py and its environments.json actually live.
 *
 * environments.json holds real DB credentials, so — unlike config.json/
 * patches.json, which are static vendored assets the Python script reads
 * directly and Node never needs to parse — this one file needs resolution
 * across two possible sources, checked in this order:
 *   1. Derived from DATABASE_CONFIGS (same real credentials DB Manager's own
 *      SQL/replication features already use) — zero new Secret needed. Only
 *      applies when CONFIG_SYNC_ALLOWED_ENVS names one of master/prod/
 *      prod_international; see environmentsFromDatabaseConfigs.ts. This is
 *      the only path any real deployment uses.
 *   2. local gitignored file: config-sync/assets/environments.json —
 *      local-dev-only fallback, since local dev's databases.json is a stub
 *      that DATABASE_CONFIGS-derivation deliberately refuses to use.
 *
 * config_transfer.py itself only ever reads environments.json relative to
 * its own SCRIPT_DIR (assets/environments.json) — it has no env-var override
 * for that path. So whichever source above is actually used, the caller
 * (ensureEnvironmentsJsonInPlace) must materialize it at that exact path
 * before every run.
 */
export function resolveConfigSyncPaths(): ConfigSyncPaths {
  const scriptDir = CONFIG_SYNC_DIR;
  const scriptPath = path.join(scriptDir, 'config_transfer.py');

  let environmentsJsonPath: string;
  if (buildEnvironmentsJsonFromDatabaseConfigs()) {
    logger.info('Config Sync: deriving environments.json from DATABASE_CONFIGS');
    environmentsJsonPath = LOCAL_ENV_PATH; // ensureEnvironmentsJsonInPlace() writes it here
  } else if (fs.existsSync(LOCAL_ENV_PATH)) {
    logger.info('Config Sync: using local environments.json', { path: LOCAL_ENV_PATH });
    environmentsJsonPath = LOCAL_ENV_PATH;
  } else {
    throw new Error(
      `Config Sync: environments.json not found. Set CONFIG_SYNC_ALLOWED_ENVS to master/prod/` +
      `prod_international to derive it from DATABASE_CONFIGS, or for local dev copy ` +
      `${LOCAL_ENV_PATH}.example to ${LOCAL_ENV_PATH} and fill in real credentials.`
    );
  }

  return { scriptPath, scriptDir, environmentsJsonPath };
}

/**
 * Materialize environments.json at the exact path config_transfer.py
 * hardcodes (assets/environments.json), idempotent, safe to call on every
 * server start and before every job run.
 *   1. Derived from DATABASE_CONFIGS — merged on top of whatever local/env
 *      stub already exists on disk, so those two envs are preserved even
 *      though they're never derived.
 *   2. Already-present local file — no-op.
 */
export function ensureEnvironmentsJsonInPlace(): void {
  const derived = buildEnvironmentsJsonFromDatabaseConfigs();
  if (!derived) return;

  try {
    const base: Record<string, any> = fs.existsSync(LOCAL_ENV_PATH)
      ? JSON.parse(fs.readFileSync(LOCAL_ENV_PATH, 'utf8'))
      : {};
    const merged = { ...base, ...derived };
    fs.mkdirSync(path.dirname(LOCAL_ENV_PATH), { recursive: true });
    fs.writeFileSync(LOCAL_ENV_PATH, JSON.stringify(merged, null, 2));
    logger.info('Config Sync: wrote environments.json derived from DATABASE_CONFIGS', {
      envs: Object.keys(derived), to: LOCAL_ENV_PATH,
    });
  } catch (error) {
    logger.error('Config Sync: failed to write derived environments.json', { error });
    throw error;
  }
}

/**
 * Cheap readiness probe — lets a health endpoint report "Config Sync not
 * available" with a clear reason instead of every export/patch attempt
 * failing with a raw ENOENT the first time someone tries it.
 */
export function checkConfigSyncReadiness(): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  const scriptPath = path.join(CONFIG_SYNC_DIR, 'config_transfer.py');
  const binaryPath = path.join(CONFIG_SYNC_DIR, 'bin', 'passetto-server-x86_64');

  if (!fs.existsSync(scriptPath)) missing.push('config_transfer.py');
  if (!fs.existsSync(binaryPath)) missing.push('bin/passetto-server-x86_64');
  if (!buildEnvironmentsJsonFromDatabaseConfigs() && !fs.existsSync(LOCAL_ENV_PATH)) {
    missing.push('environments.json');
  }

  return { ready: missing.length === 0, missing };
}
