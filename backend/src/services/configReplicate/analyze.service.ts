import crypto from 'crypto';
import { PoolClient } from 'pg';
import {
  AnalysisResult,
  ColumnClass,
  ColumnInfo,
  ConfigGroup,
  ForeignKeyInfo,
  GroupTableConfig,
  RowDiff,
  TableAnalysis,
  UniqueKeyInfo,
} from '../../types/configReplicate';
import { classifyColumns, comparableColumns, copiedColumns, suggestMatchKey } from './classify';
import * as introspection from './introspection.service';
import { pairByKey, pairByMutualBestMatch, Row } from './matching';
import { idMapKey, pendingRef, projectRow } from './projection';
import { quoteIdent } from './sqlBuilder';
import { canonical, displayValue, makeDiffId, rowHash, valuesEqual } from './values';

export const MAX_ROWS_PER_TABLE = 5000;
export const MAX_DIFFS_TOTAL = 20000;

export interface TableContext {
  config: GroupTableConfig;
  columns: ColumnInfo[];
  keys: UniqueKeyInfo[];
  classes: Record<string, ColumnClass>;
  udtMap: Record<string, string>;
  identityColumns: string[];
  matchKeyColumns: string[];
  baseRowsByDiffId: Map<string, Row>;
  targetRowsByDiffId: Map<string, Row>;
  pairedByDiffId: Map<string, { base: Row; target: Row }>;
  changedColumnsByDiffId: Map<string, string[]>;
  primaryKeyColumn: string | null;
  originalBaseByDiffId: Map<string, Row>;
}

export interface AnalyzeOutput {
  result: AnalysisResult;
  contexts: Map<string, TableContext>;
  foreignKeys: ForeignKeyInfo[];
  idMap: Map<string, unknown>;
}

const qualified = (t: { schema: string; table: string }) => `${t.schema}.${t.table}`;

export const describeDimension = (columns: string[], values: string[]): string =>
  columns.map((c, i) => `${c}=${values[i]}`).join(', ');

const identityColumnsFor = (
  keys: UniqueKeyInfo[],
  matchKeyColumns: string[],
  dimensionColumns: string[],
  compareColumns: string[]
): string[] => {
  const primary = keys.find(k => k.isPrimary);
  if (primary) return primary.columns;
  if (matchKeyColumns.length > 0) return [...matchKeyColumns, ...dimensionColumns];
  return compareColumns.length > 0 ? compareColumns : dimensionColumns;
};

const dimensionPredicate = (dimensionColumns: string[]): string =>
  dimensionColumns.map((c, i) => `${quoteIdent(c)} = $${i + 1}`).join(' AND ');

const fetchRows = async (
  client: PoolClient,
  schema: string,
  table: string,
  dimensionColumns: string[],
  values: string[],
  orderColumns: string[]
): Promise<Row[]> => {
  const order = orderColumns.length
    ? `ORDER BY ${orderColumns.map(quoteIdent).join(', ')}`
    : '';

  const result = await client.query(
    `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} ` +
      `WHERE ${dimensionPredicate(dimensionColumns)} ${order} LIMIT ${MAX_ROWS_PER_TABLE + 1}`,
    values
  );

  return result.rows as Row[];
};

