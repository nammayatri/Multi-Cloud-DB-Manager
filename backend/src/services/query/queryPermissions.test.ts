import { describe, it, expect } from 'vitest';
import {
  checkRolePermission,
  canRunDirectly,
  canRequestApproval,
} from './queryPermissions';
import { Role } from '../../constants/roles';

/**
 * These rules gate every Postgres query in the product, and are now shared by
 * the execute middleware and the query-request approval path. A regression here
 * either locks people out or lets a role run something it shouldn't.
 */
describe('checkRolePermission', () => {
  describe('MASTER / ADMIN', () => {
    it('allows anything', () => {
      expect(checkRolePermission(Role.MASTER, 'DROP TABLE users').allowed).toBe(true);
      expect(checkRolePermission(Role.ADMIN, 'TRUNCATE orders').allowed).toBe(true);
    });
  });

  describe('READER', () => {
    it('allows read-only statements', () => {
      expect(checkRolePermission(Role.READER, 'SELECT * FROM rides').allowed).toBe(true);
      expect(checkRolePermission(Role.READER, 'WITH x AS (SELECT 1) SELECT * FROM x').allowed).toBe(true);
      expect(checkRolePermission(Role.READER, 'EXPLAIN SELECT 1').allowed).toBe(true);
    });

    it('denies writes', () => {
      expect(checkRolePermission(Role.READER, 'DELETE FROM rides').allowed).toBe(false);
      expect(checkRolePermission(Role.READER, 'INSERT INTO rides VALUES (1)').allowed).toBe(false);
    });

    // The allowlist-per-statement rule exists precisely because a denylist let
    // a disallowed statement hide behind a leading SELECT.
    it('denies a disallowed statement hiding behind a SELECT', () => {
      expect(checkRolePermission(Role.READER, 'SELECT 1; DROP INDEX idx_rides;').allowed).toBe(false);
      expect(checkRolePermission(Role.READER, "SELECT 1; COPY t TO PROGRAM 'sh';").allowed).toBe(false);
    });

    it('denies EXPLAIN ANALYZE of a write, which would execute it', () => {
      expect(checkRolePermission(Role.READER, 'EXPLAIN ANALYZE DELETE FROM rides').allowed).toBe(false);
    });
  });

  // CACHE_CLEARER's extra powers are Redis/Shudhi-side only — for Postgres it
  // must stay exactly as restricted as READER.
  describe('CACHE_CLEARER', () => {
    it('allows read-only statements', () => {
      expect(checkRolePermission(Role.CACHE_CLEARER, 'SELECT * FROM rides').allowed).toBe(true);
      expect(checkRolePermission(Role.CACHE_CLEARER, 'EXPLAIN SELECT 1').allowed).toBe(true);
    });

    it('denies writes, exactly like READER', () => {
      expect(checkRolePermission(Role.CACHE_CLEARER, 'DELETE FROM rides').allowed).toBe(false);
      expect(checkRolePermission(Role.CACHE_CLEARER, 'INSERT INTO rides VALUES (1)').allowed).toBe(false);
      expect(checkRolePermission(Role.CACHE_CLEARER, 'SELECT 1; DROP INDEX idx_rides;').allowed).toBe(false);
    });
  });

  describe('USER', () => {
    it('allows its documented operations', () => {
      expect(checkRolePermission(Role.USER, 'INSERT INTO rides VALUES (1)').allowed).toBe(true);
      expect(checkRolePermission(Role.USER, 'UPDATE rides SET x = 1').allowed).toBe(true);
      expect(checkRolePermission(Role.USER, 'CREATE TABLE t (id int)').allowed).toBe(true);
    });

    it('denies DELETE / DROP / TRUNCATE', () => {
      const verdict = checkRolePermission(Role.USER, 'DELETE FROM rides');
      expect(verdict.allowed).toBe(false);
      expect(verdict.message).toContain('DELETE');
      expect(checkRolePermission(Role.USER, 'DROP TABLE rides').allowed).toBe(false);
      expect(checkRolePermission(Role.USER, 'TRUNCATE rides').allowed).toBe(false);
    });

    it('denies a disallowed statement hiding behind an allowed one', () => {
      expect(checkRolePermission(Role.USER, 'SELECT 1; DELETE FROM rides;').allowed).toBe(false);
    });
  });

  describe('CKH_MANAGER', () => {
    it('has no Postgres access at all', () => {
      expect(checkRolePermission(Role.CKH_MANAGER, 'SELECT 1').allowed).toBe(false);
    });
  });

  describe('fail-closed', () => {
    it('denies unknown roles', () => {
      expect(checkRolePermission('SOMETHING_NEW', 'SELECT 1').allowed).toBe(false);
    });

    it('denies a missing role', () => {
      expect(checkRolePermission(undefined, 'SELECT 1').allowed).toBe(false);
    });
  });
});

describe('canRunDirectly', () => {
  // The case that motivates having this on top of checkRolePermission: a USER
  // passes the role allowlist for ALTER TABLE, but the password gate is
  // MASTER/ADMIN-only, so they genuinely cannot run it and must be allowed to
  // request approval.
  it('denies a USER an ALTER that passes the role allowlist but hits the password gate', () => {
    const query = 'ALTER TABLE rides DROP COLUMN legacy_id';

    expect(checkRolePermission(Role.USER, query).allowed).toBe(true);
    expect(canRunDirectly(Role.USER, query).allowed).toBe(false);
  });

  it('still lets MASTER/ADMIN through the password gate', () => {
    const query = 'ALTER TABLE rides DROP COLUMN legacy_id';

    expect(canRunDirectly(Role.MASTER, query).allowed).toBe(true);
    expect(canRunDirectly(Role.ADMIN, query).allowed).toBe(true);
  });

  it('agrees with the role check when no password gate applies', () => {
    expect(canRunDirectly(Role.READER, 'SELECT 1').allowed).toBe(true);
    expect(canRunDirectly(Role.READER, 'DELETE FROM rides').allowed).toBe(false);
  });
});

describe('canRequestApproval', () => {
  it('covers the roles with partial Postgres access', () => {
    expect(canRequestApproval(Role.USER)).toBe(true);
    expect(canRequestApproval(Role.READER)).toBe(true);
    expect(canRequestApproval(Role.RELEASE_MANAGER)).toBe(true);
    expect(canRequestApproval(Role.CACHE_CLEARER)).toBe(true);
  });

  it('excludes roles that can already run everything, or nothing', () => {
    // Nothing to grant them.
    expect(canRequestApproval(Role.MASTER)).toBe(false);
    expect(canRequestApproval(Role.ADMIN)).toBe(false);
    // No Postgres access at all, so approval would have nothing to unlock.
    expect(canRequestApproval(Role.CKH_MANAGER)).toBe(false);
    expect(canRequestApproval(undefined)).toBe(false);
  });
});
