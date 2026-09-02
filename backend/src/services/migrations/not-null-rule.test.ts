import { describe, it, expect } from 'vitest';
import { tableRef, addsNotNullColumn } from './lite-diff.service';
import QueryValidator from '../query/QueryValidator';

describe('tableRef', () => {
  it.each([
    ['CREATE TABLE atlas_app.booking (id text)', 'CREATE', 'atlas_app.booking'],
    ['CREATE TABLE IF NOT EXISTS atlas_app.booking (id text)', 'CREATE', 'atlas_app.booking'],
    ['CREATE TABLE booking (id text)', 'CREATE', 'booking'],
    ['ALTER TABLE atlas_app.booking ADD COLUMN c text', 'ALTER', 'atlas_app.booking'],
    ['ALTER TABLE ONLY atlas_app.booking ADD COLUMN c text', 'ALTER', 'atlas_app.booking'],
    ['ALTER TABLE IF EXISTS atlas_app.booking ADD COLUMN c text', 'ALTER', 'atlas_app.booking'],
    ['ALTER TABLE "atlas app"."my table" ADD COLUMN c text', 'ALTER', 'atlas app.my table'],
  ])('reads %s', (sql, verb, expected) => {
    expect(tableRef(sql, verb as 'CREATE' | 'ALTER')).toBe(expected);
  });

  it('normalises case so CREATE and ALTER match across the diff', () => {
    expect(tableRef('CREATE TABLE Atlas_App.Booking (id text)', 'CREATE'))
      .toBe(tableRef('ALTER TABLE atlas_app.booking ADD COLUMN c text', 'ALTER'));
  });

  it('does not cross-match the wrong verb', () => {
    expect(tableRef('CREATE TABLE atlas_app.booking (id text)', 'ALTER')).toBeNull();
    expect(tableRef('ALTER TABLE atlas_app.booking ADD COLUMN c text', 'CREATE')).toBeNull();
  });

  it('ignores CREATE INDEX, which is not a table', () => {
    expect(tableRef('CREATE INDEX idx ON atlas_app.booking (id)', 'CREATE')).toBeNull();
  });
});

describe('addsNotNullColumn', () => {
  it.each([
    'ALTER TABLE atlas_app.booking ADD COLUMN c text NOT NULL',
    'ALTER TABLE atlas_app.booking ADD c text NOT NULL',
    'ALTER TABLE atlas_app.booking ADD COLUMN IF NOT EXISTS c text NOT NULL',
    "ALTER TABLE atlas_app.booking ADD COLUMN c text NOT NULL DEFAULT 'x'",
  ])('detects %s', (sql) => {
    expect(addsNotNullColumn(sql)).toBe(true);
  });

  it.each([
    'ALTER TABLE atlas_app.booking ADD COLUMN c text',
    'ALTER TABLE atlas_app.booking DROP COLUMN c',
    'ALTER TABLE atlas_app.booking ALTER COLUMN c SET NOT NULL',
    'CREATE TABLE atlas_app.t (id text NOT NULL)',
    "INSERT INTO atlas_app.t (c) VALUES ('NOT NULL')",
  ])('does not misfire on %s', (sql) => {
    expect(addsNotNullColumn(sql)).toBe(false);
  });
});

describe('CREATE INDEX target extraction (reused from QueryValidator)', () => {
  const targets = (sql: string) => QueryValidator.extractCreateIndexTables(sql);

  it.each([
    ['CREATE INDEX idx ON atlas_app.booking (id)', 'atlas_app.booking'],
    ['CREATE UNIQUE INDEX idx ON atlas_app.booking (id)', 'atlas_app.booking'],
    ['CREATE INDEX CONCURRENTLY idx ON atlas_app.booking (id)', 'atlas_app.booking'],
    ['CREATE INDEX IF NOT EXISTS idx ON ONLY atlas_app.booking (id)', 'atlas_app.booking'],
  ])('resolves the ON table of %s', (sql, expected) => {
    expect(targets(sql)).toEqual([expected]);
  });

  it('lowercases, so it matches tableRef output across the diff', () => {
    expect(targets('CREATE INDEX idx ON Atlas_App.Booking (id)'))
      .toEqual([tableRef('CREATE TABLE atlas_app.booking (id text)', 'CREATE')]);
  });

  it('returns nothing for statements that are not CREATE INDEX', () => {
    expect(targets('ALTER TABLE atlas_app.booking ADD COLUMN c text')).toEqual([]);
    expect(targets('CREATE TABLE atlas_app.booking (id text)')).toEqual([]);
    expect(targets('DROP INDEX atlas_app.idx')).toEqual([]);
  });
});
