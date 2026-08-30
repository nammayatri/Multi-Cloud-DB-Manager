import { describe, it, expect } from 'vitest';
import { ColumnInfo, UniqueKeyInfo } from '../../types/configReplicate';
import {
  classifyColumns,
  comparableColumns,
  copiedColumns,
  editableColumns,
  suggestMatchKey,
} from './classify';

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

const pk = (columns: string[]): UniqueKeyInfo => ({ name: 't_pkey', columns, isPrimary: true });

describe('classifyColumns', () => {
  it('classifies the dimension column first, even against an explicit override', () => {
    const classes = classifyColumns(
      [column({ columnName: 'city_id', udtName: 'int4' })],
      ['city_id'],
      [],
      { city_id: 'COPIED' },
      []
    );
    expect(classes.city_id).toBe('DIMENSION');
  });

  it('honours an explicit override above auto-detection', () => {
    const classes = classifyColumns(
      [column({ columnName: 'created_at', dataType: 'timestamp without time zone' })],
      ['city_id'],
      [],
      { created_at: 'COPIED' },
      []
    );
    expect(classes.created_at).toBe('COPIED');
  });

  it('detects uuid and sequence defaults as generated', () => {
    const classes = classifyColumns(
      [
        column({ columnName: 'a', columnDefault: 'gen_random_uuid()', udtName: 'uuid' }),
        column({ columnName: 'b', columnDefault: 'uuid_generate_v4()', udtName: 'uuid' }),
        column({ columnName: 'c', columnDefault: "nextval('t_c_seq'::regclass)", udtName: 'int4' }),
      ],
      ['city_id'],
      [],
      {},
      []
    );
    expect(classes.a).toBe('GENERATED');
    expect(classes.b).toBe('GENERATED');
    expect(classes.c).toBe('GENERATED');
  });

  it('treats identity and generated-always columns as generated', () => {
    const classes = classifyColumns(
      [
        column({ columnName: 'a', isIdentity: true }),
        column({ columnName: 'b', isGenerated: true }),
      ],
      ['city_id'],
      [],
      {},
      []
    );
    expect(classes.a).toBe('GENERATED');
    expect(classes.b).toBe('GENERATED');
  });

  it('only treats audit names as timestamps when the type is a timestamp', () => {
    const classes = classifyColumns(
      [
        column({ columnName: 'created_at', dataType: 'timestamp with time zone' }),
        column({ columnName: 'updated_at', dataType: 'timestamp without time zone' }),
        column({ columnName: 'created_at_note', dataType: 'text' }),
      ],
      ['city_id'],
      [],
      {},
      []
    );
    expect(classes.created_at).toBe('TIMESTAMP');
    expect(classes.updated_at).toBe('TIMESTAMP');
    expect(classes.created_at_note).toBe('COPIED');
  });

  it('does not treat a text column named created_at as a timestamp', () => {
    const classes = classifyColumns(
      [column({ columnName: 'created_at', dataType: 'text' })],
      ['city_id'],
      [],
      {},
      []
    );
    expect(classes.created_at).toBe('COPIED');
  });

  it('regenerates a bare single-column uuid primary key with no default', () => {
    const classes = classifyColumns(
      [column({ columnName: 'id', udtName: 'uuid' })],
      ['city_id'],
      [],
      {},
      [pk(['id'])]
    );
    expect(classes.id).toBe('GENERATED');
  });

  it('does not regenerate a composite primary key member', () => {
    const classes = classifyColumns(
      [column({ columnName: 'id', udtName: 'uuid' })],
      ['city_id'],
      [],
      {},
      [pk(['id', 'city_id'])]
    );
    expect(classes.id).toBe('COPIED');
  });

  it('marks configured match columns', () => {
    const classes = classifyColumns(
      [column({ columnName: 'config_key' })],
      ['city_id'],
      ['config_key'],
      {},
      []
    );
    expect(classes.config_key).toBe('MATCH_KEY');
  });

  it('auto-classifies a column added to the table after the group was saved', () => {
    const classes = classifyColumns(
      [column({ columnName: 'known' }), column({ columnName: 'added_later' })],
      ['city_id'],
      [],
      { known: 'IGNORED' },
      []
    );
    expect(classes.known).toBe('IGNORED');
    expect(classes.added_later).toBe('COPIED');
  });
});

describe('column selectors', () => {
  const classes = {
    city_id: 'DIMENSION' as const,
    config_key: 'MATCH_KEY' as const,
    id: 'GENERATED' as const,
    created_at: 'TIMESTAMP' as const,
    value: 'COPIED' as const,
    junk: 'IGNORED' as const,
  };

  it('compares match keys and copied columns only', () => {
    expect(comparableColumns(classes).sort()).toEqual(['config_key', 'value']);
  });

  it('reports changes on copied columns only', () => {
    expect(copiedColumns(classes)).toEqual(['value']);
  });
});

