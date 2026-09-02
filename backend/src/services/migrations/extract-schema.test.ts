import { describe, it, expect } from 'vitest';
import { extractSchema } from './sql-parser.service';

describe('extractSchema', () => {
  it.each([
    ['ALTER TABLE atlas_app.booking ADD COLUMN c text', 'atlas_app'],
    ['ALTER TABLE ONLY atlas_app.booking DROP COLUMN c', 'atlas_app'],
    ['CREATE TABLE IF NOT EXISTS atlas_driver_offer_bpp.merchant (id text)', 'atlas_driver_offer_bpp'],
    ['DROP TABLE atlas_app.legacy', 'atlas_app'],
    ['CREATE TYPE atlas_app.status AS ENUM (\'a\')', 'atlas_app'],
    ['INSERT INTO atlas_app.translations (id) VALUES (\'x\')', 'atlas_app'],
    ['UPDATE atlas_driver_offer_bpp.merchant SET c = 1 WHERE id = \'x\'', 'atlas_driver_offer_bpp'],
    ['DELETE FROM atlas_app.booking WHERE id = \'x\'', 'atlas_app'],
  ])('reads the target schema of %s', (sql, expected) => {
    expect(extractSchema(sql)).toBe(expected);
  });

  // The fallback-branch cases classifyStatement reports as 'manual_check'.
  it('resolves a RENAME, which objectName cannot express', () => {
    expect(extractSchema('ALTER TABLE atlas_driver_offer_bpp.call_status RENAME COLUMN a TO b'))
      .toBe('atlas_driver_offer_bpp');
  });

  it('resolves a CREATE FUNCTION by its own name, ignoring its body', () => {
    const sql = `CREATE OR REPLACE FUNCTION atlas_app.touch() RETURNS trigger AS $$
      BEGIN UPDATE other_schema.audit SET n = n + 1; RETURN NEW; END
    $$ LANGUAGE plpgsql`;
    expect(extractSchema(sql)).toBe('atlas_app');
  });

  it('ignores a dollar-quoted body entirely when the function is unqualified', () => {
    const sql = `CREATE FUNCTION touch() RETURNS trigger AS $$
      BEGIN UPDATE other_schema.audit SET n = n + 1; RETURN NEW; END
    $$ LANGUAGE plpgsql`;
    expect(extractSchema(sql)).toBeNull();
  });

  // CREATE INDEX: the index name is unqualified, so the ON table must win.
  it('takes the ON table for CREATE INDEX, not the index name', () => {
    expect(extractSchema('CREATE INDEX idx_booking_id ON atlas_app.booking (id)')).toBe('atlas_app');
    expect(extractSchema('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx ON atlas_app.booking (id)'))
      .toBe('atlas_app');
  });

  it('takes the insert target, not a joined table', () => {
    expect(extractSchema('INSERT INTO a_schema.t SELECT * FROM b_schema.x')).toBe('a_schema');
  });

  it.each([
    'ALTER TABLE booking ADD COLUMN c text',
    'CREATE TABLE t (id text)',
    'SET search_path TO whatever',
    'SELECT 1',
  ])('returns null for the unqualified %s', (sql) => {
    expect(extractSchema(sql)).toBeNull();
  });

  it('is not fooled by a dot inside a string literal', () => {
    expect(extractSchema("UPDATE config SET note = 'v1.2.3' WHERE id = '1'")).toBeNull();
    expect(extractSchema("INSERT INTO atlas_app.t (v) VALUES ('a.b')")).toBe('atlas_app');
  });

  it.each([
    'ALTER TABLE t ALTER COLUMN c TYPE numeric(10, 2)',
    'ALTER TABLE t ALTER COLUMN c SET DEFAULT 0.5',
    'ALTER TABLE t ALTER COLUMN c TYPE text USING c::text',
  ])('does not treat numbers or casts as a qualifier: %s', (sql) => {
    expect(extractSchema(sql)).toBeNull();
  });

  it('handles quoted identifiers', () => {
    expect(extractSchema('ALTER TABLE "atlas app"."my table" ADD COLUMN c text')).toBe('atlas app');
    expect(extractSchema('ALTER TABLE atlas_app."my table" ADD COLUMN c text')).toBe('atlas_app');
  });

  it('ignores a leading comment', () => {
    expect(extractSchema('-- add a column to other.thing\nALTER TABLE atlas_app.booking ADD COLUMN c text'))
      .toBe('atlas_app');
  });
});
