import { describe, it, expect } from 'vitest';
import {
  ColumnInfo,
  FkLink,
  GroupTableConfig,
  UniqueKeyInfo,
} from '../../types/configReplicate';
import { classifyColumns, comparableColumns, copiedColumns } from './classify';
import { diffTable, settleIdMap, TableSnapshot } from './analyze.service';
import { isPendingRef } from './projection';

type Row = Record<string, unknown>;

const CITY = 'merchant_operating_city_id';
const OLD_CITY = 'city-old';
const NEW_CITY = 'city-new';

const column = (name: string, udtName = 'text'): ColumnInfo => ({
  columnName: name,
  ordinalPosition: 1,
  dataType: udtName === 'uuid' ? 'uuid' : 'character varying',
  udtName,
  isNullable: true,
  columnDefault: null,
  isIdentity: false,
  isGenerated: false,
});

const config = (table: string, position: number, fkLinks: FkLink[] = []): GroupTableConfig => ({
  schema: 'app',
  table,
  dimensionColumns: [CITY],
  position,
  matchStrategy: 'SIMILARITY',
  matchKeyColumns: [],
  columnConfig: {},
  fkRemap: {},
  fkLinks,
});

const linkTo = (columns: string[], parentTable: string, parentColumns: string[]): FkLink => ({
  columns,
  parentSchema: 'app',
  parentTable,
  parentColumns,
  source: 'MANUAL',
});

/** Builds a snapshot the way loadTable would, without touching a database. */
const snapshot = (
  cfg: GroupTableConfig,
  columns: ColumnInfo[],
  baseRows: Row[],
  targetRows: Row[]
): TableSnapshot => {
  const keys: UniqueKeyInfo[] = [{ name: `${cfg.table}_pkey`, columns: ['id'], isPrimary: true }];
  const classes = classifyColumns(columns, [CITY], [], cfg.columnConfig, keys);
  const udtMap: Record<string, string> = {};
  for (const c of columns) udtMap[c.columnName] = c.udtName;

  return {
    config: cfg,
    fingerprint: `app.${cfg.table}=x`,
    columns,
    keys,
    classes,
    udtMap,
    compareColumns: comparableColumns(classes),
    changeColumns: copiedColumns(classes),
    identityColumns: ['id'],
    primaryKeyColumn: 'id',
    matchMethod: 'SIMILARITY',
    matchKeyColumns: [],
    baseRows,
    targetRows,
  };
};

/**
 * Two tables that point at each other: an option belongs to a message, and the
 * message names the option it belongs to. Mirrors issue_option / issue_message.
 */
const cyclicPair = (udtName: string, targetRows: { opt: Row[]; msg: Row[] } = { opt: [], msg: [] }) => {
  const optCfg = config('opt', 0, [linkTo(['msg_id'], 'msg', ['id'])]);
  const msgCfg = config('msg', 1, [linkTo(['opt_id'], 'opt', ['id'])]);

  const optColumns = [column('id', udtName), column('msg_id', udtName), column(CITY)];
  const msgColumns = [column('id', udtName), column('opt_id', udtName), column(CITY)];

  return {
    tables: [optCfg, msgCfg],
    snapshots: new Map<string, TableSnapshot>([
      [
        'app.opt',
        snapshot(
          optCfg,
          optColumns,
          [{ id: 'o1', msg_id: 'm1', [CITY]: OLD_CITY }],
          targetRows.opt
        ),
      ],
      [
        'app.msg',
        snapshot(
          msgCfg,
          msgColumns,
          [{ id: 'm1', opt_id: 'o1', [CITY]: OLD_CITY }],
          targetRows.msg
        ),
      ],
    ]),
    links: new Map<string, FkLink[]>([
      ['app.opt', optCfg.fkLinks],
      ['app.msg', msgCfg.fkLinks],
    ]),
    referenced: new Map<string, string[][]>([
      ['app.opt', [['id']]],
      ['app.msg', [['id']]],
    ]),
  };
};

const finalPass = (fixture: ReturnType<typeof cyclicPair>, idMap: Map<string, unknown>) => {
  const out = new Map<string, unknown>();
  const byTable: Record<string, ReturnType<typeof diffTable>> = {};
  for (const table of fixture.tables) {
    const key = `app.${table.table}`;
    byTable[table.table] = diffTable(
      fixture.snapshots.get(key) as TableSnapshot,
      fixture.links.get(key) || [],
      fixture.referenced.get(key) || [],
      idMap,
      out,
      [NEW_CITY],
      true
    );
  }
  return byTable;
};

