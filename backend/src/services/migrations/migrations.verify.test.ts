import { describe, it, expect } from 'vitest';
import { normalizePgType } from './verification.service';
import { canonicalizeStatement, addedStatements } from './migrations.service';

describe('normalizePgType — type-change verification (Fix #2)', () => {
  const same = (a: string, b: string) => normalizePgType(a) === normalizePgType(b);

  it('treats numeric(p,s) as a match regardless of spacing (the bug that made every numeric change pending)', () => {
    expect(same('numeric(30,15)', 'numeric(30,15)')).toBe(true);
    expect(same('numeric(30, 15)', 'numeric(30,15)')).toBe(true);
    expect(same('numeric ( 30 , 2 )', 'numeric(30,2)')).toBe(true);
  });

  it('matches array types across spacing / udt spellings', () => {
    expect(same('text[]', 'text []')).toBe(true);
    expect(same('text[]', 'text[]')).toBe(true);
  });

  it('matches PostgreSQL type aliases', () => {
    expect(same('character varying(36)', 'varchar(36)')).toBe(true);
    expect(same('integer', 'int')).toBe(true);
    expect(same('integer', 'int4')).toBe(true);
    expect(same('bigint', 'int8')).toBe(true);
    expect(same('double precision', 'float8')).toBe(true);
    expect(same('boolean', 'bool')).toBe(true);
    expect(same('timestamp with time zone', 'timestamptz')).toBe(true);
  });

  it('does NOT match genuine differences (no false "applied")', () => {
    expect(same('double precision', 'numeric(30,15)')).toBe(false); // the real prod case
    expect(same('numeric(30,2)', 'numeric(30,15)')).toBe(false);    // scale differs
    expect(same('character varying(255)', 'character varying(100)')).toBe(false); // length differs
    expect(same('integer', 'bigint')).toBe(false);
    expect(same('text', 'text[]')).toBe(false);
  });
});

describe('canonicalizeStatement — statement identity (Fix #1 helper)', () => {
  it('ignores whitespace, trailing semicolons, comments, and case', () => {
    expect(canonicalizeStatement('ALTER TABLE  a.b  ADD COLUMN c text ;'))
      .toBe(canonicalizeStatement('alter table a.b add column c text'));
    expect(canonicalizeStatement('SELECT 1; -- a comment'))
      .toBe(canonicalizeStatement('select 1'));
  });
});

describe('addedStatements — diff scoping (Fix #1)', () => {
  it('returns only statements present at toRef but not at the base', () => {
    const toStmts = ['CREATE TABLE t (id int);', 'ALTER TABLE t ADD COLUMN a text;', 'ALTER TABLE t ADD COLUMN b text;'];
    const base = 'CREATE TABLE t (id int);\nALTER TABLE t ADD COLUMN a text;';
    expect(addedStatements(toStmts, base)).toEqual(['ALTER TABLE t ADD COLUMN b text;']);
  });

  it('ignores pure REORDERING (a moved statement is not "added") — the airport_block_expiry_time case', () => {
    const toStmts = ['ALTER TABLE t ADD COLUMN moved text;', 'ALTER TABLE t ADD COLUMN new text;'];
    const base = 'ALTER TABLE t ADD COLUMN old text;\nALTER TABLE t ADD COLUMN moved text;';
    // "moved" exists in both (just relocated) → not added; only "new" is added.
    expect(addedStatements(toStmts, base)).toEqual(['ALTER TABLE t ADD COLUMN new text;']);
  });

  it('treats an empty base (newly added file) as: every statement is added', () => {
    const toStmts = ['CREATE TABLE t (id int);', 'ALTER TABLE t ADD COLUMN a text;'];
    expect(addedStatements(toStmts, '')).toEqual(toStmts);
  });

  it('is insensitive to cosmetic reformatting between refs', () => {
    const toStmts = ['ALTER TABLE t ADD COLUMN a text;'];
    const base = 'alter table   t   add column a text ;'; // same statement, reformatted
    expect(addedStatements(toStmts, base)).toEqual([]);
  });
});
