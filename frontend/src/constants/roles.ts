export const Role = {
  MASTER: 'MASTER',
  // ADMIN: everything MASTER can do (queries, Redis, ClickHouse, batch,
  // history visibility) PLUS user-access management (Users page / activate /
  // deactivate / change role). MASTER retains full execution powers but does
  // NOT manage users.
  ADMIN: 'ADMIN',
  USER: 'USER',
  READER: 'READER',
  CKH_MANAGER: 'CKH_MANAGER',
  RELEASE_MANAGER: 'RELEASE_MANAGER',
  // CACHE_CLEARER: READER's read-only access everywhere, PLUS cache
  // invalidation — Redis SCAN delete and Shudhi in-memory refresh. It stays
  // read-only for Postgres and for direct Redis write commands (including DEL).
  CACHE_CLEARER: 'CACHE_CLEARER',
  // REQUESTOR: no execution rights of its own, anywhere — not Postgres (not
  // even SELECT), not Redis, not Shudhi, not ClickHouse. It composes queries
  // and submits them for approval; whoever approves runs them under their own
  // role. Only two tabs: DB Manager (to compose) and Requests (to track).
  REQUESTOR: 'REQUESTOR',
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
  Role.REQUESTOR,
];

/**
 * Roles with full (MASTER-equivalent) execution powers.
 * User-access management is NOT covered by this — that stays MASTER-only.
 */
export const SUPER_ROLES: Role[] = [Role.MASTER, Role.ADMIN];

export const isSuperRole = (role?: string | null): boolean =>
  !!role && (SUPER_ROLES as string[]).includes(role);

/**
 * Mirrors backend/src/constants/roles.ts — keep the two in sync.
 * Read-only roles: no Redis write commands, SELECT-family SQL only.
 */
export const READ_ONLY_ROLES: Role[] = [Role.READER, Role.CACHE_CLEARER];

export const isReadOnlyRole = (role?: string | null): boolean =>
  !!role && (READ_ONLY_ROLES as string[]).includes(role);

/** Roles allowed to invalidate caches: Redis SCAN delete and Shudhi refresh. */
export const CACHE_CLEAR_ROLES: Role[] = [
  Role.MASTER,
  Role.ADMIN,
  Role.USER,
  Role.RELEASE_MANAGER,
  Role.CACHE_CLEARER,
];

export const canClearCache = (role?: string | null): boolean =>
  !!role && (CACHE_CLEAR_ROLES as string[]).includes(role);

/** REQUESTOR can run nothing directly — every query it writes is a request. */
export const isRequestOnlyRole = (role?: string | null): boolean =>
  role === Role.REQUESTOR;