const analyzeTable = async (
  client: PoolClient,
  config: GroupTableConfig,
  baseValues: string[],
  newValues: string[],
  forUpdate: boolean,
  idMap: Map<string, unknown>
): Promise<{ analysis: TableAnalysis; context: TableContext | null; fingerprint: string }> => {
  const { schema, table } = config;
  const dimensionColumns = config.dimensionColumns;

  const analysis: TableAnalysis = {
    schema,
    table,
    position: config.position,
    matchMethod: null,
    matchKeyColumns: [],
    dimensionColumns: config.dimensionColumns,
    baseRowCount: 0,
    targetRowCount: 0,
    counts: { insert: 0, update: 0, delete: 0, noChange: 0 },
    diffs: [],
    warnings: [],
  };

  const columns = await introspection.getColumns(client, schema, table);
  if (columns.length === 0) {
    analysis.error = `Table ${qualified(config)} does not exist or is not readable`;
    return { analysis, context: null, fingerprint: '' };
  }

  const keys = await introspection.getUniqueKeys(client, schema, table);
  const fingerprint = `${qualified(config)}=${introspection.schemaFingerprint(columns, keys)}`;

  const columnNames = new Set(columns.map(c => c.columnName));
  const missingDimensions = dimensionColumns.filter(c => !columnNames.has(c));
  if (missingDimensions.length > 0) {
    analysis.error =
      `Dimension column(s) not found on ${qualified(config)}: ${missingDimensions.join(', ')}`;
    return { analysis, context: null, fingerprint };
  }

  let matchKeyColumns: string[] = [];
  let matchMethod: 'UNIQUE_KEY' | 'SIMILARITY' = 'SIMILARITY';

  if (config.matchStrategy !== 'SIMILARITY') {
    if (config.matchKeyColumns.length > 0) {
      const unknown = config.matchKeyColumns.filter(c => !columnNames.has(c));
      if (unknown.length > 0) {
        analysis.error = `Configured match columns not found on ${qualified(config)}: ${unknown.join(', ')}`;
        return { analysis, context: null, fingerprint };
      }
      matchKeyColumns = config.matchKeyColumns;
      matchMethod = 'UNIQUE_KEY';
    } else {
      const suggestion = suggestMatchKey(keys, dimensionColumns);
      if (suggestion) {
        matchKeyColumns = suggestion.matchColumns;
        matchMethod = 'UNIQUE_KEY';
      } else if (config.matchStrategy === 'UNIQUE_KEY') {
        analysis.error =
          `No unique key containing any of ${dimensionColumns.join(', ')} exists on ` +
          `${qualified(config)}. ` +
          'Pin match columns explicitly or switch this table to similarity matching.';
        return { analysis, context: null, fingerprint };
      }
    }
  }

  const classes = classifyColumns(columns, dimensionColumns, matchKeyColumns, config.columnConfig, keys);
  const udtMap: Record<string, string> = {};
  for (const column of columns) udtMap[column.columnName] = column.udtName;

  const compareColumns = comparableColumns(classes);
  const changeColumns = copiedColumns(classes);

  const primary = keys.find(k => k.isPrimary);
  const orderColumns = primary ? primary.columns : [];

  if (forUpdate) {
    for (const values of [baseValues, newValues]) {
      await client.query(
        `SELECT 1 FROM ${quoteIdent(schema)}.${quoteIdent(table)} ` +
          `WHERE ${dimensionPredicate(dimensionColumns)} FOR UPDATE`,
        values
      );
    }
  }

  let baseRows: Row[];
  let targetRows: Row[];
  try {
    baseRows = await fetchRows(client, schema, table, dimensionColumns, baseValues, orderColumns);
    targetRows = await fetchRows(client, schema, table, dimensionColumns, newValues, orderColumns);
  } catch (error: any) {
    if (error?.code === '22P02') {
      analysis.error =
        `Dimension value is not valid for ${qualified(config)} ` +
        `(${dimensionColumns.join(', ')}) ` +
        `(${error.message})`;
      return { analysis, context: null, fingerprint };
    }
    throw error;
  }

  if (baseRows.length > MAX_ROWS_PER_TABLE || targetRows.length > MAX_ROWS_PER_TABLE) {
    analysis.error =
      `${qualified(config)} has more than ${MAX_ROWS_PER_TABLE} rows for this dimension value. ` +
      'Narrow the group or raise the limit deliberately.';
    return { analysis, context: null, fingerprint };
  }

  analysis.baseRowCount = baseRows.length;
  analysis.targetRowCount = targetRows.length;
  analysis.matchMethod = matchMethod;
  analysis.matchKeyColumns = matchKeyColumns;

  const originalOf = new Map<Row, Row>();
  const danglingOf = new Map<Row, string[]>();
  const projectedBaseRows = baseRows.map(row => {
    const projected = projectRow(row, config.fkRemap, idMap, udtMap);
    originalOf.set(projected.row, row);
    if (projected.dangling.length > 0) danglingOf.set(projected.row, projected.dangling);
    return projected.row;
  });

  let pairing;
  try {
    pairing =
      matchMethod === 'UNIQUE_KEY'
        ? pairByKey(projectedBaseRows, targetRows, matchKeyColumns, udtMap)
        : pairByMutualBestMatch(projectedBaseRows, targetRows, compareColumns, udtMap);
  } catch (error: any) {
    analysis.error = error.message;
    return { analysis, context: null, fingerprint };
  }

  if (matchMethod === 'SIMILARITY') {
    analysis.warnings.push(
      keys.length === 0
        ? 'No unique key on this table — rows were matched by column similarity.'
        : 'No unique key contains the dimension column — rows were matched by column similarity.'
    );
  }

  const identityColumns = identityColumnsFor(keys, matchKeyColumns, dimensionColumns, compareColumns);

  const context: TableContext = {
    config,
    columns,
    keys,
    classes,
    udtMap,
    identityColumns,
    matchKeyColumns,
    baseRowsByDiffId: new Map(),
    targetRowsByDiffId: new Map(),
    pairedByDiffId: new Map(),
    changedColumnsByDiffId: new Map(),
    primaryKeyColumn: primary && primary.columns.length === 1 ? primary.columns[0] : null,
    originalBaseByDiffId: new Map(),
  };

  const pkColumn = context.primaryKeyColumn;
  const tableKey = qualified(config);

  const rememberParent = (baseRow: Row, newParentValue: unknown) => {
    if (!pkColumn) return;
    const original = originalOf.get(baseRow) || baseRow;
    idMap.set(idMapKey(tableKey, original[pkColumn], udtMap[pkColumn]), newParentValue);
  };

  const pushDiff = (diff: RowDiff) => {
    const existing = analysis.diffs.find(d => d.diffId === diff.diffId);
    if (existing) {
      existing.multiplicity++;
      return;
    }
    analysis.diffs.push(diff);
  };

  for (const { base, target } of pairing.pairs) {
    const changed = changeColumns.filter(c => !valuesEqual(base[c], target[c], udtMap[c]));
    const diffId = makeDiffId(
      schema,
      table,
      changed.length === 0 ? 'NO_CHANGE' : 'UPDATE',
      'target',
      identityColumns,
      target,
      udtMap
    );

    if (changed.length === 0) {
      analysis.counts.noChange++;
      rememberParent(base, pkColumn ? target[pkColumn] : undefined);
      pushDiff({
        diffId,
        operation: 'NO_CHANGE',
        schema,
        table,
        ambiguous: false,
        multiplicity: 1,
        sourceHash: rowHash(base, compareColumns, udtMap),
        targetHash: rowHash(target, compareColumns, udtMap),
        rowPreview: previewRow(target, columns),
      });
      continue;
    }

    analysis.counts.update++;
    rememberParent(base, pkColumn ? target[pkColumn] : undefined);
    context.pairedByDiffId.set(diffId, { base, target });
    context.originalBaseByDiffId.set(diffId, originalOf.get(base) || base);
    context.changedColumnsByDiffId.set(diffId, changed);
    context.baseRowsByDiffId.set(diffId, base);
    context.targetRowsByDiffId.set(diffId, target);

    pushDiff({
      diffId,
      operation: 'UPDATE',
      schema,
      table,
      ambiguous: false,
      multiplicity: 1,
      sourceHash: rowHash(base, compareColumns, udtMap),
      targetHash: rowHash(target, compareColumns, udtMap),
      columnDiffs: changed.map(c => ({
        column: c,
        oldValue: displayValue(target[c]),
        newValue: displayValue(base[c]),
        udt: udtMap[c],
      })),
      rowPreview: previewRow(target, columns),
    });
  }

  for (const base of pairing.unpairedBase) {
    const diffId = makeDiffId(schema, table, 'INSERT', 'base', identityColumns, base, udtMap);
    analysis.counts.insert++;
    context.baseRowsByDiffId.set(diffId, base);
    context.originalBaseByDiffId.set(diffId, originalOf.get(base) || base);

    const original = originalOf.get(base) || base;
    if (pkColumn) {
      rememberParent(base, pendingRef(tableKey, original[pkColumn], udtMap[pkColumn]));
    }

    const dangling = danglingOf.get(base);
    pushDiff({
      diffId,
      operation: 'INSERT',
      schema,
      table,
      ambiguous: pairing.ambiguousBase.has(base),
      ambiguityReason: pairing.ambiguityReasons.get(base),
      ...(dangling ? { danglingRefs: dangling } : {}),
      multiplicity: 1,
      sourceHash: rowHash(base, compareColumns, udtMap),
      targetHash: null,
      rowPreview: previewRow(base, columns),
    });
  }

  for (const target of pairing.unpairedTarget) {
    const diffId = makeDiffId(schema, table, 'DELETE', 'target', identityColumns, target, udtMap);
    analysis.counts.delete++;
    context.targetRowsByDiffId.set(diffId, target);
    pushDiff({
      diffId,
      operation: 'DELETE',
      schema,
      table,
      ambiguous: pairing.ambiguousTarget.has(target),
      ambiguityReason: pairing.ambiguityReasons.get(target),
      multiplicity: 1,
      sourceHash: null,
      targetHash: rowHash(target, compareColumns, udtMap),
      rowPreview: previewRow(target, columns),
    });
  }

  return { analysis, context, fingerprint };
};

