import { describe, it, expect } from 'vitest';
import { idMapKey, isPendingRef, pendingRef, projectRow, resolvePending } from './projection';

const udtMap = { parent_id: 'uuid', note: 'text' };
const fkRemap = { parent_id: 'app.parent' };

const OLD_PARENT = '11111111-1111-1111-1111-111111111111';
const NEW_PARENT = '22222222-2222-2222-2222-222222222222';

describe('projectRow', () => {
  it('rewrites a configured foreign key to its new-dimension counterpart', () => {
    const idMap = new Map<string, unknown>([
      [idMapKey('app.parent', OLD_PARENT, 'uuid'), NEW_PARENT],
    ]);

    const { row, dangling } = projectRow(
      { parent_id: OLD_PARENT, note: 'n' },
      fkRemap,
      idMap,
      udtMap
    );

    expect(row.parent_id).toBe(NEW_PARENT);
    expect(dangling).toEqual([]);
  });

  it('matches the parent regardless of uuid casing', () => {
    const idMap = new Map<string, unknown>([
      [idMapKey('app.parent', OLD_PARENT, 'uuid'), NEW_PARENT],
    ]);

    const { row } = projectRow(
      { parent_id: OLD_PARENT.toUpperCase(), note: 'n' },
      fkRemap,
      idMap,
      udtMap
    );

    expect(row.parent_id).toBe(NEW_PARENT);
  });

  it('reports a reference whose parent is absent as dangling and leaves it untouched', () => {
    const { row, dangling } = projectRow(
      { parent_id: OLD_PARENT, note: 'n' },
      fkRemap,
      new Map(),
      udtMap
    );

    expect(row.parent_id).toBe(OLD_PARENT);
    expect(dangling).toEqual(['parent_id']);
  });

  it('leaves a null reference alone', () => {
    const { row, dangling } = projectRow({ parent_id: null }, fkRemap, new Map(), udtMap);
    expect(row.parent_id).toBeNull();
    expect(dangling).toEqual([]);
  });

  it('returns the original row object when nothing is configured', () => {
    const original = { parent_id: OLD_PARENT };
    const { row } = projectRow(original, {}, new Map(), udtMap);
    expect(row).toBe(original);
  });

  it('does not mutate the row it was given', () => {
    const idMap = new Map<string, unknown>([
      [idMapKey('app.parent', OLD_PARENT, 'uuid'), NEW_PARENT],
    ]);
    const original = { parent_id: OLD_PARENT, note: 'n' };
    projectRow(original, fkRemap, idMap, udtMap);
    expect(original.parent_id).toBe(OLD_PARENT);
  });

  it('carries a placeholder when the parent is itself pending insertion', () => {
    const placeholder = pendingRef('app.parent', OLD_PARENT, 'uuid');
    const idMap = new Map<string, unknown>([
      [idMapKey('app.parent', OLD_PARENT, 'uuid'), placeholder],
    ]);

    const { row } = projectRow({ parent_id: OLD_PARENT }, fkRemap, idMap, udtMap);

    expect(isPendingRef(row.parent_id)).toBe(true);
  });

  it('never matches a real value with a placeholder', () => {
    expect(isPendingRef(OLD_PARENT)).toBe(false);
    expect(isPendingRef(null)).toBe(false);
    expect(isPendingRef(42)).toBe(false);
  });
});

describe('resolvePending', () => {
  it('substitutes a minted id for a placeholder', () => {
    const placeholder = pendingRef('app.parent', OLD_PARENT, 'uuid');
    const minted = new Map<string, unknown>([[placeholder, NEW_PARENT]]);
    expect(resolvePending(placeholder, minted)).toBe(NEW_PARENT);
  });

  it('passes ordinary values straight through', () => {
    expect(resolvePending(OLD_PARENT, new Map())).toBe(OLD_PARENT);
    expect(resolvePending(null, new Map())).toBeNull();
  });

  it('refuses to apply a child whose parent was not selected', () => {
    const placeholder = pendingRef('app.parent', OLD_PARENT, 'uuid');
    expect(() => resolvePending(placeholder, new Map())).toThrow(/references a parent/);
  });
});
