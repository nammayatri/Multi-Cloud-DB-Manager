import { describe, it, expect } from 'vitest';
import { canonical, makeDiffId, normalizeNumeric, rowHash, valuesEqual } from './values';

describe('normalizeNumeric', () => {
  it('collapses insignificant trailing and leading zeros', () => {
    expect(normalizeNumeric('1.50')).toBe('1.5');
    expect(normalizeNumeric('1.500')).toBe('1.5');
    expect(normalizeNumeric('10.0')).toBe('10');
    expect(normalizeNumeric('007')).toBe('7');
    expect(normalizeNumeric('0.0')).toBe('0');
  });

  it('normalizes signs', () => {
    expect(normalizeNumeric('+5')).toBe('5');
    expect(normalizeNumeric('-0.0')).toBe('0');
    expect(normalizeNumeric('-1.20')).toBe('-1.2');
  });
});

describe('valuesEqual', () => {
  it('treats two nulls as equal', () => {
    expect(valuesEqual(null, null, 'text')).toBe(true);
    expect(valuesEqual(null, undefined, 'text')).toBe(true);
  });

  it('does not confuse null with empty string or zero', () => {
    expect(valuesEqual(null, '', 'text')).toBe(false);
    expect(valuesEqual(null, 0, 'int4')).toBe(false);
  });

  it('compares numerics returned as strings by pg', () => {
    expect(valuesEqual('1.50', 1.5, 'numeric')).toBe(true);
    expect(valuesEqual('10', 10, 'int8')).toBe(true);
    expect(valuesEqual('1.5', '1.6', 'numeric')).toBe(false);
  });

  it('is insensitive to jsonb key order but not to value changes', () => {
    expect(valuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 }, 'jsonb')).toBe(true);
    expect(valuesEqual({ a: 1 }, { a: 2 }, 'jsonb')).toBe(false);
  });

  it('handles nested jsonb key order', () => {
    expect(
      valuesEqual({ outer: { x: 1, y: 2 } }, { outer: { y: 2, x: 1 } }, 'jsonb')
    ).toBe(true);
  });

  it('parses jsonb delivered as a string', () => {
    expect(valuesEqual('{"a":1,"b":2}', { b: 2, a: 1 }, 'jsonb')).toBe(true);
  });

  it('treats array order as significant', () => {
    expect(valuesEqual([1, 2], [1, 2], '_int4')).toBe(true);
    expect(valuesEqual([1, 2], [2, 1], '_int4')).toBe(false);
  });

  it('compares Date against an equivalent Date', () => {
    expect(valuesEqual(new Date('2024-01-01T00:00:00Z'), new Date('2024-01-01T00:00:00Z'), 'timestamptz')).toBe(true);
    expect(valuesEqual(new Date('2024-01-01T00:00:00Z'), new Date('2024-01-02T00:00:00Z'), 'timestamptz')).toBe(false);
  });

  it('compares bytea buffers by content', () => {
    expect(valuesEqual(Buffer.from('ab'), Buffer.from('ab'), 'bytea')).toBe(true);
    expect(valuesEqual(Buffer.from('ab'), Buffer.from('ac'), 'bytea')).toBe(false);
  });

  it('is case-insensitive for uuids', () => {
    expect(valuesEqual('A1B2C3D4-0000-0000-0000-000000000000', 'a1b2c3d4-0000-0000-0000-000000000000', 'uuid')).toBe(true);
  });

  it('keeps distinct types from colliding through the type prefix', () => {
    expect(canonical(' NULL', 'text')).not.toBe(canonical(null, 'text'));
  });
});

describe('rowHash', () => {
  const udt = { a: 'int4', b: 'text' };

  it('is stable regardless of the column order passed in', () => {
    const row = { a: 1, b: 'x' };
    expect(rowHash(row, ['a', 'b'], udt)).toBe(rowHash(row, ['b', 'a'], udt));
  });

  it('changes when a value changes', () => {
    expect(rowHash({ a: 1, b: 'x' }, ['a', 'b'], udt)).not.toBe(
      rowHash({ a: 1, b: 'y' }, ['a', 'b'], udt)
    );
  });

  it('ignores columns outside the given list', () => {
    expect(rowHash({ a: 1, b: 'x', c: 'ignored' }, ['a', 'b'], udt)).toBe(
      rowHash({ a: 1, b: 'x', c: 'different' }, ['a', 'b'], udt)
    );
  });
});

describe('makeDiffId', () => {
  const udt = { id: 'uuid', city: 'int4' };
  const row = { id: 'aaaaaaaa-0000-0000-0000-000000000000', city: 5 };

  it('is stable across repeated analyses of identical data', () => {
    const first = makeDiffId('public', 't', 'INSERT', 'base', ['id'], row, udt);
    const second = makeDiffId('public', 't', 'INSERT', 'base', ['id'], { ...row }, udt);
    expect(first).toBe(second);
  });

  it('differs for the same row under a different operation', () => {
    expect(makeDiffId('public', 't', 'INSERT', 'base', ['id'], row, udt)).not.toBe(
      makeDiffId('public', 't', 'DELETE', 'target', ['id'], row, udt)
    );
  });

  it('differs when the identity value changes', () => {
    expect(makeDiffId('public', 't', 'INSERT', 'base', ['id'], row, udt)).not.toBe(
      makeDiffId('public', 't', 'INSERT', 'base', ['id'], { ...row, id: 'bbbbbbbb-0000-0000-0000-000000000000' }, udt)
    );
  });

  it('differs across tables', () => {
    expect(makeDiffId('public', 't', 'INSERT', 'base', ['id'], row, udt)).not.toBe(
      makeDiffId('public', 'other', 'INSERT', 'base', ['id'], row, udt)
    );
  });
});
