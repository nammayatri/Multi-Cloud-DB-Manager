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
// atlas_registry isn't declared under any schema in DATABASE_CONFIGS (see
// comment below), so unlike every other schema its host can't be derived —
// it defaults to inheriting `default`'s connection (same as before), but on
// a deployment where the registry DB lives on a different host than the
// default schema (e.g. prod, where BAP/BPP/registry can each be on separate
// clusters), set these explicitly.
const REGISTRY_HOST = process.env.CONFIG_SYNC_REGISTRY_HOST;
const REGISTRY_PORT = process.env.CONFIG_SYNC_REGISTRY_PORT ? Number(process.env.CONFIG_SYNC_REGISTRY_PORT) : undefined;
const REGISTRY_USER = process.env.CONFIG_SYNC_REGISTRY_USER;
const REGISTRY_PASSWORD = process.env.CONFIG_SYNC_REGISTRY_PASSWORD;

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

  // Full connection per schema, not just the database name — different
  // schemas can live on genuinely different Postgres hosts (e.g. BPP/driver
  // vs BAP/rider are separate clusters in prod). get_db_config() in
  // config_transfer.py merges this onto `default`, so host/port/user/
  // password here correctly override the default connection whenever a
  // schema's real host differs from it.
  const schemas: Record<string, any> = {};
  for (const [schema, conn] of schemaMap.entries()) {
    schemas[schema] = { database: conn.database, host: conn.host, port: conn.port, user: conn.user, password: conn.password };
  }
  // atlas_bap_dashboard / atlas_bpp_dashboard: config.json's registry names
  // for what's often one combined database — alias both onto whichever
  // schema actually declares itself (e.g. "atlas_dashboard" for the
  // confirmed-real Unified-Dashboard setup), with the real Postgres schema
  // name applied via db_schema since it differs from the registry key.
  const dashboardConn = schemaMap.get(DASHBOARD_DB_SCHEMA);
  if (dashboardConn) {
    const dashboardBase = { database: dashboardConn.database, db_schema: DASHBOARD_DB_SCHEMA, host: dashboardConn.host, port: dashboardConn.port, user: dashboardConn.user, password: dashboardConn.password };
    schemas['atlas_bap_dashboard'] = dashboardBase;
    schemas['atlas_bpp_dashboard'] = dashboardBase;
  }
  // atlas_registry (mock-registry's `subscriber` table): not present in
  // DATABASE_CONFIGS under any schema name, so its real host can't be
  // derived like every other schema above — falls back to `default`'s
  // connection unless CONFIG_SYNC_REGISTRY_HOST/etc are set explicitly
  // (see their declaration above for when that's needed).
  schemas['atlas_registry'] = {
    database: REGISTRY_DATABASE, db_schema: REGISTRY_DB_SCHEMA,
    ...(REGISTRY_HOST ? { host: REGISTRY_HOST } : {}),
    ...(REGISTRY_PORT ? { port: REGISTRY_PORT } : {}),
    ...(REGISTRY_USER ? { user: REGISTRY_USER } : {}),
    ...(REGISTRY_PASSWORD ? { password: REGISTRY_PASSWORD } : {}),
  };

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