const previewRow = (row: Row, columns: ColumnInfo[]): Record<string, unknown> => {
  const preview: Record<string, unknown> = {};
  for (const column of columns) {
    preview[column.columnName] = displayValue(row[column.columnName]);
  }
  return preview;
};

export const runAnalysis = async (
  client: PoolClient,
  group: ConfigGroup,
  database: string,
  cloud: string,
  baseValues: string[],
  newValues: string[],
  options: { forUpdate?: boolean } = {}
): Promise<AnalyzeOutput> => {
  const tables = [...group.tables].sort((a, b) => a.position - b.position);
  const analyses: TableAnalysis[] = [];
  const contexts = new Map<string, TableContext>();
  const fingerprints: string[] = [];

  const idMap = new Map<string, unknown>();

  for (const table of tables) {
    const { analysis, context, fingerprint } = await analyzeTable(
      client,
      table,
      baseValues,
      newValues,
      !!options.forUpdate,
      idMap
    );
    analyses.push(analysis);
    if (context) contexts.set(qualified(table), context);
    if (fingerprint) fingerprints.push(fingerprint);
  }

  const foreignKeys = await introspection.getForeignKeys(client, tables.map(qualified));

  const totals = analyses.reduce(
    (acc, t) => ({
      insert: acc.insert + t.counts.insert,
      update: acc.update + t.counts.update,
      delete: acc.delete + t.counts.delete,
      noChange: acc.noChange + t.counts.noChange,
    }),
    { insert: 0, update: 0, delete: 0, noChange: 0 }
  );

  const totalDiffs = totals.insert + totals.update + totals.delete;
  const warnings: string[] = [];

  if (totalDiffs > MAX_DIFFS_TOTAL) {
    throw new Error(
      `This analysis produced ${totalDiffs} actionable rows, above the ${MAX_DIFFS_TOTAL} limit. ` +
        'Split the group into smaller ones.'
    );
  }

  if (analyses.every(t => t.baseRowCount === 0 && !t.error)) {
    warnings.push(
      `No rows exist anywhere under the base dimension ${describeDimension(group.dimensionColumns, baseValues)} — there is nothing to replicate.`
    );
  }

  if (analyses.every(t => t.targetRowCount === 0 && !t.error)) {
    warnings.push(
      `The new dimension ${describeDimension(group.dimensionColumns, newValues)} has no rows yet — every change will be an insert.`
    );
  }

  const analysisToken = crypto
    .createHash('sha256')
    .update(
      [
        group.id,
        group.updatedAt || group.createdAt,
        database,
        cloud,
        ...baseValues,
        ...newValues,
        ...fingerprints,
      ].join('|')
    )
    .digest('hex');

  return {
    idMap,
    result: {
      groupId: group.id,
      groupName: group.name,
      database,
      cloud,
      baseValues,
      newValues,
      analysisToken,
      tables: analyses,
      totals,
      warnings,
      analyzedAt: new Date().toISOString(),
    },
    contexts,
    foreignKeys,
  };
};
