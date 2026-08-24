export const Role = {
  MASTER: 'MASTER',
  // ADMIN: everything MASTER can do (queries, Redis, ClickHouse, batch,
  // history visibility) PLUS user-access management (activate/deactivate/
  // change role/delete). MASTER retains full execution powers but does NOT
  // manage users.
  ADMIN: 'ADMIN',
  USER: 'USER',
  READER: 'READER',
  CKH_MANAGER: 'CKH_MANAGER',
  RELEASE_MANAGER: 'RELEASE_MANAGER',
  // CACHE_CLEARER: READER's read-only access everywhere, PLUS cache
  // invalidation — Redis SCAN delete and Shudhi in-memory refresh. It stays
  // read-only for Postgres and for direct Redis write commands (including DEL):
  // key removal must go through the pattern-scoped, audited SCAN flow.
  CACHE_CLEARER: 'CACHE_CLEARER',
} as const;

export type Role = typeof Role[keyof typeof Role];

export const ALL_ROLES: Role[] = [
  Role.MASTER,
  Role.ADMIN,
  Role.USER,
  Role.READER,
  Role.CKH_MANAGER,
  Role.RELEASE_MANAGER,
  Role.CACHE_CLEARER,
];

/**
 * Roles with full (MASTER-equivalent) execution powers.
 * User-access management is NOT covered by this — that stays MASTER-only.
 */
export const SUPER_ROLES: Role[] = [Role.MASTER, Role.ADMIN];

export const isSuperRole = (role?: string | null): boolean =>
  !!role && (SUPER_ROLES as string[]).includes(role);

/**
 * Roles limited to read-only operations: SELECT-family SQL only, and no Redis
 * write commands. Cache invalidation is a separate capability — see
 * CACHE_CLEAR_ROLES — so CACHE_CLEARER appears in both lists.
 */
export const READ_ONLY_ROLES: Role[] = [Role.READER, Role.CACHE_CLEARER];

export const isReadOnlyRole = (role?: string | null): boolean =>
  !!role && (READ_ONLY_ROLES as string[]).includes(role);

/**
 * Roles allowed to invalidate caches: Redis SCAN delete and Shudhi refresh.
 * An allowlist rather than "everyone except READER" so an unhandled role fails
 * closed instead of inheriting deletion rights.
 */
export const CACHE_CLEAR_ROLES: Role[] = [
  Role.MASTER,
  Role.ADMIN,
  Role.USER,
  Role.RELEASE_MANAGER,
  Role.CACHE_CLEARER,
];

export const canClearCache = (role?: string | null): boolean =>
  !!role && (CACHE_CLEAR_ROLES as string[]).includes(role);
