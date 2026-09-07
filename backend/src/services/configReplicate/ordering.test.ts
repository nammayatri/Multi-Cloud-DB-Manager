import { describe, it, expect } from 'vitest';
import { FkLink, GroupTableConfig } from '../../types/configReplicate';
import { effectiveLinks, orderViolations, sortTables, topologicalOrder } from './ordering';

const table = (
  name: string,
  position: number,
  fkLinks: FkLink[] = [],
  fkRemap: Record<string, string> = {}
): GroupTableConfig => ({
  schema: 'app',
  table: name,
  dimensionColumns: ['city_id'],
  position,
  matchStrategy: 'AUTO',
  matchKeyColumns: [],
  columnConfig: {},
  fkRemap,
  fkLinks,
});

const linkTo = (parent: string, columns = ['parent_id']): FkLink => ({
  columns,
  parentSchema: 'app',
  parentTable: parent,
  parentColumns: [],
  source: 'MANUAL',
});

describe('effectiveLinks', () => {
  it('reads a legacy fkRemap group as single-column links on the parent primary key', () => {
    const links = effectiveLinks(table('child', 0, [], { parent_id: 'app.parent' }));

    expect(links).toEqual([
      {
        columns: ['parent_id'],
        parentSchema: 'app',
        parentTable: 'parent',
        parentColumns: [],
        source: 'MANUAL',
      },
    ]);
  });

  it('prefers configured links over the legacy map', () => {
    const configured = linkTo('parent', ['a', 'b']);
    const links = effectiveLinks(table('child', 0, [configured], { parent_id: 'app.other' }));
    expect(links).toEqual([configured]);
  });
});

describe('topologicalOrder', () => {
  it('puts a parent before its child regardless of saved order', () => {
    const { order, cycles } = topologicalOrder([
      table('child', 0, [linkTo('parent')]),
      table('parent', 1),
    ]);

    expect(order).toEqual(['app.parent', 'app.child']);
    expect(cycles).toEqual([]);
  });

  it('orders a diamond with both parents ahead of the join', () => {
    const { order } = topologicalOrder([
      table('leaf', 0, [linkTo('left'), linkTo('right')]),
      table('right', 1, [linkTo('root')]),
      table('left', 2, [linkTo('root')]),
      table('root', 3),
    ]);

    expect(order.indexOf('app.root')).toBeLessThan(order.indexOf('app.left'));
    expect(order.indexOf('app.root')).toBeLessThan(order.indexOf('app.right'));
    expect(order.indexOf('app.left')).toBeLessThan(order.indexOf('app.leaf'));
    expect(order.indexOf('app.right')).toBeLessThan(order.indexOf('app.leaf'));
  });

  it('keeps the saved order among tables nothing links', () => {
    const { order } = topologicalOrder([table('b', 0), table('a', 1), table('c', 2)]);
    expect(order).toEqual(['app.b', 'app.a', 'app.c']);
  });

  it('reports a cycle rather than inventing an order for it', () => {
    const { order, cycles } = topologicalOrder([
      table('a', 0, [linkTo('b')]),
      table('b', 1, [linkTo('a')]),
    ]);

    expect(order).toEqual([]);
    expect(cycles).toEqual([['app.a', 'app.b']]);
  });

  it('ignores a self-link and a link pointing outside the group', () => {
    const { order, cycles } = topologicalOrder([
      table('a', 0, [linkTo('a'), linkTo('absent')]),
      table('b', 1),
    ]);

    expect(order).toEqual(['app.a', 'app.b']);
    expect(cycles).toEqual([]);
  });
});

describe('orderViolations', () => {
  it('names a child sitting above its parent', () => {
    const violations = orderViolations([
      table('child', 0, [linkTo('parent')]),
      table('parent', 1),
    ]);

    expect(violations).toEqual([{ child: 'app.child', parent: 'app.parent' }]);
  });

  it('reports nothing once the parent is above', () => {
    expect(orderViolations([table('parent', 0), table('child', 1, [linkTo('parent')])])).toEqual(
      []
    );
  });

  it('reports a parent and child sharing a position, which the apply cannot separate', () => {
    const violations = orderViolations([table('parent', 0), table('child', 0, [linkTo('parent')])]);
    expect(violations).toHaveLength(1);
  });
});

describe('sortTables', () => {
  it('re-stamps position from the topological order', () => {
    const sorted = sortTables([table('child', 0, [linkTo('parent')]), table('parent', 1)]);

    expect(sorted.map(t => t.table)).toEqual(['parent', 'child']);
    expect(sorted.map(t => t.position)).toEqual([0, 1]);
  });

  it('leaves a cyclic group untouched rather than dropping tables', () => {
    const cyclic = [table('a', 0, [linkTo('b')]), table('b', 1, [linkTo('a')])];
    expect(sortTables(cyclic)).toBe(cyclic);
  });
});
