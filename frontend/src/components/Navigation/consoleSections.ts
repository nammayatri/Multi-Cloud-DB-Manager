import { Role } from '../../constants/roles';
import type { ManagerMode } from '../../store/appStore';

// Batch Query (CSV) — destructive arbitrary parametrized SQL that only writers
// may run. Mirrors the backend gate (`requireBatchWriter` = MASTER/ADMIN/USER):
// read-only roles (READER, CACHE_CLEARER) are excluded so they aren't shown a
// tab the endpoint would 403. RELEASE_MANAGER is withheld too (schema-change
// scope, not data manipulation).
export const BATCH_ROLES: Role[] = [Role.MASTER, Role.ADMIN, Role.USER];

// Redis Manager — RELEASE_MANAGER joins the standard tier (USER-equivalent
// read + write + SCAN preview/delete; RAW stays MASTER-only at the route gate).
// CACHE_CLEARER gets the tab for read commands + SCAN delete.
export const REDIS_ROLES: Role[] = [Role.MASTER, Role.ADMIN, Role.USER, Role.READER, Role.RELEASE_MANAGER, Role.CACHE_CLEARER];

// Migrations — schema work, fits RELEASE_MANAGER.
export const MIGRATIONS_ROLES: Role[] = [Role.MASTER, Role.ADMIN, Role.USER, Role.READER, Role.RELEASE_MANAGER, Role.CACHE_CLEARER];

// DB Manager — the Migrations tier plus REQUESTOR, which gets the tab purely as
// a composing surface: it can browse the schema and write SQL, but Execute is
// replaced by "Request approval" (see DatabaseSelector) because its role
// permits no statement at all.
export const DB_ROLES: Role[] = [...MIGRATIONS_ROLES, Role.REQUESTOR];

// Shudhi (In-Memory Cache Management) — same as Redis: all standard roles.
export const SHUDHI_ROLES: Role[] = [Role.MASTER, Role.ADMIN, Role.USER, Role.READER, Role.RELEASE_MANAGER, Role.CACHE_CLEARER];

// Clickhouse Manager — mirrors `requireChWriter` on the clickhouse routes.
export const CLICKHOUSE_ROLES: Role[] = [Role.MASTER, Role.ADMIN, Role.CKH_MANAGER];

// System Configs (feature-flag rows like lean_flow) — reads open to the
// standard Postgres-access tier; the backend gates the actual save to
// MASTER/ADMIN only (see systemConfigs.routes.ts), the panel just hides the
// Save button for everyone else.
export const SYSTEM_CONFIGS_ROLES: Role[] = [Role.MASTER, Role.ADMIN, Role.USER, Role.READER, Role.RELEASE_MANAGER];

// Config Replicate ends in an unrestricted multi-table write across a whole
// group of config tables, so it stays at the MASTER/ADMIN tier — same gate the
// routes enforce server-side.
export const CONFIG_REPLICATE_ROLES: Role[] = [Role.MASTER, Role.ADMIN];

// Query Requests — every role with Postgres access: the lower tiers raise
// requests, the higher tiers approve them, and most roles do both depending on
// the query. REQUESTOR only ever raises. CKH_MANAGER has no Postgres access,
// so it has nothing to do here.
export const REQUEST_ROLES: Role[] = [Role.MASTER, Role.ADMIN, Role.USER, Role.READER, Role.RELEASE_MANAGER, Role.CACHE_CLEARER, Role.REQUESTOR];

// User management — ADMIN only, same as `requireAdmin` on the auth routes.
export const USERS_ROLES: Role[] = [Role.ADMIN];

// History — whoever can see DB Manager (query history) or Redis Manager (Redis
// history): exactly the roles that had the old History side-panel toggle. The
// page shows each panel only to its own tier.
export const HISTORY_ROLES: Role[] = [...new Set([...DB_ROLES, ...REDIS_ROLES])];

export interface ConsoleTab {
  mode: ManagerMode;
  label: string;
  visibleTo: Role[];
}

export const TAB_CONFIG: ConsoleTab[] = [
  { mode: 'db', label: 'DB Manager', visibleTo: DB_ROLES },
  { mode: 'batch', label: 'Batch Query', visibleTo: BATCH_ROLES },
  { mode: 'migrations', label: 'Migrations', visibleTo: MIGRATIONS_ROLES },
  { mode: 'redis', label: 'Redis Manager', visibleTo: REDIS_ROLES },
  { mode: 'shudhi', label: 'Shudhi', visibleTo: SHUDHI_ROLES },
  { mode: 'clickhouse', label: 'Clickhouse Manager', visibleTo: CLICKHOUSE_ROLES },
  { mode: 'systemConfigs', label: 'System Configs', visibleTo: SYSTEM_CONFIGS_ROLES },
  { mode: 'configreplicate', label: 'Config Replicate', visibleTo: CONFIG_REPLICATE_ROLES },
  { mode: 'requests', label: 'Requests', visibleTo: REQUEST_ROLES },
  { mode: 'users', label: 'Users', visibleTo: USERS_ROLES },
  { mode: 'history', label: 'History', visibleTo: HISTORY_ROLES },
];

export type SectionId = 'database' | 'cache' | 'clickhouse' | 'configs' | 'requests' | 'admin';

export interface ConsoleSection {
  id: SectionId;
  label: string;
  /** Pages in display order. */
  modes: ManagerMode[];
}

export const SECTIONS: ConsoleSection[] = [
  { id: 'database', label: 'Database', modes: ['db', 'batch', 'migrations'] },
  { id: 'cache', label: 'Cache', modes: ['redis', 'shudhi'] },
  { id: 'clickhouse', label: 'Clickhouse', modes: ['clickhouse'] },
  { id: 'configs', label: 'Configs', modes: ['systemConfigs', 'configreplicate'] },
  { id: 'requests', label: 'Requests', modes: ['requests'] },
  { id: 'admin', label: 'Admin', modes: ['users', 'history'] },
];

export const canSeeMode = (role: Role | undefined, mode: ManagerMode): boolean =>
  !!role && (TAB_CONFIG.find((t) => t.mode === mode)?.visibleTo.includes(role) ?? false);

/** Pages this role may open, in header order (section by section). */
export const tabsForRole = (role: Role | undefined): ConsoleTab[] =>
  SECTIONS.flatMap((s) => s.modes)
    .map((mode) => TAB_CONFIG.find((t) => t.mode === mode)!)
    .filter((t) => canSeeMode(role, t.mode));

export interface VisibleSection extends ConsoleSection {
  tabs: ConsoleTab[];
}

/** Sections with at least one page this role may open, each with only those pages. */
export const sectionsForRole = (role: Role | undefined): VisibleSection[] =>
  SECTIONS.map((s) => ({
    ...s,
    tabs: s.modes.filter((m) => canSeeMode(role, m)).map((m) => TAB_CONFIG.find((t) => t.mode === m)!),
  })).filter((s) => s.tabs.length > 0);

export const sectionOf = (mode: ManagerMode): SectionId =>
  (SECTIONS.find((s) => s.modes.includes(mode)) ?? SECTIONS[0]).id;
