import crypto from 'crypto';
import { PoolClient } from 'pg';
import {
  AnalysisResult,
  ColumnClass,
  ColumnInfo,
  ConfigGroup,
  FkLink,
  ForeignKeyInfo,
  GroupTableConfig,
  RowDiff,
  TableAnalysis,
  UniqueKeyInfo,
} from '../../types/configReplicate';
import {
  classifyColumns,
  comparableColumns,
  copiedColumns,
  editableColumns,
  suggestMatchKey,
} from './classify';
import * as introspection from './introspection.service';
import { pairByKey, pairByMutualBestMatch, Row } from './matching';
import { effectiveLinks, parentKeyOf } from './ordering';
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
  editableColumns: Set<string>;
  links: FkLink[];
  referencedKeys: string[][];
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
  idMap: Map<string, unknown>,
  keys: UniqueKeyInfo[],
  links: FkLink[],
  referencedKeys: string[][]
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
    editableColumns: [],
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
  analysis.editableColumns = editableColumns(
    classes,
    new Set(links.flatMap(link => link.columns))
  );

  const originalOf = new Map<Row, Row>();
  const danglingOf = new Map<Row, string[]>();
  const projectedBaseRows = baseRows.map(row => {
    const projected = projectRow(row, links, idMap, udtMap);
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
    editableColumns: new Set(analysis.editableColumns),
    links,
    referencedKeys,
  };

  const tableKey = qualified(config);

  const rememberParent = (
    baseRow: Row,
    newValueOf: (column: string, keyColumns: string[], oldValues: unknown[]) => unknown
  ) => {
    if (referencedKeys.length === 0) return;
    const original = originalOf.get(baseRow) || baseRow;

    for (const keyColumns of referencedKeys) {
      if (keyColumns.some(c => !(c in udtMap))) continue;

      const oldValues = keyColumns.map(c => original[c]);
      if (oldValues.some(v => v === null || v === undefined)) continue;

      idMap.set(
        idMapKey(tableKey, keyColumns, oldValues, keyColumns.map(c => udtMap[c])),
        keyColumns.map(c => newValueOf(c, keyColumns, oldValues))
      );
    }
  };

  // A row that already exists under the new dimension hands children its target
  // id. A row still to be inserted has no id yet, so each column of the key is
  // resolved by how the insert will fill it: a regenerated uuid becomes a
  // sentinel the apply resolves once minted, the dimension becomes the new
  // dimension value, and anything else is copied verbatim and already known.
  const existingParentValue = (target: Row) => (column: string) => target[column];

  const insertedParentValue =
    (base: Row) =>
    (column: string, keyColumns: string[], oldValues: unknown[]): unknown => {
      if (classes[column] === 'GENERATED' && (udtMap[column] || '').toLowerCase() === 'uuid') {
        return pendingRef(
          tableKey,
          column,
          keyColumns,
          oldValues,
          keyColumns.map(c => udtMap[c])
        );
      }

      const dimensionIndex = dimensionColumns.indexOf(column);
      if (dimensionIndex >= 0) return newValues[dimensionIndex];

      return base[column];
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
      rememberParent(base, existingParentValue(target));
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
    rememberParent(base, existingParentValue(target));
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

    rememberParent(base, insertedParentValue(base));

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

interface ResolvedLinks {
  linksByTable: Map<string, FkLink[]>;
  referencedKeysByTable: Map<string, string[][]>;
  linkWarnings: Map<string, string[]>;
}

/**
 * Fills in a link's parent columns (empty means the parent's primary key, which
 * is how groups saved before links existed are read back) and collects, per
 * parent table, every key some child points at — the keys its rows must be
 * registered under so children can find their new parent.
 */
const resolveLinks = (
  tables: GroupTableConfig[],
  keysByTable: Map<string, UniqueKeyInfo[]>
): ResolvedLinks => {
  const linksByTable = new Map<string, FkLink[]>();
  const referencedKeysByTable = new Map<string, string[][]>();
  const linkWarnings = new Map<string, string[]>();
  const present = new Set(tables.map(qualified));

  const warn = (tableKey: string, message: string) => {
    const bucket = linkWarnings.get(tableKey);
    if (bucket) bucket.push(message);
    else linkWarnings.set(tableKey, [message]);
  };

  for (const table of tables) {
    const tableKey = qualified(table);
    const resolved: FkLink[] = [];

    for (const link of effectiveLinks(table)) {
      const parentKey = parentKeyOf(link);

      if (parentKey === tableKey || !present.has(parentKey)) {
        warn(
          tableKey,
          `${link.columns.join(', ')} references ${parentKey}, which is not a table in this group — ` +
            'the reference is left as it is.'
        );
        continue;
      }

      const parentKeys = keysByTable.get(parentKey) || [];
      let parentColumns = link.parentColumns;

      if (parentColumns.length === 0) {
        const primary = parentKeys.find(k => k.isPrimary);
        if (!primary) {
          warn(
            tableKey,
            `${link.columns.join(', ')} references ${parentKey}, which has no primary key. ` +
              'Name the parent columns on the link explicitly.'
          );
          continue;
        }
        parentColumns = primary.columns;
      }

      if (parentColumns.length !== link.columns.length) {
        warn(
          tableKey,
          `${link.columns.join(', ')} references ${parentKey} on ` +
            `${parentColumns.join(', ')} — the two sides must name the same number of columns.`
        );
        continue;
      }

      const unique = parentKeys.some(
        k =>
          k.columns.length === parentColumns.length &&
          k.columns.every(c => parentColumns.includes(c))
      );
      if (!unique) {
        warn(
          tableKey,
          `${parentKey}(${parentColumns.join(', ')}) is not a unique key, so ` +
            `${link.columns.join(', ')} cannot be rewritten to a single new parent.`
        );
        continue;
      }

      resolved.push({ ...link, parentColumns });

      const existing = referencedKeysByTable.get(parentKey) || [];
      const fingerprint = parentColumns.join('\u0000');
      if (!existing.some(k => k.join('\u0000') === fingerprint)) {
        existing.push(parentColumns);
      }
      referencedKeysByTable.set(parentKey, existing);
    }

    linksByTable.set(tableKey, resolved);
  }

  return { linksByTable, referencedKeysByTable, linkWarnings };
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

  const keysByTable = new Map<string, UniqueKeyInfo[]>();
  for (const table of tables) {
    keysByTable.set(
      qualified(table),
      await introspection.getUniqueKeys(client, table.schema, table.table)
    );
  }

  const { linksByTable, referencedKeysByTable, linkWarnings } = resolveLinks(tables, keysByTable);

  for (const table of tables) {
    const tableKey = qualified(table);
    const { analysis, context, fingerprint } = await analyzeTable(
      client,
      table,
      baseValues,
      newValues,
      !!options.forUpdate,
      idMap,
      keysByTable.get(tableKey) || [],
      linksByTable.get(tableKey) || [],
      referencedKeysByTable.get(tableKey) || []
    );
    analysis.warnings.push(...(linkWarnings.get(tableKey) || []));
    analyses.push(analysis);
    if (context) contexts.set(tableKey, context);
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
