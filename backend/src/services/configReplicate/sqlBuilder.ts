import { ColumnClass, ColumnInfo } from '../../types/configReplicate';
import { UPDATE_STAMP_COLUMNS } from './classify';

export interface BuiltStatement {
  sql: string;
  params: unknown[];
}

export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export const assertKnownIdentifier = (name: string, allowlist: Set<string>): string => {
  if (!allowlist.has(name)) {
    throw new Error(`Unknown identifier: ${name}`);
  }
  return name;
};

const castFor = (udtName: string): string => {
  const udt = udtName.toLowerCase();
  if (udt === 'json' || udt === 'jsonb') return `::${udt}`;
  if (udt.startsWith('_')) return `::${udt.slice(1)}[]`;
  return '';
};

const SAFE_UDT = /^[a-z_][a-z0-9_]*$/;

export const overrideCast = (udtName: string): string => {
  const udt = udtName.toLowerCase();
  if (udt.startsWith('_')) {
    const element = udt.slice(1);
    return SAFE_UDT.test(element) ? `::${element}[]` : '::text[]';
  }
  return SAFE_UDT.test(udt) ? `::${udt}` : '';
};

const bindValue = (value: unknown, column: ColumnInfo): unknown => {
  const udt = column.udtName.toLowerCase();
  if (value === null || value === undefined) return null;
  if ((udt === 'json' || udt === 'jsonb') && typeof value !== 'string') {
    return JSON.stringify(value);
  }
  return value;
};

export interface BuildContext {
  schema: string;
  table: string;
  columns: ColumnInfo[];
  classes: Record<string, ColumnClass>;
  columnAllowlist: Set<string>;
  dimensionColumns: string[];
  newDimensionValues: Record<string, string>;
}

export const buildIdentityPredicate = (
  ctx: BuildContext,
  identityColumns: string[],
  row: Record<string, unknown>,
  startIndex: number
): { clause: string; params: unknown[] } => {
  const columnByName = new Map(ctx.columns.map(c => [c.columnName, c]));
  const clauses: string[] = [];
  const params: unknown[] = [];
  let index = startIndex;

  for (const columnName of identityColumns) {
    assertKnownIdentifier(columnName, ctx.columnAllowlist);
    const column = columnByName.get(columnName)!;
    clauses.push(
      `${quoteIdent(columnName)} IS NOT DISTINCT FROM $${index}${castFor(column.udtName)}`
    );
    params.push(bindValue(row[columnName], column));
    index++;
  }

  // Every dimension column is pinned to its new value, so a predicate can never
  // reach a row outside the slice being written even if the identity columns are
  // a weak key.
  for (const dimension of ctx.dimensionColumns) {
    if (identityColumns.includes(dimension)) continue;
    assertKnownIdentifier(dimension, ctx.columnAllowlist);
    clauses.push(`${quoteIdent(dimension)} IS NOT DISTINCT FROM $${index}`);
    params.push(ctx.newDimensionValues[dimension]);
    index++;
  }

  return { clause: clauses.join(' AND '), params };
};

export const buildInsert = (
  ctx: BuildContext,
  baseRow: Record<string, unknown>,
  generatedValues: Record<string, unknown>,
  remappedValues: Record<string, unknown>,
  overrides: Record<string, string | null> = {}
): BuiltStatement => {
  const columnNames: string[] = [];
  const valueExpressions: string[] = [];
  const params: unknown[] = [];

  for (const column of ctx.columns) {
    const name = column.columnName;
    const columnClass = ctx.classes[name];

    if (columnClass === 'IGNORED') continue;

    if (columnClass === 'DIMENSION') {
      assertKnownIdentifier(name, ctx.columnAllowlist);
      columnNames.push(quoteIdent(name));
      params.push(ctx.newDimensionValues[name]);
      valueExpressions.push(`$${params.length}`);
      continue;
    }

    if (columnClass === 'TIMESTAMP') {
      assertKnownIdentifier(name, ctx.columnAllowlist);
      columnNames.push(quoteIdent(name));
      valueExpressions.push('NOW()');
      continue;
    }

    if (columnClass === 'GENERATED') {
      if (Object.prototype.hasOwnProperty.call(generatedValues, name)) {
        assertKnownIdentifier(name, ctx.columnAllowlist);
        columnNames.push(quoteIdent(name));
        params.push(bindValue(generatedValues[name], column));
        valueExpressions.push(`$${params.length}${castFor(column.udtName)}`);
      }
      continue;
    }

    assertKnownIdentifier(name, ctx.columnAllowlist);
    columnNames.push(quoteIdent(name));

    if (Object.prototype.hasOwnProperty.call(overrides, name)) {
      params.push(overrides[name]);
      valueExpressions.push(`$${params.length}${overrideCast(column.udtName)}`);
      continue;
    }

    const value = Object.prototype.hasOwnProperty.call(remappedValues, name)
      ? remappedValues[name]
      : baseRow[name];
    params.push(bindValue(value, column));
    valueExpressions.push(`$${params.length}${castFor(column.udtName)}`);
  }

  const sql =
    `INSERT INTO ${quoteIdent(ctx.schema)}.${quoteIdent(ctx.table)} ` +
    `(${columnNames.join(', ')}) VALUES (${valueExpressions.join(', ')})`;

  return { sql, params };
};

export const buildUpdate = (
  ctx: BuildContext,
  baseRow: Record<string, unknown>,
  targetRow: Record<string, unknown>,
  changedColumns: string[],
  identityColumns: string[],
  remappedValues: Record<string, unknown>
): BuiltStatement => {
  const columnByName = new Map(ctx.columns.map(c => [c.columnName, c]));
  const assignments: string[] = [];
  const params: unknown[] = [];

  for (const name of changedColumns) {
    assertKnownIdentifier(name, ctx.columnAllowlist);
    const column = columnByName.get(name)!;
    const value = Object.prototype.hasOwnProperty.call(remappedValues, name)
      ? remappedValues[name]
      : baseRow[name];
    params.push(bindValue(value, column));
    assignments.push(`${quoteIdent(name)} = $${params.length}${castFor(column.udtName)}`);
  }

  for (const column of ctx.columns) {
    if (ctx.classes[column.columnName] !== 'TIMESTAMP') continue;
    if (!UPDATE_STAMP_COLUMNS.has(column.columnName)) continue;
    assertKnownIdentifier(column.columnName, ctx.columnAllowlist);
    assignments.push(`${quoteIdent(column.columnName)} = NOW()`);
  }

  if (assignments.length === 0) {
    throw new Error(`UPDATE for ${ctx.schema}.${ctx.table} has no assignments`);
  }

  const predicate = buildIdentityPredicate(ctx, identityColumns, targetRow, params.length + 1);

  const sql =
    `UPDATE ${quoteIdent(ctx.schema)}.${quoteIdent(ctx.table)} ` +
    `SET ${assignments.join(', ')} WHERE ${predicate.clause}`;

  return { sql, params: [...params, ...predicate.params] };
};

export const buildDelete = (
  ctx: BuildContext,
  targetRow: Record<string, unknown>,
  identityColumns: string[]
): BuiltStatement => {
  const predicate = buildIdentityPredicate(ctx, identityColumns, targetRow, 1);

  const sql =
    `DELETE FROM ${quoteIdent(ctx.schema)}.${quoteIdent(ctx.table)} WHERE ${predicate.clause}`;

  return { sql, params: predicate.params };
};
