import { describe, it, expect } from 'vitest';
import { ColumnClass, ColumnInfo } from '../../types/configReplicate';
import {
  BuildContext,
  buildDelete,
  buildInsert,
  buildUpdate,
  overrideCast,
  quoteIdent,
} from './sqlBuilder';

const column = (over: Partial<ColumnInfo> & { columnName: string }): ColumnInfo => ({
  ordinalPosition: 1,
  dataType: 'text',
  udtName: 'text',
  isNullable: true,
  columnDefault: null,
  isIdentity: false,
  isGenerated: false,
  ...over,
});

const columns: ColumnInfo[] = [
  column({ columnName: 'id', udtName: 'uuid' }),
  column({ columnName: 'city_id', udtName: 'int4' }),
  column({ columnName: 'config_key' }),
  column({ columnName: 'value' }),
  column({ columnName: 'payload', udtName: 'jsonb' }),
  column({ columnName: 'created_at', dataType: 'timestamp with time zone', udtName: 'timestamptz' }),
  column({ columnName: 'updated_at', dataType: 'timestamp with time zone', udtName: 'timestamptz' }),
  column({ columnName: 'junk' }),
];

const classes: Record<string, ColumnClass> = {
  id: 'GENERATED',
  city_id: 'DIMENSION',
  config_key: 'MATCH_KEY',
  value: 'COPIED',
  payload: 'COPIED',
  created_at: 'TIMESTAMP',
  updated_at: 'TIMESTAMP',
  junk: 'IGNORED',
};

const ctx: BuildContext = {
  schema: 'public',
  table: 'city_config',
  columns,
  classes,
  columnAllowlist: new Set(columns.map(c => c.columnName)),
  dimensionColumns: ['city_id'],
  newDimensionValues: { city_id: '9' },
};

const baseRow = {
  id: 'aaaaaaaa-0000-0000-0000-000000000000',
  city_id: 5,
  config_key: 'k1',
  value: 'v1',
  payload: { a: 1 },
  created_at: new Date('2020-01-01T00:00:00Z'),
  updated_at: new Date('2020-01-01T00:00:00Z'),
  junk: 'ignore me',
};

const targetRow = { ...baseRow, id: 'bbbbbbbb-0000-0000-0000-000000000000', city_id: 9, value: 'old' };

const hasNoLiterals = (sql: string) => !/'/.test(sql.replace(/NOW\(\)/g, ''));

describe('quoteIdent', () => {
  it('doubles embedded quotes', () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });

  it('neutralises an injection attempt that reaches it', () => {
    expect(quoteIdent('"; DROP TABLE x; --')).toBe('"""; DROP TABLE x; --"');
  });
});

describe('identifier allowlist', () => {
  it('refuses a column that did not come from introspection', () => {
    const hostile: BuildContext = {
      ...ctx,
      columns: [...columns, column({ columnName: 'evil' })],
      classes: { ...classes, evil: 'COPIED' },
    };
    expect(() => buildInsert(hostile, baseRow, {}, {})).toThrow(/Unknown identifier: evil/);
  });
});

describe('buildInsert', () => {
  it('binds every value and interpolates none', () => {
    const built = buildInsert(ctx, baseRow, { id: 'cccccccc-0000-0000-0000-000000000000' }, {});
    expect(hasNoLiterals(built.sql)).toBe(true);
    expect(built.sql).toMatch(/^INSERT INTO "public"\."city_config" /);
  });

  it('writes the new dimension value, not the base one', () => {
    const built = buildInsert(ctx, baseRow, {}, {});
    expect(built.params).toContain('9');
    expect(built.params).not.toContain(5);
  });

  it('stamps timestamp columns with NOW() and binds no parameter for them', () => {
    const built = buildInsert(ctx, baseRow, {}, {});
    expect(built.sql).toContain('NOW()');
    expect(built.params).not.toContain(baseRow.created_at);
  });

  it('omits ignored columns entirely', () => {
    const built = buildInsert(ctx, baseRow, {}, {});
    expect(built.sql).not.toContain('junk');
    expect(built.params).not.toContain('ignore me');
  });

  it('omits a generated column when no value was minted for it', () => {
    const built = buildInsert(ctx, baseRow, {}, {});
    expect(built.sql).not.toContain('"id"');
  });

  it('includes a minted uuid for a generated column when one was supplied', () => {
    const minted = 'cccccccc-0000-0000-0000-000000000000';
    const built = buildInsert(ctx, baseRow, { id: minted }, {});
    expect(built.sql).toContain('"id"');
    expect(built.params).toContain(minted);
  });

  it('serializes jsonb and casts the placeholder', () => {
    const built = buildInsert(ctx, baseRow, {}, {});
    expect(built.sql).toMatch(/\$\d+::jsonb/);
    expect(built.params).toContain(JSON.stringify({ a: 1 }));
  });

  it('prefers a remapped foreign key value over the copied one', () => {
    const built = buildInsert(ctx, baseRow, {}, { value: 'remapped' });
    expect(built.params).toContain('remapped');
    expect(built.params).not.toContain('v1');
  });
});