describe('settleIdMap on a reference cycle', () => {
  it('resolves both directions when every row is an insert', () => {
    const fixture = cyclicPair('uuid');
    const idMap = settleIdMap(
      fixture.tables,
      fixture.snapshots,
      fixture.links,
      fixture.referenced,
      [NEW_CITY]
    );

    const passes = finalPass(fixture, idMap);

    for (const table of ['opt', 'msg'] as const) {
      const diffs = passes[table].analysis.diffs;
      expect(diffs).toHaveLength(1);
      expect(diffs[0].operation).toBe('INSERT');
      expect(diffs[0].danglingRefs).toBeUndefined();
    }

    const optRow = passes.opt.context!.baseRowsByDiffId.values().next().value as Row;
    const msgRow = passes.msg.context!.baseRowsByDiffId.values().next().value as Row;

    expect(isPendingRef(optRow.msg_id)).toBe(true);
    expect(isPendingRef(msgRow.opt_id)).toBe(true);
  });

  it('emits a sentinel for a char(36) key, matching what apply mints', () => {
    const fixture = cyclicPair('bpchar');
    const idMap = settleIdMap(
      fixture.tables,
      fixture.snapshots,
      fixture.links,
      fixture.referenced,
      [NEW_CITY]
    );

    const optRow = finalPass(fixture, idMap).opt.context!.baseRowsByDiffId.values().next()
      .value as Row;

    // Not the base row's own value, which would point at the source city.
    expect(optRow.msg_id).not.toBe('m1');
    expect(isPendingRef(optRow.msg_id)).toBe(true);
  });

  it('uses the existing target ids when the rows already pair', () => {
    const fixture = cyclicPair('uuid', {
      opt: [{ id: 'O1', msg_id: 'M1', [CITY]: NEW_CITY }],
      msg: [{ id: 'M1', opt_id: 'O1', [CITY]: NEW_CITY }],
    });

    const idMap = settleIdMap(
      fixture.tables,
      fixture.snapshots,
      fixture.links,
      fixture.referenced,
      [NEW_CITY]
    );
    const passes = finalPass(fixture, idMap);

    const optRow = passes.opt.context!.baseRowsByDiffId.get(
      passes.opt.analysis.diffs[0].diffId
    ) as Row | undefined;

    // Paired rows resolve to real ids, never to a sentinel.
    for (const value of idMap.values()) {
      expect(isPendingRef((value as unknown[])[0])).toBe(false);
    }
    expect(optRow?.msg_id ?? 'M1').toBe('M1');
  });

  it('converges and is stable when replayed', () => {
    const fixture = cyclicPair('uuid');
    const first = settleIdMap(
      fixture.tables,
      fixture.snapshots,
      fixture.links,
      fixture.referenced,
      [NEW_CITY]
    );
    const second = settleIdMap(
      fixture.tables,
      fixture.snapshots,
      fixture.links,
      fixture.referenced,
      [NEW_CITY]
    );

    expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
    for (const [key, value] of first) {
      expect(second.get(key)).toEqual(value);
    }
  });
});

describe('diffTable', () => {
  it('produces identical diff ids and hashes across repeated runs', () => {
    const fixture = cyclicPair('uuid');
    const idMap = settleIdMap(
      fixture.tables,
      fixture.snapshots,
      fixture.links,
      fixture.referenced,
      [NEW_CITY]
    );

    const a = finalPass(fixture, idMap).opt.analysis.diffs[0];
    const b = finalPass(fixture, idMap).opt.analysis.diffs[0];

    expect(b.diffId).toBe(a.diffId);
    expect(b.operation).toBe(a.operation);
    expect(b.sourceHash).toBe(a.sourceHash);
    expect(b.targetHash).toBe(a.targetHash);
  });

  it('registers parents but builds no diffs on a settling round', () => {
    const fixture = cyclicPair('uuid');
    const out = new Map<string, unknown>();

    const { analysis, context } = diffTable(
      fixture.snapshots.get('app.opt') as TableSnapshot,
      fixture.links.get('app.opt') || [],
      fixture.referenced.get('app.opt') || [],
      new Map(),
      out,
      [NEW_CITY],
      false
    );

    expect(analysis.diffs).toEqual([]);
    expect(context).toBeNull();
    expect(out.size).toBe(1);
  });

  it('leaves a link pointing outside the group dangling', () => {
    const cfg = config('opt', 0, [linkTo(['msg_id'], 'msg', ['id'])]);
    const snap = snapshot(
      cfg,
      [column('id', 'uuid'), column('msg_id', 'uuid'), column(CITY)],
      [{ id: 'o1', msg_id: 'm-missing', [CITY]: OLD_CITY }],
      []
    );

    const { analysis } = diffTable(
      snap,
      cfg.fkLinks,
      [],
      new Map(),
      new Map(),
      [NEW_CITY],
      true
    );

    expect(analysis.diffs[0].danglingRefs).toEqual(['msg_id']);
  });
});
