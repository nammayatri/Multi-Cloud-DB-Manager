import DatabasePools from '../../config/database';
import type { DatabaseInfo } from '../../types';

interface ConnInfo {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

// The only 3 real environment names config_transfer.py's DEFAULT_FETCH_VERSIONS/
// ALLOWED_TRANSFERS ever source FROM — 'local'/'env' are never derivable from
// DATABASE_CONFIGS (dev-machine-specific / not something this app connects to),
// so they're left out of this entirely and keep coming from wherever they
// already do (the local gitignored file).
const REAL_ENV_NAMES = ['master', 'prod', 'prod_international'] as const;

/**
 * The 3 deployment-specific unknowns identified when comparing the real
 * master deployment against environments.json.example's prod/prod_international
 * entries — none of these are derivable from DATABASE_CONFIGS, all default
 * to master's CONFIRMED real values, override per-deployment via env var
 * once someone with access to that specific cluster checks.
 */
const DASHBOARD_DB_SCHEMA = process.env.CONFIG_SYNC_DASHBOARD_DB_SCHEMA || 'atlas_dashboard';
const REGISTRY_DATABASE = process.env.CONFIG_SYNC_REGISTRY_DATABASE || 'atlas_mock_registry_v2';
const REGISTRY_DB_SCHEMA = process.env.CONFIG_SYNC_REGISTRY_DB_SCHEMA || 'atlas_mock_registry';

// Only set on deployments where the DB isn't directly reachable and
// config_transfer.py needs to go through `kubectl exec <pod> -- psql ...`
// instead (see get_connection()'s is_kubectl_env check) — empty/unset means
// direct connection, exactly like the confirmed-working master setup.
const EXEC_POD_NAME = process.env.CONFIG_SYNC_EXEC_POD_NAME || '';
const EXEC_POD_NAMESPACE = process.env.CONFIG_SYNC_EXEC_POD_NAMESPACE || '';

// CONFIG_SYNC_ALLOWED_ENVS names exactly ONE environment per deployment (per
// review: not a comma-separated list) — this either is one of the 3 real,
// derivable envs, or it isn't (e.g. it's 'local', or unset).
function getDerivableSourceEnvs(): string[] {
  const raw = process.env.CONFIG_SYNC_ALLOWED_ENVS?.trim();
  if (!raw) return [];
  return (REAL_ENV_NAMES as readonly string[]).includes(raw) ? [raw] : [];
}

/**
 * schema name -> connection info, built from every database this app already
 * knows about (primary + all secondary clouds) — first entry to declare a
 * given schema wins, primary-first, since DatabasePools.primaryDatabases is
 * listed before secondaryDatabases.
 */
function buildSchemaConnectionMap(): Map<string, ConnInfo> {
  const cloudConfig = DatabasePools.getInstance().getCloudConfig();
  const allEntries: DatabaseInfo[] = [
    ...cloudConfig.primaryDatabases,
    ...Object.values(cloudConfig.secondaryDatabases).flat(),
  ];

  const map = new Map<string, ConnInfo>();
  for (const entry of allEntries) {
    const conn: ConnInfo = {
      host: entry.host, port: entry.port, user: entry.user, password: entry.password, database: entry.database,
    };
    for (const schema of entry.schemas) {
      if (!map.has(schema)) map.set(schema, conn);
    }
  }
  return map;
}

/**
 * Builds config_transfer.py's environments.json shape entirely from
 * DATABASE_CONFIGS — the same real DB credentials DB Manager's own SQL/
 * replication features already use — for whichever real env names this
 * deployment is configured to represent (CONFIG_SYNC_ALLOWED_ENVS). No
 * separate Secret, no new credential material of any kind; the 3 deployment-
 * specific unknowns above (dashboard schema, registry database, execPod)
 * default to master's confirmed values and are overridable per-cluster.
 *
 * Returns null if this deployment hasn't opted in (CONFIG_SYNC_ALLOWED_ENVS
 * unset, or none of its allowed envs are one of the 3 derivable ones, or
 * DATABASE_CONFIGS itself doesn't cover atlas_app) — callers should fall
 * back to the existing k8s-Secret-file / local-file resolution in that case.
 */
export function buildEnvironmentsJsonFromDatabaseConfigs(): Record<string, any> | null {
  const sourceEnvs = getDerivableSourceEnvs();
  if (sourceEnvs.length === 0) return null;

  const schemaMap = buildSchemaConnectionMap();
  // Require atlas_app specifically, not "any schema at all" — a local-dev
  // stub databases.json (schemas: ["public"]) would otherwise pass this
  // check and silently derive a bogus environments.json from the wrong DB.
  const defaultConn = schemaMap.get('atlas_app');
  if (!defaultConn) return null;

  const schemas: Record<string, any> = {};
  for (const [schema, conn] of schemaMap.entries()) {
    schemas[schema] = { database: conn.database };
  }
  // atlas_bap_dashboard / atlas_bpp_dashboard: config.json's registry names
  // for what's often one combined database — alias both onto whichever
  // schema actually declares itself (e.g. "atlas_dashboard" for the
  // confirmed-real Unified-Dashboard setup), with the real Postgres schema
  // name applied via db_schema since it differs from the registry key.
  const dashboardConn = schemaMap.get(DASHBOARD_DB_SCHEMA);
  if (dashboardConn) {
    schemas['atlas_bap_dashboard'] = { database: dashboardConn.database, db_schema: DASHBOARD_DB_SCHEMA };
    schemas['atlas_bpp_dashboard'] = { database: dashboardConn.database, db_schema: DASHBOARD_DB_SCHEMA };
  }
  // atlas_registry (mock-registry's `subscriber` table): not present in
  // DATABASE_CONFIGS under any schema name — shares the same host/user/
  // password as everything else on this Postgres server, just a database
  // name that isn't separately registered there.
  schemas['atlas_registry'] = { database: REGISTRY_DATABASE, db_schema: REGISTRY_DB_SCHEMA };

  const execPod = EXEC_POD_NAME
    ? { pod: EXEC_POD_NAME, namespace: EXEC_POD_NAMESPACE || 'atlas', context: '' }
    : undefined;

  const envJson: Record<string, any> = {};
  for (const env of sourceEnvs) {
    envJson[env] = {
      ...(execPod ? { execPod } : {}),
      default: {
        host: defaultConn.host, port: defaultConn.port,
        user: defaultConn.user, password: defaultConn.password, database: defaultConn.database,
      },
      schemas,
    };
  }
  return envJson;
}
