import { describe, it, expect } from 'vitest';
import { FkLink } from '../../types/configReplicate';
import { idMapKey, isPendingRef, pendingRef, projectRow, resolvePending } from './projection';

const udtMap = { parent_id: 'uuid', tenant: 'text', note: 'text' };

const link: FkLink = {
  columns: ['parent_id'],
  parentSchema: 'app',
  parentTable: 'parent',
  parentColumns: ['id'],
  source: 'MANUAL',
};

const compositeLink: FkLink = {
  columns: ['tenant', 'parent_id'],
  parentSchema: 'app',
  parentTable: 'parent',
  parentColumns: ['tenant', 'id'],
  source: 'DB_FK',
};

const OLD_PARENT = '11111111-1111-1111-1111-111111111111';
const NEW_PARENT = '22222222-2222-2222-2222-222222222222';

const keyOf = (columns: string[], values: unknown[], udts: string[]) =>
  idMapKey('app.parent', columns, values, udts);

describe('projectRow', () => {
  it('rewrites a configured foreign key to its new-dimension counterpart', () => {
    const idMap = new Map<string, unknown>([
      [keyOf(['id'], [OLD_PARENT], ['uuid']), [NEW_PARENT]],
    ]);

    const { row, dangling } = projectRow(
      { parent_id: OLD_PARENT, note: 'n' },
      [link],
      idMap,
      udtMap
    );

    expect(row.parent_id).toBe(NEW_PARENT);
    expect(dangling).toEqual([]);
  });

  it('matches the parent regardless of uuid casing', () => {
    const idMap = new Map<string, unknown>([
      [keyOf(['id'], [OLD_PARENT], ['uuid']), [NEW_PARENT]],
    ]);

    const { row } = projectRow(
      { parent_id: OLD_PARENT.toUpperCase(), note: 'n' },
      [link],
      idMap,
      udtMap
    );

    expect(row.parent_id).toBe(NEW_PARENT);
  });

  it('rewrites every column of a composite link together', () => {
    const idMap = new Map<string, unknown>([
      [keyOf(['tenant', 'id'], ['acme', OLD_PARENT], ['text', 'uuid']), ['globex', NEW_PARENT]],
    ]);

    const { row, dangling } = projectRow(
      { tenant: 'acme', parent_id: OLD_PARENT, note: 'n' },
      [compositeLink],
      idMap,
      udtMap
    );

    expect(row.tenant).toBe('globex');
    expect(row.parent_id).toBe(NEW_PARENT);
    expect(dangling).toEqual([]);
  });

  it('keeps two links onto different keys of the same parent apart', () => {
    const byId = keyOf(['id'], [OLD_PARENT], ['uuid']);
    const byTenant = keyOf(['tenant'], ['acme'], ['text']);
    expect(byId).not.toBe(byTenant);

    const idMap = new Map<string, unknown>([
      [byId, [NEW_PARENT]],
      [byTenant, ['globex']],
    ]);

    const tenantLink: FkLink = {
      columns: ['tenant'],
      parentSchema: 'app',
      parentTable: 'parent',
      parentColumns: ['tenant'],
      source: 'MANUAL',
    };

    const { row } = projectRow(
      { tenant: 'acme', parent_id: OLD_PARENT },
      [link, tenantLink],
      idMap,
      udtMap
    );

    expect(row.parent_id).toBe(NEW_PARENT);
    expect(row.tenant).toBe('globex');
  });

  it('reports a reference whose parent is absent as dangling and leaves it untouched', () => {
    const { row, dangling } = projectRow(
      { parent_id: OLD_PARENT, note: 'n' },
      [link],
      new Map(),
      udtMap
    );

    expect(row.parent_id).toBe(OLD_PARENT);
    expect(dangling).toEqual(['parent_id']);
  });

  it('reports every column of an unresolved composite link as dangling', () => {
    const { dangling } = projectRow(
      { tenant: 'acme', parent_id: OLD_PARENT },
      [compositeLink],
      new Map(),
      udtMap
    );

    expect(dangling).toEqual(['tenant', 'parent_id']);
  });

  it('leaves a null reference alone', () => {
    const { row, dangling } = projectRow({ parent_id: null }, [link], new Map(), udtMap);
    expect(row.parent_id).toBeNull();
    expect(dangling).toEqual([]);
  });

  it('leaves a composite link alone when any of its columns is null', () => {
    const { row, dangling } = projectRow(
      { tenant: null, parent_id: OLD_PARENT },
      [compositeLink],
      new Map(),
      udtMap
    );

    expect(row.parent_id).toBe(OLD_PARENT);
    expect(dangling).toEqual([]);
  });

  it('returns the original row object when nothing is configured', () => {
    const original = { parent_id: OLD_PARENT };
    const { row } = projectRow(original, [], new Map(), udtMap);
    expect(row).toBe(original);
  });

  it('does not mutate the row it was given', () => {
    const idMap = new Map<string, unknown>([
      [keyOf(['id'], [OLD_PARENT], ['uuid']), [NEW_PARENT]],
    ]);
    const original = { parent_id: OLD_PARENT, note: 'n' };
    projectRow(original, [link], idMap, udtMap);
    expect(original.parent_id).toBe(OLD_PARENT);
  });

  it('carries a placeholder when the parent is itself pending insertion', () => {
    const placeholder = pendingRef('app.parent', 'id', ['id'], [OLD_PARENT], ['uuid']);
    const idMap = new Map<string, unknown>([
      [keyOf(['id'], [OLD_PARENT], ['uuid']), [placeholder]],
    ]);

    const { row } = projectRow({ parent_id: OLD_PARENT }, [link], idMap, udtMap);

    expect(isPendingRef(row.parent_id)).toBe(true);
  });

  it('carries a placeholder for only the minted half of a composite key', () => {
    const placeholder = pendingRef(
      'app.parent',
      'id',
      ['tenant', 'id'],
      ['acme', OLD_PARENT],
      ['text', 'uuid']
    );
    const idMap = new Map<string, unknown>([
      [
        keyOf(['tenant', 'id'], ['acme', OLD_PARENT], ['text', 'uuid']),
        ['globex', placeholder],
      ],
    ]);

    const { row } = projectRow(
      { tenant: 'acme', parent_id: OLD_PARENT },
      [compositeLink],
      idMap,
      udtMap
    );

    expect(row.tenant).toBe('globex');
    expect(isPendingRef(row.parent_id)).toBe(true);
  });

  it('never matches a real value with a placeholder', () => {
    expect(isPendingRef(OLD_PARENT)).toBe(false);
    expect(isPendingRef(null)).toBe(false);
    expect(isPendingRef(42)).toBe(false);
  });
});

describe('resolvePending', () => {
  const placeholder = pendingRef('app.parent', 'id', ['id'], [OLD_PARENT], ['uuid']);

  it('substitutes a minted id for a placeholder', () => {
    const minted = new Map<string, unknown>([[placeholder, NEW_PARENT]]);
    expect(resolvePending(placeholder, minted)).toBe(NEW_PARENT);
  });

  it('passes ordinary values straight through', () => {
    expect(resolvePending(OLD_PARENT, new Map())).toBe(OLD_PARENT);
    expect(resolvePending(null, new Map())).toBeNull();
  });

  it('refuses to apply a child whose parent was not selected', () => {
    expect(() => resolvePending(placeholder, new Map())).toThrow(/references a parent/);
  });
});
