import { describe, it, expect } from 'vitest';
import { classifyStatement } from './sql-parser.service';

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
