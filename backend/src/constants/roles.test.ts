import { describe, it, expect } from 'vitest';
import { Role, ALL_ROLES, isSuperRole, isReadOnlyRole, canClearCache } from './roles';

/**
 * These predicates are what the Redis, Shudhi and Postgres gates all branch on,
 * so a wrong membership here silently widens or removes access across the app.
 */
describe('role predicates', () => {
  it('lists every declared role in ALL_ROLES', () => {
    // ALL_ROLES gates user creation and role changes (auth.controller) — a role
    // missing from it cannot be assigned to anyone.
    expect([...ALL_ROLES].sort()).toEqual(Object.values(Role).sort());
  });

  describe('isReadOnlyRole', () => {
    it('covers READER and CACHE_CLEARER', () => {
      expect(isReadOnlyRole(Role.READER)).toBe(true);
      expect(isReadOnlyRole(Role.CACHE_CLEARER)).toBe(true);
    });

    it('excludes the writing roles', () => {
      expect(isReadOnlyRole(Role.MASTER)).toBe(false);
      expect(isReadOnlyRole(Role.ADMIN)).toBe(false);
      expect(isReadOnlyRole(Role.USER)).toBe(false);
      expect(isReadOnlyRole(Role.RELEASE_MANAGER)).toBe(false);
    });

    it('fails closed on unknown / missing roles', () => {
      expect(isReadOnlyRole('SOMETHING_NEW')).toBe(false);
      expect(isReadOnlyRole(undefined)).toBe(false);
    });
  });

  describe('canClearCache', () => {
    it('includes CACHE_CLEARER — the whole point of the role', () => {
      expect(canClearCache(Role.CACHE_CLEARER)).toBe(true);
    });

    it('keeps the existing cache-clearing roles', () => {
      expect(canClearCache(Role.MASTER)).toBe(true);
      expect(canClearCache(Role.ADMIN)).toBe(true);
      expect(canClearCache(Role.USER)).toBe(true);
      expect(canClearCache(Role.RELEASE_MANAGER)).toBe(true);
    });

    it('excludes READER and CKH_MANAGER', () => {
      expect(canClearCache(Role.READER)).toBe(false);
      expect(canClearCache(Role.CKH_MANAGER)).toBe(false);
    });

    it('fails closed on unknown / missing roles', () => {
      expect(canClearCache('SOMETHING_NEW')).toBe(false);
      expect(canClearCache(undefined)).toBe(false);
    });
  });

  it('keeps CACHE_CLEARER out of the super roles', () => {
    expect(isSuperRole(Role.CACHE_CLEARER)).toBe(false);
  });
});
