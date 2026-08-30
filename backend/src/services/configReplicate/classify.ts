import { ColumnClass, ColumnInfo, UniqueKeyInfo } from '../../types/configReplicate';

const GENERATED_DEFAULT_REGEX = /gen_random_uuid\s*\(|uuid_generate_v[0-9]|nextval\s*\(/i;

const TIMESTAMP_COLUMN_NAMES = new Set([
  'created_at',
  'updated_at',
  'created_on',
  'updated_on',
  'inserted_at',
  'modified_at',
]);

export const UPDATE_STAMP_COLUMNS = new Set(['updated_at', 'updated_on', 'modified_at']);

export const classifyColumn = (
  column: ColumnInfo,
  dimensionColumns: string[],
  matchKeyColumns: string[],
  explicit: Record<string, ColumnClass>,
  primaryKey: UniqueKeyInfo | null
): ColumnClass => {
  if (dimensionColumns.includes(column.columnName)) return 'DIMENSION';

  const override = explicit[column.columnName];
  if (override) return override;

  if (matchKeyColumns.includes(column.columnName)) return 'MATCH_KEY';

  if (column.isIdentity || column.isGenerated) return 'GENERATED';

  if (column.columnDefault && GENERATED_DEFAULT_REGEX.test(column.columnDefault)) {
    return 'GENERATED';
  }

  if (
    TIMESTAMP_COLUMN_NAMES.has(column.columnName) &&
    column.dataType.toLowerCase().startsWith('timestamp')
  ) {
    return 'TIMESTAMP';
  }

  if (
    primaryKey &&
    primaryKey.columns.length === 1 &&
    primaryKey.columns[0] === column.columnName &&
    column.udtName.toLowerCase() === 'uuid'
  ) {
    return 'GENERATED';
  }

  return 'COPIED';
};

export const classifyColumns = (
  columns: ColumnInfo[],
  dimensionColumns: string[],
  matchKeyColumns: string[],
  explicit: Record<string, ColumnClass>,
  keys: UniqueKeyInfo[]
): Record<string, ColumnClass> => {
  const primaryKey = keys.find(k => k.isPrimary) || null;
  const result: Record<string, ColumnClass> = {};
  for (const column of columns) {
    result[column.columnName] = classifyColumn(
      column,
      dimensionColumns,
      matchKeyColumns,
      explicit,
      primaryKey
    );
  }
  return result;
};

export const comparableColumns = (classes: Record<string, ColumnClass>): string[] =>
  Object.keys(classes).filter(c => classes[c] === 'COPIED' || classes[c] === 'MATCH_KEY');

export const copiedColumns = (classes: Record<string, ColumnClass>): string[] =>
  Object.keys(classes).filter(c => classes[c] === 'COPIED');

export const editableColumns = (
  classes: Record<string, ColumnClass>,
  fkRemap: Record<string, string> = {}
): string[] => copiedColumns(classes).filter(c => !(c in fkRemap));

export const suggestMatchKey = (
  keys: UniqueKeyInfo[],
  dimensionColumns: string[]
): { key: UniqueKeyInfo; matchColumns: string[] } | null => {
  const dimensions = new Set(dimensionColumns);

  // A key must contain at least one dimension column to be usable. One that does
  // not is unique across the whole table, so the same key value cannot exist under
  // both dimension values at once and no row could ever pair.
  //
  // A key of exactly the dimension columns is kept, not skipped: it means the
  // table holds one row per dimension value, so the match key is empty and the
  // two rows pair unconditionally. Dropping it would push a one-row-per-city
  // table onto similarity matching, where a row that changed in every column
  // scores zero and comes back as an insert plus a delete instead of an update.
  const candidates = keys
    .map(key => ({
      key,
      covered: key.columns.filter(c => dimensions.has(c)).length,
      matchColumns: key.columns.filter(c => !dimensions.has(c)),
    }))
    .filter(c => c.covered > 0)
    .sort((a, b) => {
      if (a.covered !== b.covered) return b.covered - a.covered;
      if (a.matchColumns.length !== b.matchColumns.length) {
        return a.matchColumns.length - b.matchColumns.length;
      }
      return a.key.name.localeCompare(b.key.name);
    });

  const chosen = candidates[0];
  if (!chosen) return null;

  return { key: chosen.key, matchColumns: chosen.matchColumns };
};
