import { describe, it, expect } from 'vitest';
import { Role } from '../constants/roles';
import { detectDangerousQueries } from './queryValidation.service';

/*
 * This is the whole of the guard on both paths that run SQL.
 *
 * In the editor it decides whether Execute stops to confirm; on a query
 * request it decides whether the row carries a warning before anyone approves
 * it. Same function, same wording, deliberately — so the two read as one rule.
 */
describe('detectDangerousQueries', () => {
  it.each([
    ['DROP TABLE rides'],
    ['TRUNCATE rides'],
    ['DELETE FROM rides'],
    ['ALTER TABLE rides DROP COLUMN fare'],
    ['UPDATE rides SET fare = 0'],
    ['GRANT SELECT ON rides TO someone'],
    ['REVOKE SELECT ON rides FROM someone'],
  ])('warns about %s', (query) => {
    expect(detectDangerousQueries(query, Role.ADMIN)).not.toBeNull();
  });

  it.each([
    ['a plain select', 'SELECT * FROM rides WHERE id = 1'],
    ['an update with a WHERE', 'UPDATE rides SET x = 1 WHERE id = 2'],
    ['an insert', "INSERT INTO rides (id) VALUES ('1')"],
    ['an additive ALTER', 'ALTER TABLE rides ADD COLUMN note text'],
  ])('says nothing about %s', (_case, query) => {
    expect(detectDangerousQueries(query, Role.ADMIN)).toBeNull();
  });

  /*
   * `requiresPassword` has to match QueryValidator.requiresPasswordVerification
   * on the backend — see the note on the service. DROP needs one; an UPDATE
   * without WHERE is worth a warning but the backend asks for no password, and
   * offering a password field there would be refused.
   */
  it('marks which of them the backend will demand a password for', () => {
    expect(detectDangerousQueries('DROP TABLE rides', Role.ADMIN)?.requiresPassword).toBe(true);
    expect(detectDangerousQueries('UPDATE rides SET fare = 0', Role.ADMIN)?.requiresPassword).toBeFalsy();
    // DROP INDEX is the documented exception: confirmation, but no password.
    expect(detectDangerousQueries('DROP INDEX rides_idx', Role.ADMIN)?.requiresPassword).toBeFalsy();
  });

  it('carries wording a reader can act on', () => {
    const warning = detectDangerousQueries('UPDATE rides SET fare = 0', Role.ADMIN);
    expect(warning?.title).toBe('UPDATE Without WHERE Clause');
    expect(warning?.message).toMatch(/WHERE clause/i);
  });

  // Only super roles are ever prompted; the rest are refused before the
  // password check applies, and the message says so.
  it('tells a non-super role it will be refused outright', () => {
    expect(detectDangerousQueries('DROP TABLE rides', Role.READER)?.requiresPassword).toBeFalsy();
    expect(detectDangerousQueries('DROP TABLE rides', Role.READER)?.message).toMatch(/MASTER\/ADMIN/);
  });
});
