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
  mintsGeneratedValue,
  suggestMatchKey,
} from './classify';
import * as introspection from './introspection.service';
import { pairByKey, pairByMutualBestMatch, Row } from './matching';
import { effectiveLinks, parentKeyOf, topologicalOrder } from './ordering';
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

export interface TableSnapshot {
  config: GroupTableConfig;
  fingerprint: string;
  error?: string;
  columns: ColumnInfo[];
  keys: UniqueKeyInfo[];
  classes: Record<string, ColumnClass>;
  udtMap: Record<string, string>;
  compareColumns: string[];
  changeColumns: string[];
  identityColumns: string[];
  primaryKeyColumn: string | null;
  matchMethod: 'UNIQUE_KEY' | 'SIMILARITY';
  matchKeyColumns: string[];
  baseRows: Row[];
  targetRows: Row[];
}

const unreadable = (
  config: GroupTableConfig,
  fingerprint: string,
  error: string
): TableSnapshot => ({
  config,
  fingerprint,
  error,
  columns: [],
  keys: [],
  classes: {},
  udtMap: {},
  compareColumns: [],
  changeColumns: [],
  identityColumns: [],
  primaryKeyColumn: null,
  matchMethod: 'SIMILARITY',
  matchKeyColumns: [],
  baseRows: [],
  targetRows: [],
});

export const blankAnalysis = (config: GroupTableConfig): TableAnalysis => ({
  schema: config.schema,
  table: config.table,
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
});

/**
 * Everything that reads the database, run once per table. What it returns is fed
 * to diffTable, which is pure and can therefore be replayed until the id map
 * settles -- which is what tables referencing each other in a cycle need.
 */
const loadTable = async (
  client: PoolClient,
  config: GroupTableConfig,
  baseValues: string[],
  newValues: string[],
  forUpdate: boolean,
  keys: UniqueKeyInfo[]
): Promise<TableSnapshot> => {
  const { schema, table } = config;
  const dimensionColumns = config.dimensionColumns;

  const columns = await introspection.getColumns(client, schema, table);
  if (columns.length === 0) {
    return unreadable(config, '', `Table ${qualified(config)} does not exist or is not readable`);
  }

  const fingerprint = `${qualified(config)}=${introspection.schemaFingerprint(columns, keys)}`;

  const columnNames = new Set(columns.map(c => c.columnName));
  const missingDimensions = dimensionColumns.filter(c => !columnNames.has(c));
  if (missingDimensions.length > 0) {
    return unreadable(
      config,
      fingerprint,
      `Dimension column(s) not found on ${qualified(config)}: ${missingDimensions.join(', ')}`
    );
  }

  let matchKeyColumns: string[] = [];
  let matchMethod: 'UNIQUE_KEY' | 'SIMILARITY' = 'SIMILARITY';

  if (config.matchStrategy !== 'SIMILARITY') {
    if (config.matchKeyColumns.length > 0) {
      const unknown = config.matchKeyColumns.filter(c => !columnNames.has(c));
      if (unknown.length > 0) {
        return unreadable(
          config,
          fingerprint,
          `Configured match columns not found on ${qualified(config)}: ${unknown.join(', ')}`
        );
      }
      matchKeyColumns = config.matchKeyColumns;
      matchMethod = 'UNIQUE_KEY';
    } else {
      const suggestion = suggestMatchKey(keys, dimensionColumns);
      if (suggestion) {
        matchKeyColumns = suggestion.matchColumns;
        matchMethod = 'UNIQUE_KEY';
      } else if (config.matchStrategy === 'UNIQUE_KEY') {
        return unreadable(
          config,
          fingerprint,
          `No unique key containing any of ${dimensionColumns.join(', ')} exists on ` +
            `${qualified(config)}. ` +
            'Pin match columns explicitly or switch this table to similarity matching.'
        );
      }
    }
  }

  const classes = classifyColumns(columns, dimensionColumns, matchKeyColumns, config.columnConfig, keys);
  const udtMap: Record<string, string> = {};
  for (const column of columns) udtMap[column.columnName] = column.udtName;

  const compareColumns = comparableColumns(classes);
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
      return unreadable(
        config,
        fingerprint,
        `Dimension value is not valid for ${qualified(config)} ` +
          `(${dimensionColumns.join(', ')}) ` +
          `(${error.message})`
      );
    }
    throw error;
  }

  if (baseRows.length > MAX_ROWS_PER_TABLE || targetRows.length > MAX_ROWS_PER_TABLE) {
    return unreadable(
      config,
      fingerprint,
      `${qualified(config)} has more than ${MAX_ROWS_PER_TABLE} rows for this dimension value. ` +
        'Narrow the group or raise the limit deliberately.'
    );
  }

  return {
    config,
    fingerprint,
    columns,
    keys,
    classes,
    udtMap,
    compareColumns,
    changeColumns: copiedColumns(classes),
    identityColumns: identityColumnsFor(keys, matchKeyColumns, dimensionColumns, compareColumns),
    primaryKeyColumn: primary && primary.columns.length === 1 ? primary.columns[0] : null,
    matchMethod,
    matchKeyColumns,
    baseRows,
    targetRows,
  };
};

