import crypto from 'crypto';
import { PoolClient } from 'pg';
import DatabasePools from '../../config/database';
import logger from '../../utils/logger';
import {
  ApplyRequest,
  ApplyResult,
  ConfigGroup,
  DiffSelection,
  DriftDetail,
  ForeignKeyInfo,
  RunItemRecord,
  RunStatus,
} from '../../types/configReplicate';
import { AnalyzeOutput, runAnalysis, TableContext } from './analyze.service';
import runsService from './runs.service';
import {
  BuildContext,
  buildDelete,
  buildInsert,
  buildUpdate,
} from './sqlBuilder';
import { displayValue } from './values';
import { isPendingRef, pendingRef, resolvePending } from './projection';

const APPLY_STATEMENT_TIMEOUT_MS = parseInt(
  process.env.CONFIG_REPLICATE_STATEMENT_TIMEOUT_MS || '30000',
  10
);
const LOCK_TIMEOUT_MS = parseInt(process.env.CONFIG_REPLICATE_LOCK_TIMEOUT_MS || '5000', 10);

export class DriftError extends Error {
  public readonly details: DriftDetail[];

  constructor(details: DriftDetail[]) {
    super('The data changed since this analysis was produced. Re-analyze and review again.');
    this.name = 'DriftError';
    this.details = details;
  }
}

const qualified = (schema: string, table: string) => `${schema}.${table}`;

const verifySelection = (
  analysis: AnalyzeOutput,
  selections: DiffSelection[],
  analysisToken: string
): void => {
  if (analysis.result.analysisToken !== analysisToken) {
    throw new DriftError([
      {
        diffId: '*',
        reason: 'SCHEMA_CHANGED',
        detail: 'The table structure changed since the analysis was produced.',
      },
    ]);
  }

  const fresh = new Map<string, { operation: string; sourceHash: string | null; targetHash: string | null }>();
  for (const table of analysis.result.tables) {
    for (const diff of table.diffs) {
      fresh.set(diff.diffId, {
        operation: diff.operation,
        sourceHash: diff.sourceHash,
        targetHash: diff.targetHash,
      });
    }
  }

  const drift: DriftDetail[] = [];

  for (const selection of selections) {
    const current = fresh.get(selection.diffId);

    if (!current) {
      drift.push({ diffId: selection.diffId, reason: 'ROW_VANISHED' });
      continue;
    }

    if (current.operation !== selection.operation) {
      drift.push({
        diffId: selection.diffId,
        reason: 'OPERATION_CHANGED',
        detail: `Now a ${current.operation}, was a ${selection.operation}`,
      });
      continue;
    }

    if (
      current.sourceHash !== selection.sourceHash ||
      current.targetHash !== selection.targetHash
    ) {
      drift.push({ diffId: selection.diffId, reason: 'ROW_MODIFIED' });
    }
  }

  if (drift.length > 0) throw new DriftError(drift);
};

interface PlannedStatement extends RunItemRecord {}

const buildContextFor = (
  context: TableContext,
  newValues: string[]
): BuildContext => {
  const dimensionColumns = context.config.dimensionColumns;
  const newDimensionValues: Record<string, string> = {};
  dimensionColumns.forEach((column, i) => {
    newDimensionValues[column] = newValues[i];
  });

  return {
    schema: context.config.schema,
    table: context.config.table,
    columns: context.columns,
    classes: context.classes,
    columnAllowlist: new Set(context.columns.map(c => c.columnName)),
    dimensionColumns,
    newDimensionValues,
  };
};

const mintGeneratedValues = (
  analysis: AnalyzeOutput,
  selectedByTable: Map<string, DiffSelection[]>
): { generated: Map<string, Record<string, unknown>>; minted: Map<string, unknown> } => {
  const generated = new Map<string, Record<string, unknown>>();
  const minted = new Map<string, unknown>();

  for (const [tableKey, context] of analysis.contexts) {
    const pkColumn = context.primaryKeyColumn;

    for (const selection of selectedByTable.get(tableKey) || []) {
      if (selection.operation !== 'INSERT') continue;
      const baseRow = context.baseRowsByDiffId.get(selection.diffId);
      if (!baseRow) continue;

      const values: Record<string, unknown> = {};
      for (const column of context.columns) {
        if (context.classes[column.columnName] !== 'GENERATED') continue;
        // Minted here even when the column has a gen_random_uuid() default: the
        // id has to be known before the INSERT runs so children in the group can
        // point at it, and letting the database generate it would also diverge
        // across clouds. Non-uuid generated columns (serial, identity) keep
        // their database default -- nothing references them.
        if (column.udtName.toLowerCase() !== 'uuid') continue;
        values[column.columnName] = crypto.randomUUID();
      }
      generated.set(selection.diffId, values);

      if (pkColumn && values[pkColumn] !== undefined) {
        const original = context.originalBaseByDiffId.get(selection.diffId) || baseRow;
        minted.set(
          pendingRef(tableKey, original[pkColumn], context.udtMap[pkColumn]),
          values[pkColumn]
        );
      }
    }
  }

  return { generated, minted };
};

