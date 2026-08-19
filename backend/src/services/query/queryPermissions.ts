import { Role, isSuperRole } from '../../constants/roles';
import QueryValidator from './QueryValidator';
import DatabasePools from '../../config/database';

/**
 * Pure query-authorisation logic, extracted so the three places that need it
 * stay in lockstep:
 *
 *   1. validateQueryPermissions (auth.middleware) — gates POST /api/query/execute
 *   2. query-request creation   — decides whether a user needs approval at all
 *   3. query-request approval   — verifies the APPROVER's role permits the query
 *
 * Before this existed the rules lived only inside the middleware, so the
 * approval path would have had to either duplicate them or bypass them.
 * Messages are kept verbatim: the frontend matches on some of them.
 */

export interface PermissionVerdict {
  allowed: boolean;
  message?: string;
  violations?: Array<{ statement: string; reason: string }>;
  allowedOperations?: string[];
}

const ALLOWED: PermissionVerdict = { allowed: true };

/** Statements a USER may run. */
const USER_ALLOWED_PATTERNS = [
  /^\s*SELECT/i,
  /^\s*WITH[\s\S]*SELECT/i, // CTEs with SELECT ([\s\S] so multi-line CTEs match)
  /^\s*INSERT/i,
  /^\s*UPDATE/i,
  /^\s*ALTER\s+TABLE/i,
  /^\s*CREATE\s+TABLE/i,
  /^\s*CREATE\s+INDEX/i,
  // EXPLAIN restricted to read statements — EXPLAIN ANALYZE on a write
  // statement actually executes the write.
  /^\s*EXPLAIN(\s+\([^)]*\)|\s+ANALYZE|\s+VERBOSE)*\s+(SELECT|WITH)/i,
  /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i,
];

/**
 * Statements a READER may run.
 *
 * This MUST be an allowlist over every statement, not a keyword denylist over
 * the whole query — a denylist lets a disallowed statement hide behind a
 * leading SELECT (e.g. "SELECT 1; DROP INDEX x;").
 */
const READER_ALLOWED_PATTERNS = [
  /^\s*SELECT/i,
  /^\s*WITH[\s\S]*SELECT/i, // CTEs with SELECT
  /^\s*EXPLAIN(\s+\([^)]*\)|\s+ANALYZE|\s+VERBOSE)*\s+(SELECT|WITH)/i,
  /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i,
];

/** Split defensively — a parse failure must not widen access. */
const splitOrWhole = (query: string): string[] => {
  try {
    return QueryValidator.splitStatements(query);
  } catch {
    return [query];
  }
};

/**
 * Does `role` permit every statement in `query`?
 *
 * Note this is the ROLE allowlist only. ALTER/DROP additionally require a
 * password and MASTER/ADMIN — see requiresPasswordGate / canRunDirectly.
 */
