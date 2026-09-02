import { describe, it, expect } from 'vitest';
import { classifyStatement } from './sql-parser.service';
import QueryValidator from '../query/QueryValidator';

/**
 * Mirrors the DDL/NON_DDL mapping in lite-diff.service. Kept in sync by the
 * cases below — the runner's "Select All DDL" is only as trustworthy as this.
 */
function isUnclassifiedDdl(parsed: { type: string; sql: string }): boolean {
  if (parsed.type !== 'OTHER') return false;
  const clean = parsed.sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
  if (/^\s*DO\s+\$/i.test(clean)) return false;
  return /^\s*(ALTER|CREATE|DROP)\s+/i.test(clean);
}

const kindOf = (sql: string): 'DDL' | 'NON_DDL' => {
  const parsed = classifyStatement(sql, 'public');
  return parsed.type === 'DDL' || isUnclassifiedDdl(parsed) ? 'DDL' : 'NON_DDL';
};

describe('lite runner DDL tagging', () => {
  it.each([
    'ALTER TABLE atlas_app.booking ADD COLUMN payment_instrument text',
    'ALTER TABLE atlas_app.booking DROP COLUMN old_col',
    'ALTER TABLE atlas_app.booking ALTER COLUMN c TYPE text',
    'CREATE TABLE atlas_app.t (id text primary key)',
    'CREATE INDEX idx_a ON atlas_app.booking (id)',
    'CREATE TYPE atlas_app.status AS ENUM (\'a\')',
    'ALTER TYPE atlas_app.status ADD VALUE \'b\'',
  ])('tags recognized schema change as DDL: %s', (sql) => {
    expect(kindOf(sql)).toBe('DDL');
  });

  // These have no branch in the shared classifier and arrive as OTHER/UNKNOWN.
  it.each([
    'ALTER TABLE atlas_driver_offer_bpp.call_status RENAME COLUMN a TO b',
    'ALTER TABLE atlas_app.booking RENAME TO booking_v2',
    'DROP TABLE atlas_app.legacy',
    'CREATE OR REPLACE FUNCTION f() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql',
    'CREATE SCHEMA atlas_new',
  ])('recovers schema change the classifier does not model: %s', (sql) => {
    expect(kindOf(sql)).toBe('DDL');
  });

  it.each([
    'INSERT INTO atlas_app.translations (id) VALUES (\'x\')',
    'UPDATE atlas_driver_offer_bpp.merchant SET exo_phones = \'{}\'',
    'DELETE FROM atlas_app.booking WHERE id = \'x\'',
    'SELECT 1',
  ])('tags data change as NON_DDL: %s', (sql) => {
    expect(kindOf(sql)).toBe('NON_DDL');
  });

  // A DO block can perform DML inside; it must not be swept into a DDL-only run.
  it('leaves opaque DO blocks as NON_DDL', () => {
    expect(kindOf("DO $$ BEGIN UPDATE atlas_app.booking SET x = 1; END $$")).toBe('NON_DDL');
  });

  it('is not fooled by a leading comment', () => {
    expect(kindOf("-- add a column\nALTER TABLE atlas_app.booking RENAME COLUMN a TO b")).toBe('DDL');
  });
});

describe('lite runner dangerous tagging', () => {
  // The runner's `dangerous` flag is the execute endpoint's own rule, so a
  // statement flagged here is exactly one that will demand a password.
  const dangerous = (sql: string) => QueryValidator.requiresPasswordVerification(sql) !== null;

  it.each([
    'ALTER TABLE atlas_app.booking DROP COLUMN c',
    'ALTER TABLE atlas_app.booking RENAME COLUMN a TO b',
    'ALTER TABLE atlas_app.booking ALTER COLUMN c TYPE text',
    'ALTER TABLE atlas_app.booking ALTER COLUMN c SET NOT NULL',
    'DROP TABLE atlas_app.booking',
    'TRUNCATE atlas_app.booking',
  ])('flags %s as dangerous', (sql) => {
    expect(dangerous(sql)).toBe(true);
  });

  // DDL, but purely additive — must not be flagged, or every migration would
  // demand a password and the distinction would be worthless.
  it.each([
    'ALTER TABLE atlas_app.booking ADD COLUMN c text',
    'CREATE TABLE atlas_app.t (id text)',
    'CREATE INDEX idx ON atlas_app.booking (id)',
    "ALTER TYPE atlas_app.status ADD VALUE 'b'",
  ])('does not flag additive DDL: %s', (sql) => {
    expect(dangerous(sql)).toBe(false);
  });

  it('is independent of the DDL/NON-DDL axis', () => {
    // Dangerous but not DDL-classified by the parser, and DDL but not dangerous.
    expect(dangerous('DELETE FROM atlas_app.booking')).toBe(true);
    expect(kindOf('ALTER TABLE atlas_app.booking ADD COLUMN c text')).toBe('DDL');
    expect(dangerous('ALTER TABLE atlas_app.booking ADD COLUMN c text')).toBe(false);
  });
});
