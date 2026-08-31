import { describe, it, expect } from 'vitest';
import QueryValidator from './QueryValidator';

const needs = (sql: string) => QueryValidator.requiresPasswordVerification(sql) !== null;

describe('requiresPasswordVerification', () => {
  it.each([
    'DROP TABLE atlas_app.booking',
    'TRUNCATE atlas_app.booking',
    'DELETE FROM atlas_app.booking',
    'ALTER TABLE atlas_app.booking DROP COLUMN c',
    'GRANT SELECT ON atlas_app.booking TO reader',
    'REVOKE SELECT ON atlas_app.booking FROM reader',
  ])('requires a password for %s', (sql) => {
    expect(needs(sql)).toBe(true);
  });

  // Renames break every reader of the old name.
  it.each([
    'ALTER TABLE atlas_app.booking RENAME COLUMN a TO b',
    'ALTER TABLE atlas_app.booking RENAME TO booking_v2',
    'ALTER TABLE atlas_app.booking RENAME CONSTRAINT c1 TO c2',
  ])('requires a password for a rename: %s', (sql) => {
    expect(needs(sql)).toBe(true);
  });

  // Type changes rewrite existing data and can break readers.
  it.each([
    'ALTER TABLE atlas_app.booking ALTER COLUMN c TYPE text',
    'ALTER TABLE atlas_app.booking ALTER c TYPE text',
    'ALTER TABLE atlas_app.booking ALTER COLUMN c SET DATA TYPE integer',
    'ALTER TABLE atlas_app.booking ALTER c SET DATA TYPE integer USING c::integer',
  ])('requires a password for a column type change: %s', (sql) => {
    expect(needs(sql)).toBe(true);
  });

  it.each([
    'ALTER TABLE atlas_app.booking ADD COLUMN c text',
    'ALTER TABLE atlas_app.booking ADD CONSTRAINT pk PRIMARY KEY (id)',
    'ALTER TABLE atlas_app.booking ALTER COLUMN c SET NOT NULL',
    'CREATE TABLE atlas_app.t (id text)',
    'CREATE INDEX idx ON atlas_app.booking (id)',
    'DROP INDEX atlas_app.idx',
    'INSERT INTO atlas_app.booking (id) VALUES (\'x\')',
    'UPDATE atlas_app.booking SET c = 1 WHERE id = \'x\'',
    'DELETE FROM atlas_app.booking WHERE id = \'x\'',
    'SELECT 1',
  ])('does not require a password for %s', (sql) => {
    expect(needs(sql)).toBe(false);
  });

  // Additive enum change — must not be swept in by the TYPE rule.
  it('does not require a password for ALTER TYPE ... ADD VALUE', () => {
    expect(needs("ALTER TYPE atlas_app.status ADD VALUE 'b'")).toBe(false);
  });

  it('catches a dangerous statement hiding behind a safe one', () => {
    expect(needs("SELECT 1; ALTER TABLE atlas_app.booking RENAME COLUMN a TO b")).toBe(true);
  });
});