describe('suggestMatchKey', () => {
  it('prefers the narrowest key containing the dimension column', () => {
    const keys: UniqueKeyInfo[] = [
      { name: 'wide', columns: ['city_id', 'a', 'b', 'c'], isPrimary: false },
      { name: 'narrow', columns: ['city_id', 'a'], isPrimary: false },
    ];
    expect(suggestMatchKey(keys, ['city_id'])?.matchColumns).toEqual(['a']);
  });

  it('breaks ties on constraint name so the choice is deterministic', () => {
    const keys: UniqueKeyInfo[] = [
      { name: 'b_key', columns: ['city_id', 'y'], isPrimary: false },
      { name: 'a_key', columns: ['city_id', 'x'], isPrimary: false },
    ];
    expect(suggestMatchKey(keys, ['city_id'])?.key.name).toBe('a_key');
  });

  it('ignores keys that do not contain the dimension column', () => {
    const keys: UniqueKeyInfo[] = [{ name: 'k', columns: ['other'], isPrimary: false }];
    expect(suggestMatchKey(keys, ['city_id'])).toBeNull();
  });

  it('treats a key of only the dimension column as one row per dimension value', () => {
    const keys: UniqueKeyInfo[] = [{ name: 'pk', columns: ['city_id'], isPrimary: true }];
    const suggestion = suggestMatchKey(keys, ['city_id']);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.matchColumns).toEqual([]);
  });

  it('prefers the one-row-per-dimension key over a wider one', () => {
    const keys: UniqueKeyInfo[] = [
      { name: 'wide', columns: ['city_id', 'variant'], isPrimary: false },
      { name: 'pk', columns: ['city_id'], isPrimary: true },
    ];
    expect(suggestMatchKey(keys, ['city_id'])!.key.name).toBe('pk');
  });
});

describe('composite dimensions', () => {
  const dimensions = ['merchant_id', 'city_id'];

  it('classifies every dimension column as DIMENSION', () => {
    const classes = classifyColumns(
      [
        column({ columnName: 'merchant_id' }),
        column({ columnName: 'city_id', udtName: 'int4' }),
        column({ columnName: 'value' }),
      ],
      dimensions,
      [],
      {},
      []
    );
    expect(classes.merchant_id).toBe('DIMENSION');
    expect(classes.city_id).toBe('DIMENSION');
    expect(classes.value).toBe('COPIED');
  });

  it('strips every dimension column out of the match key', () => {
    const keys: UniqueKeyInfo[] = [
      { name: 'k', columns: ['merchant_id', 'city_id', 'config_key'], isPrimary: false },
    ];
    expect(suggestMatchKey(keys, dimensions)?.matchColumns).toEqual(['config_key']);
  });

  it('prefers the key covering the most dimension columns', () => {
    const keys: UniqueKeyInfo[] = [
      { name: 'partial', columns: ['city_id', 'config_key'], isPrimary: false },
      { name: 'full', columns: ['merchant_id', 'city_id', 'config_key'], isPrimary: false },
    ];
    expect(suggestMatchKey(keys, dimensions)?.key.name).toBe('full');
  });

  it('accepts a key covering only some of the dimension columns', () => {
    const keys: UniqueKeyInfo[] = [
      { name: 'partial', columns: ['city_id', 'config_key'], isPrimary: false },
    ];
    const suggestion = suggestMatchKey(keys, dimensions);
    expect(suggestion?.key.name).toBe('partial');
    expect(suggestion?.matchColumns).toEqual(['config_key']);
  });

  it('rejects a key that pins none of the dimension columns', () => {
    // Unique across the whole table, so the same key value cannot exist under
    // two dimension values at once and nothing could ever pair.
    const keys: UniqueKeyInfo[] = [{ name: 'global', columns: ['config_key'], isPrimary: false }];
    expect(suggestMatchKey(keys, dimensions)).toBeNull();
  });

  it('treats a key of exactly the dimension columns as one row per dimension', () => {
    const keys: UniqueKeyInfo[] = [
      { name: 'pk', columns: ['merchant_id', 'city_id'], isPrimary: true },
    ];
    const suggestion = suggestMatchKey(keys, dimensions);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.matchColumns).toEqual([]);
  });
});

describe('editableColumns', () => {
  const classes = {
    city_id: 'DIMENSION' as const,
    config_key: 'MATCH_KEY' as const,
    id: 'GENERATED' as const,
    created_at: 'TIMESTAMP' as const,
    value: 'COPIED' as const,
    parent_id: 'COPIED' as const,
    junk: 'IGNORED' as const,
  };

  it('offers only plain copied payload', () => {
    expect(editableColumns(classes).sort()).toEqual(['parent_id', 'value']);
  });

  it('withholds a foreign key the run rewrites', () => {
    expect(editableColumns(classes, { parent_id: 'app.parent' })).toEqual(['value']);
  });

  it('never offers a dimension, generated id, timestamp or match key', () => {
    const offered = editableColumns(classes);
    for (const locked of ['city_id', 'id', 'created_at', 'config_key', 'junk']) {
      expect(offered).not.toContain(locked);
    }
  });
});
