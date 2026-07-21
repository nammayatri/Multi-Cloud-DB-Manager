import { Role } from './roles';

/**
 * Functionalities advertised to the loc auth service on GET /functionality/list.
 *
 * loc admins compose per-service roles out of these names; the loc gateway
 * (or a role lookup against loc's S2S API) then tells us which functionalities
 * the requesting user holds. Each functionality maps 1:1 to one of this app's
 * access tiers so the existing role-based validators keep working unchanged.
 */
export const Functionality = {
  MASTER: 'db:master',
  ADMIN: 'db:admin',
  WRITE: 'db:write',
  READ: 'db:read',
  CLICKHOUSE_MANAGE: 'clickhouse:manage',
  RELEASE_MANAGE: 'release:manage',
} as const;

export type Functionality = typeof Functionality[keyof typeof Functionality];

/** What we advertise on /functionality/list. */
export const ALL_FUNCTIONALITIES: Functionality[] = [
  Functionality.MASTER,
  Functionality.ADMIN,
  Functionality.WRITE,
  Functionality.READ,
  Functionality.CLICKHOUSE_MANAGE,
  Functionality.RELEASE_MANAGE,
];

/** Role → the functionality that grants that role's access tier. */
export const ROLE_FUNCTIONALITY: Record<Role, Functionality> = {
  [Role.MASTER]: Functionality.MASTER,
  [Role.ADMIN]: Functionality.ADMIN,
  [Role.USER]: Functionality.WRITE,
  [Role.READER]: Functionality.READ,
  [Role.CKH_MANAGER]: Functionality.CLICKHOUSE_MANAGE,
  [Role.RELEASE_MANAGER]: Functionality.RELEASE_MANAGE,
};

/**
 * Precedence used to derive a single effective role from a functionality list
 * (the SQL/Redis validators switch on one role). A loc role may carry several
 * functionalities — e.g. db:write + clickhouse:manage — in which case route
 * gates (requireRoles) check the full functionality list, while per-statement
 * validators run at the highest tier present.
 */
const EFFECTIVE_ROLE_PRECEDENCE: Role[] = [
  Role.MASTER,
  Role.ADMIN,
  Role.USER,
  Role.RELEASE_MANAGER,
  Role.CKH_MANAGER,
  Role.READER,
];

export const effectiveRoleFromFunctionalities = (
  functionalities: string[]
): Role | undefined =>
  EFFECTIVE_ROLE_PRECEDENCE.find(role =>
    functionalities.includes(ROLE_FUNCTIONALITY[role])
  );