describe('buildUpdate', () => {
  it('sets only the changed columns', () => {
    const built = buildUpdate(ctx, baseRow, targetRow, ['value'], ['id'], {});
    expect(built.sql).toContain('"value" = $1');
    expect(built.sql).not.toContain('"payload" =');
  });

  it('refreshes updated_at but never created_at', () => {
    const built = buildUpdate(ctx, baseRow, targetRow, ['value'], ['id'], {});
    expect(built.sql).toContain('"updated_at" = NOW()');
    expect(built.sql).not.toContain('"created_at" = NOW()');
  });

  it('targets the target row identity and pins the dimension to the new value', () => {
    const built = buildUpdate(ctx, baseRow, targetRow, ['value'], ['id'], {});
    expect(built.sql).toContain('"id" IS NOT DISTINCT FROM');
    expect(built.sql).toContain('"city_id" IS NOT DISTINCT FROM');
    expect(built.params).toContain(targetRow.id);
    expect(built.params).toContain('9');
  });

  it('binds every value and interpolates none', () => {
    const built = buildUpdate(ctx, baseRow, targetRow, ['value', 'payload'], ['id'], {});
    expect(hasNoLiterals(built.sql)).toBe(true);
  });

  it('refuses to emit an update with nothing to set', () => {
    const noStamps: BuildContext = {
      ...ctx,
      classes: { ...classes, updated_at: 'COPIED', created_at: 'COPIED' },
    };
    expect(() => buildUpdate(noStamps, baseRow, targetRow, [], ['id'], {})).toThrow(
      /no assignments/
    );
  });
});

describe('buildDelete', () => {
  it('scopes the delete to the target row and the new dimension', () => {
    const built = buildDelete(ctx, targetRow, ['id']);
    expect(built.sql).toMatch(/^DELETE FROM "public"\."city_config" WHERE /);
    expect(built.sql).toContain('"city_id" IS NOT DISTINCT FROM');
    expect(built.params).toContain('9');
    expect(hasNoLiterals(built.sql)).toBe(true);
  });

  it('does not add a redundant dimension predicate when it is already in the identity', () => {
    const built = buildDelete(ctx, targetRow, ['config_key', 'city_id']);
    expect(built.sql.match(/"city_id" IS NOT DISTINCT FROM/g)).toHaveLength(1);
  });

  it('uses IS NOT DISTINCT FROM so a NULL identity column still matches', () => {
    const built = buildDelete(ctx, { ...targetRow, config_key: null }, ['config_key']);
    expect(built.sql).toContain('"config_key" IS NOT DISTINCT FROM');
    expect(built.params[0]).toBeNull();
  });
});

describe('generated uuid columns that carry a database default', () => {
  const defaulted: ColumnInfo[] = [
    column({ columnName: 'id', udtName: 'uuid', columnDefault: 'gen_random_uuid()' }),
    column({ columnName: 'city_id', udtName: 'int4' }),
    column({ columnName: 'value' }),
  ];

  const defaultedCtx: BuildContext = {
    ...ctx,
    columns: defaulted,
    classes: { id: 'GENERATED', city_id: 'DIMENSION', value: 'COPIED' },
    columnAllowlist: new Set(defaulted.map(c => c.columnName)),
  };

  const row = { id: 'aaaaaaaa-0000-0000-0000-000000000000', city_id: 5, value: 'v' };

  it('writes the minted id rather than falling back to the database default', () => {
    const minted = 'cccccccc-0000-0000-0000-000000000000';
    const built = buildInsert(defaultedCtx, row, { id: minted }, {});
    expect(built.sql).toContain('"id"');
    expect(built.params).toContain(minted);
  });

  it('still omits the column when no id was minted for it', () => {
    const built = buildInsert(defaultedCtx, row, {}, {});
    expect(built.sql).not.toContain('"id"');
  });
});