const resolveRemapped = (
  context: TableContext,
  row: Record<string, unknown>,
  minted: Map<string, unknown>
): Record<string, unknown> => {
  const values: Record<string, unknown> = {};
  for (const column of Object.keys(context.config.fkRemap || {})) {
    const value = row[column];
    if (!isPendingRef(value)) continue;
    values[column] = resolvePending(value, minted);
  }
  return values;
};

const buildPlan = (
  analysis: AnalyzeOutput,
  selections: DiffSelection[],
  newValues: string[]
): PlannedStatement[] => {
  const selectedByTable = new Map<string, DiffSelection[]>();
  for (const selection of selections) {
    for (const [tableKey, context] of analysis.contexts) {
      const known =
        context.baseRowsByDiffId.has(selection.diffId) ||
        context.targetRowsByDiffId.has(selection.diffId);
      if (!known) continue;
      const bucket = selectedByTable.get(tableKey);
      if (bucket) bucket.push(selection);
      else selectedByTable.set(tableKey, [selection]);
    }
  }

  const { generated, minted } = mintGeneratedValues(analysis, selectedByTable);

  const orderedTables = [...analysis.contexts.entries()].sort(
    (a, b) => a[1].config.position - b[1].config.position
  );

  const deletes: PlannedStatement[] = [];
  const inserts: PlannedStatement[] = [];
  const updates: PlannedStatement[] = [];

  for (const [tableKey, context] of [...orderedTables].reverse()) {
    const ctx = buildContextFor(context, newValues);
    for (const selection of selectedByTable.get(tableKey) || []) {
      if (selection.operation !== 'DELETE') continue;
      const targetRow = context.targetRowsByDiffId.get(selection.diffId);
      if (!targetRow) continue;
      const built = buildDelete(ctx, targetRow, context.identityColumns);
      deletes.push({
        schema: context.config.schema,
        table: context.config.table,
        operation: 'DELETE',
        diffId: selection.diffId,
        sql: built.sql,
        params: built.params,
        rowDiff: { removed: previewOf(context, targetRow) },
        rowsAffected: null,
        position: deletes.length,
      });
    }
  }

  for (const [tableKey, context] of orderedTables) {
    const ctx = buildContextFor(context, newValues);
    for (const selection of selectedByTable.get(tableKey) || []) {
      if (selection.operation !== 'INSERT') continue;
      const baseRow = context.baseRowsByDiffId.get(selection.diffId);
      if (!baseRow) continue;

      const remapped = resolveRemapped(context, baseRow, minted);
      const built = buildInsert(
        ctx,
        baseRow,
        generated.get(selection.diffId) || {},
        remapped
      );
      inserts.push({
        schema: context.config.schema,
        table: context.config.table,
        operation: 'INSERT',
        diffId: selection.diffId,
        sql: built.sql,
        params: built.params,
        rowDiff: { inserted: previewOf(context, { ...baseRow, ...remapped }) },
        rowsAffected: null,
        position: inserts.length,
      });
    }
  }

  for (const [tableKey, context] of orderedTables) {
    const ctx = buildContextFor(context, newValues);
    for (const selection of selectedByTable.get(tableKey) || []) {
      if (selection.operation !== 'UPDATE') continue;
      const pair = context.pairedByDiffId.get(selection.diffId);
      const changed = context.changedColumnsByDiffId.get(selection.diffId);
      if (!pair || !changed) continue;

      const remapped = resolveRemapped(context, pair.base, minted);
      const built = buildUpdate(
        ctx,
        pair.base,
        pair.target,
        changed,
        context.identityColumns,
        remapped
      );
      updates.push({
        schema: context.config.schema,
        table: context.config.table,
        operation: 'UPDATE',
        diffId: selection.diffId,
        sql: built.sql,
        params: built.params,
        rowDiff: {
          columns: changed.map(c => ({
            column: c,
            oldValue: displayValue(pair.target[c]),
            newValue: displayValue(
              Object.prototype.hasOwnProperty.call(remapped, c) ? remapped[c] : pair.base[c]
            ),
          })),
        },
        rowsAffected: null,
        position: updates.length,
      });
    }
  }

  return [...deletes, ...inserts, ...updates].map((s, i) => ({ ...s, position: i }));
};