export const checkRolePermission = (
  role: Role | string | undefined,
  query: string,
  opts: { continueOnError?: boolean } = {}
): PermissionVerdict => {
  if (!role || !query) {
    return { allowed: false, message: 'Role and query are required' };
  }

  // MASTER and ADMIN can run anything (ADMIN differs from MASTER only in
  // user-access management, which is gated at the auth routes).
  if (isSuperRole(role)) {
    return ALLOWED;
  }

  // CKH_MANAGER currently has no Postgres access.
  if (role === Role.CKH_MANAGER) {
    return {
      allowed: false,
      message: 'CKH_MANAGER does not have Postgres access',
    };
  }

  // RELEASE_MANAGER: SELECT/EXPLAIN, ALTER TABLE ADD COLUMN/CONSTRAINT,
  // CREATE INDEX CONCURRENTLY, transaction control. Per-statement enforcement.
  if (role === Role.RELEASE_MANAGER) {
    const statements = splitOrWhole(query);
    const violations: Array<{ statement: string; reason: string }> = [];

    for (const stmt of statements) {
      const verdict = QueryValidator.isAllowedForReleaseManager(stmt);
      if (!verdict.allowed) {
        violations.push({
          statement: stmt.trim().substring(0, 200),
          reason: verdict.reason || 'not allowed',
        });
      }
    }

    if (violations.length === 0) {
      return ALLOWED;
    }

    // Multi-statement + continueOnError: let it through; the executor rejects
    // offending statements per-statement (defense-in-depth duplicated there).
    if (opts.continueOnError && statements.length > 1) {
      return ALLOWED;
    }

    return {
      allowed: false,
      message:
        `RELEASE_MANAGER role: ${violations[0].reason}. ` +
        `Allowed: SELECT/EXPLAIN, CREATE TABLE, CREATE INDEX CONCURRENTLY, ALTER TABLE ADD COLUMN (with DEFAULT if NOT NULL), ALTER TABLE ADD CONSTRAINT.`,
      violations,
    };
  }

  if (role === Role.USER) {
    // Validate EVERY statement, not just the query as a whole — otherwise a
    // disallowed statement can hide behind an allowed one
    // (e.g. "SELECT 1; DELETE FROM t").
    const disallowed = splitOrWhole(query).find(
      stmt => !USER_ALLOWED_PATTERNS.some(pattern => pattern.test(stmt))
    );

    if (!disallowed) {
      return ALLOWED;
    }

    // Identify what they tried to do (first keyword of the offending statement)
    const upperStmt = disallowed.trim().toUpperCase();
    let attemptedOperation = 'Unknown';
    if (upperStmt.startsWith('DELETE')) attemptedOperation = 'DELETE';
    else if (upperStmt.startsWith('DROP')) attemptedOperation = 'DROP';
    else if (upperStmt.startsWith('TRUNCATE')) attemptedOperation = 'TRUNCATE';
    else if (upperStmt.startsWith('GRANT')) attemptedOperation = 'GRANT';
    else if (upperStmt.startsWith('REVOKE')) attemptedOperation = 'REVOKE';
    else if (upperStmt.startsWith('CREATE DATABASE')) attemptedOperation = 'CREATE DATABASE';
    else if (upperStmt.startsWith('CREATE SCHEMA')) attemptedOperation = 'CREATE SCHEMA';

    return {
      allowed: false,
      message: `${role} role can only execute: SELECT, INSERT, UPDATE, ALTER TABLE, CREATE TABLE, CREATE INDEX. ${attemptedOperation} requires MASTER role.`,
      allowedOperations: ['SELECT', 'INSERT', 'UPDATE', 'ALTER TABLE', 'CREATE TABLE', 'CREATE INDEX'],
    };
  }

  if (role === Role.READER) {
    const disallowed = splitOrWhole(query).find(
      stmt => stmt.trim().length > 0 && !READER_ALLOWED_PATTERNS.some(pattern => pattern.test(stmt))
    );

    if (!disallowed) {
      return ALLOWED;
    }

    return {
      allowed: false,
      message: 'READER role can only execute read-only statements (SELECT, WITH ... SELECT, EXPLAIN SELECT).',
    };
  }

  // Fail closed: every role must be explicitly handled above. An unknown role
  // must never fall through to full query access.
  return {
    allowed: false,
    message: `Role ${role} does not have query access`,
  };
};

/**
 * Returns the sensitive operation ('ALTER'/'DROP'/…) when the query needs
 * password re-verification, or null. These are additionally MASTER/ADMIN-only.
 */
export const requiresPasswordGate = (query: string): string | null =>
  QueryValidator.requiresPasswordVerification(query);

/**
 * Can this user run the query themselves, right now, with no approval?
 *
 * This is deliberately stricter than checkRolePermission: a USER passes the
 * role allowlist for `ALTER TABLE ... DROP COLUMN` but is still rejected by the
 * password gate, which is MASTER/ADMIN-only. Requests must be accepted for that
 * case, so the two checks have to be combined in one place.
 */
export const canRunDirectly = (
  role: Role | string | undefined,
  query: string,
  opts: { continueOnError?: boolean } = {}
): PermissionVerdict => {
  const roleVerdict = checkRolePermission(role, query, opts);
  if (!roleVerdict.allowed) {
    return roleVerdict;
  }

  if (requiresPasswordGate(query) && !isSuperRole(role)) {
    return {
      allowed: false,
      message: 'Only MASTER or ADMIN users can execute ALTER/DROP queries',
    };
  }

  return ALLOWED;
};