describe('composite dimensions', () => {
  const compositeColumns: ColumnInfo[] = [
    column({ columnName: 'merchant_id' }),
    column({ columnName: 'city_id', udtName: 'int4' }),
    column({ columnName: 'config_key' }),
    column({ columnName: 'value' }),
  ];

  const compositeCtx: BuildContext = {
    schema: 'app',
    table: 'cfg',
    columns: compositeColumns,
    classes: {
      merchant_id: 'DIMENSION',
      city_id: 'DIMENSION',
      config_key: 'MATCH_KEY',
      value: 'COPIED',
    },
    columnAllowlist: new Set(compositeColumns.map(c => c.columnName)),
    dimensionColumns: ['merchant_id', 'city_id'],
    newDimensionValues: { merchant_id: 'M2', city_id: '9' },
  };

  const base = { merchant_id: 'M1', city_id: 5, config_key: 'k', value: 'v' };
  const target = { merchant_id: 'M2', city_id: 9, config_key: 'k', value: 'old' };

  it('writes each dimension column its own new value', () => {
    const built = buildInsert(compositeCtx, base, {}, {});
    expect(built.params).toContain('M2');
    expect(built.params).toContain('9');
    expect(built.params).not.toContain('M1');
    expect(built.params).not.toContain(5);
  });

  it('pins every dimension column in an identity predicate', () => {
    const built = buildDelete(compositeCtx, target, ['config_key']);
    expect(built.sql).toContain('"config_key" IS NOT DISTINCT FROM');
    expect(built.sql).toContain('"merchant_id" IS NOT DISTINCT FROM');
    expect(built.sql).toContain('"city_id" IS NOT DISTINCT FROM');
    expect(built.params).toEqual(['k', 'M2', '9']);
  });

  it('numbers placeholders correctly across several appended dimensions', () => {
    const built = buildUpdate(compositeCtx, base, target, ['value'], ['config_key'], {});
    expect(built.sql).toContain('"value" = $1');
    expect(built.sql).toContain('"config_key" IS NOT DISTINCT FROM $2');
    expect(built.sql).toContain('"merchant_id" IS NOT DISTINCT FROM $3');
    expect(built.sql).toContain('"city_id" IS NOT DISTINCT FROM $4');
    expect(built.params).toEqual(['v', 'k', 'M2', '9']);
  });

  it('does not duplicate a dimension already present in the identity columns', () => {
    const built = buildDelete(compositeCtx, target, ['merchant_id', 'config_key']);
    expect(built.sql.match(/"merchant_id" IS NOT DISTINCT FROM/g)).toHaveLength(1);
    expect(built.sql.match(/"city_id" IS NOT DISTINCT FROM/g)).toHaveLength(1);
  });

  it('still binds every value and interpolates none', () => {
    const built = buildInsert(compositeCtx, base, {}, {});
    expect(hasNoLiterals(built.sql)).toBe(true);
  });
});

describe('insert value overrides', () => {
  const overridable: ColumnInfo[] = [
    column({ columnName: 'city_id', udtName: 'int4' }),
    column({ columnName: 'config_key' }),
    column({ columnName: 'value' }),
    column({ columnName: 'limit_count', udtName: 'int4', dataType: 'integer' }),
    column({ columnName: 'payload', udtName: 'jsonb' }),
    column({ columnName: 'tags', udtName: '_text' }),
  ];

  const overrideCtx: BuildContext = {
    schema: 'app',
    table: 'cfg',
    columns: overridable,
    classes: {
      city_id: 'DIMENSION',
      config_key: 'MATCH_KEY',
      value: 'COPIED',
      limit_count: 'COPIED',
      payload: 'COPIED',
      tags: 'COPIED',
    },
    columnAllowlist: new Set(overridable.map(c => c.columnName)),
    dimensionColumns: ['city_id'],
    newDimensionValues: { city_id: '9' },
  };

  const row = { city_id: 5, config_key: 'k', value: 'original', limit_count: 1, payload: { a: 1 }, tags: ['x'] };

  it('writes the override instead of the base value', () => {
    const built = buildInsert(overrideCtx, row, {}, {}, { value: 'typed by hand' });
    expect(built.params).toContain('typed by hand');
    expect(built.params).not.toContain('original');
  });

  it('casts a text override to the column type so Postgres parses it', () => {
    const built = buildInsert(overrideCtx, row, {}, {}, { limit_count: '42' });
    expect(built.sql).toMatch(/\$\d+::int4/);
    expect(built.params).toContain('42');
  });

  it('casts jsonb and array overrides to their own types', () => {
    const built = buildInsert(overrideCtx, row, {}, {}, { payload: '{"b":2}', tags: '{y,z}' });
    expect(built.sql).toMatch(/\$\d+::jsonb/);
    expect(built.sql).toMatch(/\$\d+::text\[\]/);
  });

  it('accepts an explicit null override', () => {
    const built = buildInsert(overrideCtx, row, {}, {}, { value: null });
    expect(built.params).toContain(null);
  });

  it('still binds every override rather than interpolating it', () => {
    const built = buildInsert(overrideCtx, row, {}, {}, { value: "'; DROP TABLE x; --" });
    expect(built.sql).not.toContain('DROP TABLE');
    expect(built.params).toContain("'; DROP TABLE x; --");
  });

  it('leaves un-overridden columns on their copied values', () => {
    const built = buildInsert(overrideCtx, row, {}, {}, { value: 'new' });
    expect(built.params).toContain(1);
  });

  it('prefers an override over an fk-remapped value for the same column', () => {
    const built = buildInsert(overrideCtx, row, {}, { value: 'remapped' }, { value: 'override' });
    expect(built.params).toContain('override');
    expect(built.params).not.toContain('remapped');
  });
});

describe('overrideCast', () => {
  it('casts scalars, arrays and json', () => {
    expect(overrideCast('int4')).toBe('::int4');
    expect(overrideCast('timestamptz')).toBe('::timestamptz');
    expect(overrideCast('_text')).toBe('::text[]');
    expect(overrideCast('jsonb')).toBe('::jsonb');
  });

  it('refuses to emit a cast built from an unexpected type name', () => {
    expect(overrideCast('bad type; DROP TABLE x')).toBe('');
    expect(overrideCast('_bad type')).toBe('::text[]');
  });
});
