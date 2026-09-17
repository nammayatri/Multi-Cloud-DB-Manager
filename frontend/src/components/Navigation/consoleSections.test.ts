import { describe, it, expect } from 'vitest';
import { ALL_ROLES, Role } from '../../constants/roles';
import { SECTIONS, TAB_CONFIG, canSeeMode, sectionOf, sectionsForRole, tabsForRole } from './consoleSections';

/** section id → visible page modes, for a compact per-role comparison. */
const layoutFor = (role: Role) =>
  Object.fromEntries(sectionsForRole(role).map((s) => [s.id, s.tabs.map((t) => t.mode)]));

describe('consoleSections', () => {
  it('puts every page in exactly one section', () => {
    const grouped = SECTIONS.flatMap((s) => s.modes);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(TAB_CONFIG.map((t) => t.mode).sort());
  });

  it('maps each page back to its section', () => {
    expect(sectionOf('batch')).toBe('database');
    expect(sectionOf('shudhi')).toBe('cache');
    expect(sectionOf('configreplicate')).toBe('configs');
    expect(sectionOf('history')).toBe('admin');
  });

  // Visibility of the pre-existing pages must match the flat tab bar this
  // replaced; users/history are the pages that moved out of header buttons.
  it.each<[Role, Record<string, string[]>]>([
    [Role.MASTER, {
      database: ['db', 'batch', 'migrations'], cache: ['redis', 'shudhi'], clickhouse: ['clickhouse'],
      configs: ['systemConfigs', 'configreplicate'], requests: ['requests'], admin: ['history'],
    }],
    [Role.ADMIN, {
      database: ['db', 'batch', 'migrations'], cache: ['redis', 'shudhi'], clickhouse: ['clickhouse'],
      configs: ['systemConfigs', 'configreplicate'], requests: ['requests'], admin: ['users', 'history'],
    }],
    [Role.USER, {
      database: ['db', 'batch', 'migrations'], cache: ['redis', 'shudhi'],
      configs: ['systemConfigs'], requests: ['requests'], admin: ['history'],
    }],
    [Role.READER, {
      database: ['db', 'migrations'], cache: ['redis', 'shudhi'],
      configs: ['systemConfigs'], requests: ['requests'], admin: ['history'],
    }],
    [Role.RELEASE_MANAGER, {
      database: ['db', 'migrations'], cache: ['redis', 'shudhi'],
      configs: ['systemConfigs'], requests: ['requests'], admin: ['history'],
    }],
    [Role.CACHE_CLEARER, {
      database: ['db', 'migrations'], cache: ['redis', 'shudhi'], requests: ['requests'], admin: ['history'],
    }],
    [Role.CKH_MANAGER, { clickhouse: ['clickhouse'] }],
    [Role.REQUESTOR, { database: ['db'], requests: ['requests'], admin: ['history'] }],
  ])('%s sees the expected sections and pages', (role, expected) => {
    expect(layoutFor(role)).toEqual(expected);
  });

  it('covers every role in the table above', () => {
    expect(ALL_ROLES).toHaveLength(8);
  });

  it('drops sections with no visible page and shows nothing without a role', () => {
    expect(sectionsForRole(Role.CKH_MANAGER).map((s) => s.id)).toEqual(['clickhouse']);
    expect(sectionsForRole(undefined)).toEqual([]);
    expect(tabsForRole(undefined)).toEqual([]);
    expect(canSeeMode(Role.MASTER, 'users')).toBe(false);
  });

  it('lists tabs in header order, so the default page is the first one shown', () => {
    expect(tabsForRole(Role.CKH_MANAGER)[0].mode).toBe('clickhouse');
    expect(tabsForRole(Role.READER)[0].mode).toBe('db');
  });
});