/**
 * Roles that may submit a query request for approval.
 *
 * MASTER/ADMIN are excluded because they can run anything already, and
 * CKH_MANAGER because it has no Postgres access at all — there is nothing for
 * an approver to grant it. Unknown roles are excluded by fail-closed default.
 */
const REQUESTER_ROLES: string[] = [Role.USER, Role.READER, Role.RELEASE_MANAGER];

export const canRequestApproval = (role?: string | null): boolean =>
  !!role && REQUESTER_ROLES.includes(role);

export interface ExecutionConstraintParams {
  query: string;
  database: string;
  mode: string;
  pgSchema?: string;
}

export interface ExecutionConstraintVerdict {
  ok: boolean;
  status?: number;
  message?: string;
  /** Set when the failure is the hard CREATE INDEX block, which approval cannot lift. */
  blockedTables?: string[];
}

/**
 * Role-independent execution constraints, extracted from the executeQuery
 * controller so the approval path enforces them identically:
 *
 *   - target database / cloud mode must exist in the loaded configuration
 *   - INSERT may only target this database's own primary cloud
 *   - CREATE INDEX on a protected table is hard-blocked with no override
 *
 * Without this extraction, approving a request and calling startExecution
 * directly would silently skip all three.
 */
export const checkExecutionConstraints = (
  params: ExecutionConstraintParams
): ExecutionConstraintVerdict => {
  const { query, database, mode, pgSchema } = params;
  const dbPools = DatabasePools.getInstance();
  const cloudConfig = dbPools.getCloudConfig();

  const allDatabases = [
    ...cloudConfig.primaryDatabases.map(d => d.databaseName),
    ...Object.values(cloudConfig.secondaryDatabases).flat().map(d => d.databaseName),
  ];
  const allClouds = [cloudConfig.primaryCloud, ...cloudConfig.secondaryClouds];

  if (!allDatabases.includes(database)) {
    return { ok: false, status: 400, message: `Invalid database: ${database}` };
  }

  if (mode !== 'both' && !allClouds.includes(mode)) {
    return { ok: false, status: 400, message: `Invalid execution mode: ${mode}` };
  }

  // INSERT may only run against THIS database's own primary cloud — DB-level
  // replication carries the row to its secondaries.
  const dbPrimaryCloud = dbPools.getPrimaryCloudForDatabase(database);
  if (mode !== dbPrimaryCloud) {
    const statements = QueryValidator.splitStatements(query);
    const hasInsert = statements.some(s => /^\s*(?:WITH\b[\s\S]*?\)\s*)?INSERT\b/i.test(s));
    if (hasInsert) {
      return {
        ok: false,
        status: 400,
        message: `INSERT statements are only allowed on the primary cloud for '${database}' (${dbPrimaryCloud}). Please switch the execution mode to ${dbPrimaryCloud}.`,
      };
    }
  }

  // Hard-block CREATE INDEX on protected tables — no override, and deliberately
  // NOT unlockable via approval: no role can run these today, so letting an
  // approver do it would quietly remove the protection.
  //
  // A database can be configured on several clouds, and indexCreateBlockedTables
  // is a per-cloud-entry field, so UNION the blocked lists across every cloud
  // entry — a protection declared on any one of them still applies (fail safe).
  const allDbInfosForDb = [
    ...cloudConfig.primaryDatabases,
    ...Object.values(cloudConfig.secondaryDatabases).flat(),
  ].filter(d => d.databaseName === database);

  const dbPrimaryInfo =
    allDbInfosForDb.find(d => d.cloudType === dbPrimaryCloud) || allDbInfosForDb[0];
  const blockedTables = [
    ...new Set(allDbInfosForDb.flatMap(d => d.indexCreateBlockedTables ?? [])),
  ];

  if (blockedTables.length > 0) {
    const blockedMatches = QueryValidator.checkIndexCreateBlocked(
      query,
      blockedTables,
      pgSchema || dbPrimaryInfo?.defaultSchema
    );
    if (blockedMatches.length > 0) {
      return {
        ok: false,
        status: 403,
        message: `CREATE INDEX is blocked on the following protected table(s): ${blockedMatches.join(', ')}. These tables are critical for production — please contact your administrator to run this index query.`,
        blockedTables: blockedMatches,
      };
    }
  }

  return { ok: true };
};