const previewOf = (context: TableContext, row: Record<string, unknown>) => {
  const preview: Record<string, unknown> = {};
  for (const column of context.columns) {
    preview[column.columnName] = displayValue(row[column.columnName]);
  }
  return preview;
};

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Statement timeout after ${ms}ms: ${label}`)), ms)
    ),
  ]);

export const applyReplication = async (
  request: ApplyRequest,
  group: ConfigGroup,
  user: { id: string; username: string }
): Promise<ApplyResult> => {
  const dbPools = DatabasePools.getInstance();
  const pool = dbPools.getPoolByName(request.cloud, request.database);
  if (!pool) {
    throw new Error(`No connection configured for ${request.database} on ${request.cloud}`);
  }

  const startedAt = Date.now();
  let status: RunStatus = 'RUNNING';
  let error: string | undefined;
  let drift: DriftDetail[] | undefined;
  let plan: PlannedStatement[] = [];
  let analysis: AnalyzeOutput | null = null;

  let client: PoolClient | null = null;
  let releaseWithError = false;

  try {
    client = await pool.connect();

    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${APPLY_STATEMENT_TIMEOUT_MS}`);
    await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
    await client.query('SET CONSTRAINTS ALL DEFERRED');

    analysis = await runAnalysis(
      client,
      group,
      request.database,
      request.cloud,
      request.baseValues,
      request.newValues,
      { forUpdate: true }
    );

    verifySelection(analysis, request.selections, request.analysisToken);

    plan = buildPlan(analysis, request.selections, request.newValues);

    for (const statement of plan) {
      const result = await withTimeout(
        client.query(statement.sql, statement.params as any[]),
        APPLY_STATEMENT_TIMEOUT_MS,
        `${statement.operation} ${qualified(statement.schema, statement.table)}`
      );

      statement.rowsAffected = result.rowCount ?? 0;

      if (statement.operation !== 'INSERT' && result.rowCount !== 1) {
        throw new Error(
          `${statement.operation} on ${qualified(statement.schema, statement.table)} ` +
            `affected ${result.rowCount} rows, expected exactly 1`
        );
      }
    }

    await client.query('COMMIT');
    status = 'SUCCEEDED';
  } catch (err: any) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr: any) {
        releaseWithError = true;
        logger.error('Config replicate rollback failed:', rollbackErr);
      }
    }

    if (err instanceof DriftError) {
      status = 'ABORTED';
      drift = err.details;
      error = err.message;
    } else {
      status = 'FAILED';
      error = err.message;
    }

    logger.error('Config replicate apply failed', {
      username: user.username,
      group: group.name,
      status,
      error,
    });
  } finally {
    if (client) client.release(releaseWithError ? true : undefined);
  }

  const applied = status === 'SUCCEEDED' ? plan : plan.map(s => ({ ...s, rowsAffected: null }));

  const totals = {
    inserted: applied.filter(s => s.operation === 'INSERT').length,
    updated: applied.filter(s => s.operation === 'UPDATE').length,
    deleted: applied.filter(s => s.operation === 'DELETE').length,
  };

  const summary = buildSummary(analysis, applied, status);

  const runId = await runsService.record({
    group,
    database: request.database,
    cloud: request.cloud,
    baseValues: request.baseValues,
    newValues: request.newValues,
    status,
    error: error || null,
    summary,
    totals: status === 'SUCCEEDED' ? totals : { inserted: 0, updated: 0, deleted: 0 },
    items: applied,
    durationMs: Date.now() - startedAt,
    user,
  });

  return {
    runId,
    status,
    totals: status === 'SUCCEEDED' ? totals : { inserted: 0, updated: 0, deleted: 0 },
    summary,
    durationMs: Date.now() - startedAt,
    ...(error ? { error } : {}),
    ...(drift ? { drift } : {}),
  };
};

const buildSummary = (
  analysis: AnalyzeOutput | null,
  plan: PlannedStatement[],
  status: RunStatus
): ApplyResult['summary'] => {
  const byTable = new Map<string, ApplyResult['summary'][number]>();

  if (analysis) {
    for (const table of analysis.result.tables) {
      byTable.set(qualified(table.schema, table.table), {
        schema: table.schema,
        table: table.table,
        matchMethod: table.matchMethod,
        inserted: 0,
        updated: 0,
        deleted: 0,
      });
    }
  }

  if (status !== 'SUCCEEDED') return [...byTable.values()];

  for (const statement of plan) {
    const key = qualified(statement.schema, statement.table);
    const entry =
      byTable.get(key) ||
      ({
        schema: statement.schema,
        table: statement.table,
        matchMethod: null,
        inserted: 0,
        updated: 0,
        deleted: 0,
      } as ApplyResult['summary'][number]);

    if (statement.operation === 'INSERT') entry.inserted++;
    else if (statement.operation === 'UPDATE') entry.updated++;
    else entry.deleted++;

    byTable.set(key, entry);
  }

  return [...byTable.values()];
};
