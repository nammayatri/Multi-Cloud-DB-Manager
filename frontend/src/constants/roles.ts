export const Role = {
  MASTER: 'MASTER',
  // ADMIN: identical execution powers to MASTER (queries, Redis, ClickHouse,
  // batch, history visibility). The ONLY difference: user-access management
  // (Users page / activate / deactivate / change role) remains exclusively MASTER.
  ADMIN: 'ADMIN',
  USER: 'USER',
  READER: 'READER',
  CKH_MANAGER: 'CKH_MANAGER',
  RELEASE_MANAGER: 'RELEASE_MANAGER',
} as const;

export type Role = typeof Role[keyof typeof Role];

export const ALL_ROLES: Role[] = [
  Role.MASTER,
  Role.ADMIN,
  Role.USER,
  Role.READER,
  Role.CKH_MANAGER,
  Role.RELEASE_MANAGER,
];

/**
 * Roles with full (MASTER-equivalent) execution powers.
 * User-access management is NOT covered by this — that stays MASTER-only.
 */
export const SUPER_ROLES: Role[] = [Role.MASTER, Role.ADMIN];

export const isSuperRole = (role?: string | null): boolean =>
  !!role && (SUPER_ROLES as string[]).includes(role);