/**
 * Pure. Projects this table's base rows against idMapIn, pairs them against the
 * target, and registers the table's own rows into idMapOut. The two maps are
 * kept apart so a settling round never observes its own writes.
 *
 * Diffs are the expensive half -- pushDiff scans what it has already collected --
 * so they are built only on the final round, once the map has stopped moving.
 */
export const diffTable = (
  snapshot: TableSnapshot,
  links: FkLink[],
  referencedKeys: string[][],
  idMapIn: Map<string, unknown>,
  idMapOut: Map<string, unknown>,
  newValues: string[],
  emitDiffs: boolean
): { analysis: TableAnalysis; context: TableContext | null } => {
  const {
    config,
    columns,
    keys,
    classes,
    udtMap,
    compareColumns,
    changeColumns,
    identityColumns,
    primaryKeyColumn,
    matchMethod,
    matchKeyColumns,
    baseRows,
    targetRows,
  } = snapshot;

  const { schema, table } = config;
  const dimensionColumns = config.dimensionColumns;
  const tableKey = qualified(config);

  const columnByName = new Map(columns.map(column => [column.columnName, column]));

  const analysis = blankAnalysis(config);
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
    const projected = projectRow(row, links, idMapIn, udtMap);
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
    return { analysis, context: null };
  }

  if (emitDiffs && matchMethod === 'SIMILARITY') {
    analysis.warnings.push(
      keys.length === 0
        ? 'No unique key on this table — rows were matched by column similarity.'
        : 'No unique key contains the dimension column — rows were matched by column similarity.'
    );
  }

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
    primaryKeyColumn,
    originalBaseByDiffId: new Map(),
    editableColumns: new Set(analysis.editableColumns),
    links,
    referencedKeys,
  };

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

      idMapOut.set(
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
      // Must agree exactly with what apply mints (apply.service.ts), or a child
      // is handed an id the parent never takes.
      const info = columnByName.get(column);
      if (info && classes[column] === 'GENERATED' && mintsGeneratedValue(info, primaryKeyColumn)) {
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
    rememberParent(base, existingParentValue(target));
    if (!emitDiffs) continue;

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
    rememberParent(base, insertedParentValue(base));
    if (!emitDiffs) continue;

    const diffId = makeDiffId(schema, table, 'INSERT', 'base', identityColumns, base, udtMap);
    analysis.counts.insert++;
    context.baseRowsByDiffId.set(diffId, base);
    context.originalBaseByDiffId.set(diffId, originalOf.get(base) || base);

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

  if (emitDiffs) {
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
  }

  return { analysis, context: emitDiffs ? context : null };
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

const MAX_ANALYSIS_ROUNDS = 5;

const idMapFingerprint = (idMap: Map<string, unknown>): string =>
  [...idMap.entries()]
    .map(([key, value]) => `${key}=${(value as unknown[]).map(v => canonical(v)).join(',')}`)
    .sort()
    .join('|');

/**
 * Builds the id map for a group whose links contain a cycle, by replaying the
 * pure half of the analysis until the map stops changing. The first round
 * resolves nothing -- it projects against an empty map -- but registers every
 * table; the second round therefore sees both ends of the cycle. Bounded, since
 * an unstable pairing could otherwise oscillate.
 */
export const settleIdMap = (
  tables: GroupTableConfig[],
  snapshots: Map<string, TableSnapshot>,
  linksByTable: Map<string, FkLink[]>,
  referencedKeysByTable: Map<string, string[][]>,
  newValues: string[]
): Map<string, unknown> => {
  let idMap = new Map<string, unknown>();
  let previous = '';

  for (let round = 0; round < MAX_ANALYSIS_ROUNDS; round++) {
    const next = new Map<string, unknown>();

    for (const table of tables) {
      const tableKey = qualified(table);
      const snapshot = snapshots.get(tableKey);
      if (!snapshot || snapshot.error) continue;

      diffTable(
        snapshot,
        linksByTable.get(tableKey) || [],
        referencedKeysByTable.get(tableKey) || [],
        idMap,
        next,
        newValues,
        false
      );
    }

    const fingerprint = idMapFingerprint(next);
    idMap = next;
    if (fingerprint === previous) break;
    previous = fingerprint;
  }

  return idMap;
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

  const keysByTable = new Map<string, UniqueKeyInfo[]>();
  for (const table of tables) {
    keysByTable.set(
      qualified(table),
      await introspection.getUniqueKeys(client, table.schema, table.table)
    );
  }

  const { linksByTable, referencedKeysByTable, linkWarnings } = resolveLinks(tables, keysByTable);

  const snapshots = new Map<string, TableSnapshot>();
  for (const table of tables) {
    const tableKey = qualified(table);
    snapshots.set(
      tableKey,
      await loadTable(
        client,
        table,
        baseValues,
        newValues,
        !!options.forUpdate,
        keysByTable.get(tableKey) || []
      )
    );
  }

  const cycleWarnings: string[] = [];
  const { cycles } = topologicalOrder(tables);

  // Without a cycle, position order already puts every parent before its child,
  // so the single pass below fills the map as it goes -- exactly as before.
  // With one, no order can, so the map is settled up front by replaying the
  // pure half until it stops changing.
  let idMap = new Map<string, unknown>();

  if (cycles.length > 0) {
    cycleWarnings.push(
      `${cycles[0].join(' → ')} reference each other in a cycle. Their ids are minted ` +
        'before any statement runs and constraints are deferred for the whole apply, ' +
        'so the references still resolve.'
    );
    idMap = settleIdMap(
      tables,
      snapshots,
      linksByTable,
      referencedKeysByTable,
      newValues
    );
  }

  for (const table of tables) {
    const tableKey = qualified(table);
    const snapshot = snapshots.get(tableKey) as TableSnapshot;

    if (snapshot.fingerprint) fingerprints.push(snapshot.fingerprint);

    if (snapshot.error) {
      const analysis = blankAnalysis(table);
      analysis.error = snapshot.error;
      analysis.warnings.push(...(linkWarnings.get(tableKey) || []));
      analyses.push(analysis);
      continue;
    }

    const { analysis, context } = diffTable(
      snapshot,
      linksByTable.get(tableKey) || [],
      referencedKeysByTable.get(tableKey) || [],
      idMap,
      idMap,
      newValues,
      true
    );
    analysis.warnings.push(...(linkWarnings.get(tableKey) || []));
    analyses.push(analysis);
    if (context) contexts.set(tableKey, context);
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
  const warnings: string[] = [...cycleWarnings];

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
