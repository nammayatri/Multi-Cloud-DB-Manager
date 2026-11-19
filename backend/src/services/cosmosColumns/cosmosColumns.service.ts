/**
 * Cosmos Columns: adds columns to cosmos.txn_historic and/or cosmos.txn_live from the tables the
 * txn ETL already reads. All state lives in cosmos.etl_column_config (append-only; the newest
 * row per column is its state). Apply = checks on real data → one ALTER per target table →
 * LIVE config rows; the ETL fills the columns on its next run.
 */
import { randomUUID } from 'crypto';
import ClickHouseClientManager from '../../config/clickhouse';
import { ClickHouseUserError } from '../../utils/clickhouse-errors';
import { Role } from '../../constants/roles';
import logger from '../../utils/logger';
import {
  CONFIG_TABLE, ON_CLUSTER, SOURCES, TARGET, BatchItem, EtlSource, TransformType,
  alterStatements, baseType, isSecret, kindOf, previewBatch, selectExpr,
  suggestName, tablesOf, targetTypesFor, transformLogic, transformsFor, validateBatch,
} from './columnRules';

type Status = 'BUILT_IN' | 'HELPER' | 'ENABLED' | 'DISABLED' | 'DRAFT' | 'LIVE' | 'DEPRECATED' | 'DISCARDED';
/** Rows that put a source column in the config and take its target name: written by the ETL (BUILT_IN, LIVE),
 * read but not written (HELPER: join keys, inputs to computed columns), switched off (DEPRECATED), and DRAFT
 * rows left by earlier versions of this tool. A new column may reuse none of their names. */
const IN_CONFIG: Status[] = ['BUILT_IN', 'HELPER', 'LIVE', 'DEPRECATED', 'DRAFT'];

export interface ConfigRow {
  batch_id: string;
  source_db: string;
  source_table: string;
  source_column: string;
  source_column_type: string;
  etl_config_name: string;
  target_db: string;
  target_tables: string[];
  target_column: string;
  target_column_type: string;
  transform_type: TransformType;
  transform_logic: string;
  select_expr: string;
  status: Status;
  created_at: string;
  inserted_at: string;
}

export interface ApplyStep { label: string; ok: boolean; error?: string; columns?: Array<{ name: string; ok: boolean; error?: string }> }
/** What one column ended up as: the tables it was added to, and its LIVE row in the config table. */
export interface AddedColumn { column: string; source: string; tables: string[]; configTable: string; status: 'LIVE' }
export interface ApplyResult { batchId: string; applied: boolean; steps: ApplyStep[]; undone?: string; added?: AddedColumn[] }

const REVIEWER_ROLES: Role[] = [Role.MASTER, Role.ADMIN, Role.CKH_MANAGER];
const SAMPLE_ROWS = 100000;
const sources = SOURCES;

/** Reviewers: on COSMOS_COLUMNS_REVIEWERS (comma-separated emails) and MASTER / ADMIN / CKH_MANAGER. */
export function accessFor(user?: Express.User): { allowed: boolean; reason?: string } {
  const list = (process.env.COSMOS_COLUMNS_REVIEWERS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!user) return { allowed: false, reason: 'Not signed in.' };
  if (!user.role || !REVIEWER_ROLES.includes(user.role)) return { allowed: false, reason: `Requires one of: ${REVIEWER_ROLES.join(', ')}.` };
  if (list.length === 0) return { allowed: false, reason: 'COSMOS_COLUMNS_REVIEWERS is not configured.' };
  if (!list.includes(user.email.toLowerCase())) return { allowed: false, reason: `${user.email} is not on COSMOS_COLUMNS_REVIEWERS.` };
  return { allowed: true };
}

function ch(): ClickHouseClientManager {
  const m = ClickHouseClientManager.getInstance();
  if (!m) throw new ClickHouseUserError('ClickHouse is not configured for this DB Manager.');
  return m;
}

const sqlStr = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const isMissingTable = (err: any) => /UNKNOWN_TABLE|Unknown table|doesn't exist|does not exist/i.test(String(err?.message ?? err));
const tableMissingError = () => new ClickHouseUserError(`${CONFIG_TABLE} does not exist yet. Create it with control-center etl/ddl/etl_column_config.sql.`);
/** ClickHouse DateTime64(3) literal for "now", always after `after` so a newer state sorts after the older one. */
function stamp(after?: string): string {
  let t = Date.now();
  if (after) t = Math.max(t, Date.parse(after.replace(' ', 'T') + 'Z') + 1);
  return new Date(t).toISOString().replace('T', ' ').replace('Z', '');
}

export function sourceByName(etlConfigName: string): EtlSource {
  const s = sources.find(x => x.etlConfigName === etlConfigName);
  if (!s) throw new ClickHouseUserError(`${etlConfigName} is not a txn ETL source.`);
  return s;
}

/** Newest row per column for the txn target. `ready` = the config table exists. */
async function readState(): Promise<{ ready: boolean; rows: ConfigRow[] }> {
  try {
    const rows = await ch().query<ConfigRow>(`
      SELECT * FROM ${CONFIG_TABLE}
      WHERE target_db = ${sqlStr(TARGET.db)} AND hasAny(target_tables, [${sqlStr(TARGET.table)}, ${sqlStr(TARGET.liveTable)}])
      ORDER BY inserted_at DESC
      LIMIT 1 BY source_db, source_table, source_column, target_column`);
    return { ready: true, rows };
  } catch (err) {
    if (isMissingTable(err)) return { ready: false, rows: [] };
    throw err;
  }
}

async function sourceColumns(list: EtlSource[]): Promise<Array<{ db: string; table: string; name: string; type: string }>> {
  const pairs = list.map(s => `(${sqlStr(s.db)}, ${sqlStr(s.table)})`).join(', ');
  return ch().query(`SELECT database AS db, table, name, type FROM system.columns WHERE (database, table) IN (${pairs})`);
}

async function targetColumns(): Promise<Map<string, Map<string, string>>> {
  const rows = await ch().query<{ table: string; name: string; type: string }>(`
    SELECT table, name, type FROM system.columns
    WHERE database = ${sqlStr(TARGET.db)} AND table IN (${sqlStr(TARGET.table)}, ${sqlStr(TARGET.liveTable)})`);
  const out = new Map<string, Map<string, string>>([[TARGET.table, new Map()], [TARGET.liveTable, new Map()]]);
  rows.forEach(r => out.get(r.table)?.set(r.name, r.type));
  return out;
}

const inConfig = (rows: ConfigRow[], s: EtlSource, col: string) =>
  rows.some(r => r.source_db === s.db && r.source_table === s.table && r.source_column === col && r.target_column !== '' && IN_CONFIG.includes(r.status));
const isEnabled = (rows: ConfigRow[], s: EtlSource, col: string) =>
  rows.some(r => r.source_db === s.db && r.source_table === s.table && r.source_column === col && r.target_column === '' && r.status === 'ENABLED');

/** All source columns minus those already in the config table, split into enabled (addable) and disabled; with what the form needs. */
export async function listColumns(etlConfigName: string) {
  const s = sourceByName(etlConfigName);
  const [state, cols] = await Promise.all([readState(), sourceColumns([s])]);
  const candidates = cols.filter(c => !inConfig(state.rows, s, c.name));
  const describe = (c: { name: string; type: string }) => ({
    name: c.name,
    type: c.type,
    kind: kindOf(c.type),
    transforms: transformsFor(c.type).map(t => ({
      transform: t,
      suggestedName: suggestName(s.etlConfigName, c.name, t),
      targetTypes: targetTypesFor(c.name, c.type, t),
    })),
  });
  return {
    configTableReady: state.ready,
    /** false = ClickHouse has no such table, which is not the same as "nothing left to enable" */
    sourceFound: cols.length > 0,
    source: { etlConfigName: s.etlConfigName, db: s.db, table: s.table, agg: s.agg },
    enabled: candidates.filter(c => isEnabled(state.rows, s, c.name) && !isSecret(c.name, c.type)).map(describe),
    disabled: candidates.filter(c => !isEnabled(state.rows, s, c.name)).map(c => ({
      name: c.name,
      type: c.type,
      locked: isSecret(c.name, c.type),
      hint: isSecret(c.name, c.type) ? 'secret · can never be enabled' : '',
    })),
  };
}

/** The 12 sources with how many columns are enabled / still disabled. */
export async function listSources() {
  const [state, cols] = await Promise.all([readState(), sourceColumns(sources)]);
  return {
    configTableReady: state.ready,
    target: TARGET,
    sources: sources.map(s => {
      const candidates = cols.filter(c => c.db === s.db && c.table === s.table && !inConfig(state.rows, s, c.name));
      const enabled = candidates.filter(c => isEnabled(state.rows, s, c.name) && !isSecret(c.name, c.type)).length;
      return { etlConfigName: s.etlConfigName, db: s.db, table: s.table, enabled, disabled: candidates.length - enabled };
    }),
  };
}

function baseRow(item: BatchItem, s: EtlSource, batchId: string, status: Status, insertedAt: string): ConfigRow {
  return {
    batch_id: batchId,
    source_db: s.db,
    source_table: s.table,
    source_column: item.sourceColumn,
    source_column_type: item.sourceColumnType,
    etl_config_name: s.etlConfigName,
    target_db: TARGET.db,
    target_tables: tablesOf(item),
    target_column: item.targetColumnName,
    target_column_type: item.targetColumnType,
    transform_type: item.transformType,
    transform_logic: transformLogic(item.sourceColumn, item.transformType),
    select_expr: selectExpr(s, item.sourceColumn, item.transformType),
    status,
    created_at: insertedAt,
    inserted_at: insertedAt,
  };
}

async function insertRows(rows: ConfigRow[]): Promise<void> {
  try {
    await ch().insert(CONFIG_TABLE, rows as unknown as Array<Record<string, unknown>>);
  } catch (err) {
    if (isMissingTable(err)) throw tableMissingError();
    throw err;
  }
}

/** Enable or disable a raw column (the whitelist). */
export async function setEnabled(etlConfigName: string, column: string, enabled: boolean, user: string): Promise<void> {
  const s = sourceByName(etlConfigName);
  const [state, cols] = await Promise.all([readState(), sourceColumns([s])]);
  const col = cols.find(c => c.name === column);
  if (!col) throw new ClickHouseUserError(`${s.db}.${s.table}.${column} does not exist in ClickHouse.`);
  if (inConfig(state.rows, s, column)) throw new ClickHouseUserError(`${column} is already in ${CONFIG_TABLE}.`);
  if (enabled && isSecret(column, col.type)) throw new ClickHouseUserError(`${column} looks like a secret and can never be enabled.`);
  const now = stamp();
  await insertRows([{
    ...baseRow({ etlConfigName, sourceColumn: column, sourceColumnType: col.type, transformType: 'RAW', targetColumnName: '', targetColumnType: '' }, s, '', enabled ? 'ENABLED' : 'DISABLED', now),
    select_expr: '',
  }]);
}

async function takenNames(state: ConfigRow[], target: Map<string, Map<string, string>>): Promise<Set<string>> {
  const names = new Set<string>([...target.get(TARGET.table)!.keys(), ...target.get(TARGET.liveTable)!.keys()]);
  state.filter(r => r.target_column && IN_CONFIG.includes(r.status)).forEach(r => names.add(r.target_column));
  return names;
}

/** Checks that need ClickHouse: source column still there with the same type; values fit the target type; flags really are 'true'/'false'. */
async function dataChecks(items: BatchItem[]): Promise<string[][]> {
  const bySource = new Map<string, Map<string, string>>();
  const cols = await sourceColumns([...new Set(items.map(i => i.etlConfigName))].map(sourceByName));
  cols.forEach(c => { const k = `${c.db}.${c.table}`; if (!bySource.has(k)) bySource.set(k, new Map()); bySource.get(k)!.set(c.name, c.type); });

  return Promise.all(items.map(async item => {
    const s = sourceByName(item.etlConfigName);
    const actual = bySource.get(`${s.db}.${s.table}`)?.get(item.sourceColumn);
    if (!actual) return [`SOURCE_MISSING: ${s.db}.${s.table}.${item.sourceColumn} is not in ClickHouse (sync it with Column Sync first).`];
    if (actual !== item.sourceColumnType) return [`SOURCE_TYPE_CHANGED: ${item.sourceColumn} is now ${actual}, was ${item.sourceColumnType}.`];
    const target = baseType(item.targetColumnType);
    const value = transformLogic(item.sourceColumn, item.transformType) || item.sourceColumn;
    const lostExpr = target === 'String' ? '0' : `countIf(isNotNull(v) AND isNull(accurateCastOrNull(v, ${sqlStr(target)})))`;
    const flagExpr = item.transformType === 'TO_FLAG' ? `countIf(isNotNull(c) AND toString(c) NOT IN ('true', 'false'))` : '0';
    try {
      const [r] = await ch().query<{ lost: string; not_flag: string }>(`
        SELECT ${lostExpr} AS lost, ${flagExpr} AS not_flag
        FROM (SELECT ${item.sourceColumn} AS c, ${value} AS v FROM ${s.db}.${s.table} LIMIT ${SAMPLE_ROWS})`);
      const p: string[] = [];
      if (Number(r?.not_flag) > 0) p.push(`NOT_A_FLAG: ${r.not_flag} recent values of ${item.sourceColumn} are not 'true'/'false'.`);
      if (Number(r?.lost) > 0) p.push(`CAST_LOSS: ${r.lost} recent values don't fit ${item.targetColumnType}.`);
      return p;
    } catch (err: any) {
      return [`EXPR_INVALID: ${String(err?.message ?? err).slice(0, 200)}`];
    }
  }));
}

/** All checks for a batch: rules first (no DB), then data. Returns per-item problems + batch problems. */
export async function checkBatch(items: BatchItem[]): Promise<{ items: string[][]; batch: string[]; ok: boolean }> {
  const [state, target] = await Promise.all([readState(), targetColumns()]);
  const taken = await takenNames(state.rows, target);
  const rules = validateBatch(items, sources, taken);
  const itemProblems = rules.items.map((p, i) => {
    const s = sources.find(x => x.etlConfigName === items[i].etlConfigName);
    return s && inConfig(state.rows, s, items[i].sourceColumn) ? [...p, `${items[i].sourceColumn} is already in ${CONFIG_TABLE}.`] : p;
  });
  const batch = [...rules.batch, ...(state.ready ? [] : [tableMissingError().message])];
  const data = itemProblems.every(p => p.length === 0) && batch.length === 0 ? await dataChecks(items) : items.map(() => []);
  const merged = itemProblems.map((p, i) => [...p, ...data[i]]);
  return { items: merged, batch, ok: batch.length === 0 && merged.every(p => p.length === 0) };
}

export const preview = (items: BatchItem[]) => previewBatch(items, sources);

async function missingOnReplicas(table: string, items: BatchItem[]): Promise<string[]> {
  const names = items.map(i => sqlStr(i.targetColumnName)).join(', ');
  const where = `database = ${sqlStr(TARGET.db)} AND table = ${sqlStr(table)} AND name IN (${names})`;
  let rows: Array<{ host: string; name: string; type: string }>;
  try {
    rows = await ch().query(`SELECT hostName() AS host, name, type FROM clusterAllReplicas('{cluster}', system.columns) WHERE ${where}`);
  } catch (err: any) {
    logger.warn('clusterAllReplicas unavailable, verifying on this node only', { error: err?.message });
    rows = await ch().query(`SELECT hostName() AS host, name, type FROM system.columns WHERE ${where}`);
  }
  const hosts = [...new Set(rows.map(r => r.host))];
  if (hosts.length === 0) return items.map(i => i.targetColumnName);
  return items.flatMap(i => hosts
    .filter(h => !rows.some(r => r.host === h && r.name === i.targetColumnName && r.type === i.targetColumnType.replace(/\s+DEFAULT\s+.*$/i, '')))
    .map(h => `${i.targetColumnName} on ${h}`));
}

/** Where a running Apply is: steps finished out of all steps, and the one running now. Read by the page while Apply runs. */
export interface ApplyProgress { done: number; total: number; label: string }
const progress = new Map<string, ApplyProgress>();
export const applyProgress = (applyId: string): ApplyProgress | null => progress.get(applyId) ?? null;

/** Reports each step as it starts; forgets the run a minute after it ends. */
function tracker(applyId: string | undefined, total: number) {
  let done = -1;
  return {
    step(label: string) { done += 1; if (applyId) progress.set(applyId, { done, total, label }); },
    end() { if (applyId) setTimeout(() => progress.delete(applyId), 60_000).unref?.(); },
  };
}
/** Checks + one ALTER per target table + LIVE rows. */
const applySteps = (items: BatchItem[]) => 2 + new Set(items.flatMap(tablesOf)).size;

/**
 * Apply in one go: checks → ALTER each target table (historic, then live), verified on every replica →
 * one LIVE row per column in the config table. The columns exist before their rows go LIVE, so the ETL
 * never sees a LIVE column the tables lack; nothing is written to the config table unless every ALTER worked.
 */
export async function applyColumns(items: BatchItem[], user: string, applyId?: string): Promise<ApplyResult> {
  const track = tracker(applyId, applySteps(items));
  const batchId = `b-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`;
  const steps: ApplyStep[] = [];
  try {
    track.step(`Checking ${items.length} column${items.length === 1 ? '' : 's'}`);
    const check = await checkBatch(items);
    steps.push({
      label: `Each of the ${items.length} columns: source exists with the saved type, name free, expression runs, values fit the type`,
      ok: check.ok,
      error: check.ok ? undefined : [...check.batch, 'Nothing was changed.'].join(' '),
      columns: items.map((i, n) => ({ name: i.targetColumnName, ok: check.items[n].length === 0, error: check.items[n].join(' ') || undefined })),
    });
    if (!check.ok) return { batchId, applied: false, steps };

    // All or nothing: if a later step fails, drop the (still empty) columns this apply added, so Apply can simply be run again.
    const before = await targetColumns();
    const altered: string[] = [];
    const undo = async (): Promise<string | undefined> => {
      const notes: string[] = [];
      for (const table of altered) {
        const added = items.filter(i => tablesOf(i).includes(table) && !before.get(table)!.has(i.targetColumnName));
        if (!added.length) continue;
        try {
          await ch().exec(`ALTER TABLE ${TARGET.db}.${table} ${ON_CLUSTER}\n` + added.map(i => `    DROP COLUMN IF EXISTS \`${i.targetColumnName}\``).join(',\n'));
          notes.push(`Dropped the ${added.length} empty column${added.length === 1 ? '' : 's'} this apply added to ${TARGET.db}.${table}.`);
        } catch (e: any) {
          notes.push(`Could not drop the columns this apply added to ${TARGET.db}.${table} (${e?.message}). They are empty; drop them by hand, then Apply again.`);
        }
      }
      return notes.join(' ') || undefined;
    };

    for (const { table, items: list, sql } of alterStatements(items)) {
      track.step(`Adding the column${list.length === 1 ? '' : 's'} to ${TARGET.db}.${table}`);
      const label = `ALTER ${TARGET.db}.${table}: add ${list.length} column${list.length === 1 ? '' : 's'}, verified on every replica`;
      altered.push(table);   // before exec: a failed ALTER may still have reached some replicas
      try {
        await ch().exec(sql);
        const missing = await missingOnReplicas(table, list);
        if (missing.length) throw new Error(`REPLICA_NOT_UPDATED: ${missing.join(', ')}`);
        steps.push({ label, ok: true });
      } catch (err: any) {
        steps.push({ label, ok: false, error: String(err?.message ?? err).slice(0, 300) });
        return { batchId, applied: false, steps, undone: await undo() };
      }
    }

    track.step(`Adding the columns to ${CONFIG_TABLE} as LIVE`);
    const configLabel = `Insert ${items.length} LIVE row${items.length === 1 ? '' : 's'} into ${CONFIG_TABLE}`;
    try {
      const now = stamp();
      await insertRows(items.map(i => baseRow(i, sourceByName(i.etlConfigName), batchId, 'LIVE', now)));
      steps.push({ label: configLabel, ok: true });
    } catch (err: any) {
      steps.push({ label: configLabel, ok: false, error: `CONFIG_WRITE_FAILED: ${err?.message}` });
      return { batchId, applied: false, steps, undone: await undo() };
    }
    logger.info('Cosmos columns applied', { batchId, user, columns: items.map(i => i.targetColumnName) });
    return {
      batchId, applied: true, steps,
      added: items.map(i => {
        const s = sourceByName(i.etlConfigName);
        return { column: i.targetColumnName, source: `${s.db}.${s.table}.${i.sourceColumn}`, tables: tablesOf(i).map(t => `${TARGET.db}.${t}`), configTable: CONFIG_TABLE, status: 'LIVE' as const };
      }),
    };
  } finally {
    track.end();
  }
}

/** Batches with their columns (newest state per column). */
export async function listBatches() {
  const state = await readState();
  const byBatch = new Map<string, ConfigRow[]>();
  state.rows.filter(r => r.batch_id && r.target_column).forEach(r => byBatch.set(r.batch_id, [...(byBatch.get(r.batch_id) ?? []), r]));
  const batches = [...byBatch.entries()].map(([id, rows]) => {
    const statuses = new Set(rows.map(r => r.status));
    const status = statuses.has('DRAFT') ? 'DRAFT' : statuses.has('LIVE') ? 'LIVE' : statuses.has('DEPRECATED') ? 'DEPRECATED' : 'DISCARDED';
    return {
      id, status,
      createdAt: rows[0].created_at,
      insertedAt: rows.reduce((m, r) => (r.inserted_at > m ? r.inserted_at : m), ''),
      columns: rows.map(r => ({
        targetColumnName: r.target_column, targetColumnType: r.target_column_type, source: `${r.source_db}.${r.source_table}.${r.source_column}`,
        targetTables: r.target_tables,
        etlConfigName: r.etl_config_name, transformType: r.transform_type, status: r.status,
      })),
    };
  }).filter(b => b.status !== 'DISCARDED').sort((a, b) => b.insertedAt.localeCompare(a.insertedAt));
  return { configTableReady: state.ready, batches };
}

async function restate(filter: (r: ConfigRow) => boolean, status: Status, user: string, notFound: string): Promise<number> {
  const state = await readState();
  if (!state.ready) throw tableMissingError();
  const rows = state.rows.filter(filter);
  if (rows.length === 0) throw new ClickHouseUserError(notFound);
  const now = stamp(rows.reduce((m, r) => (r.inserted_at > m ? r.inserted_at : m), ''));
  await insertRows(rows.map(r => ({ ...r, status, inserted_at: now })));
  logger.info(`Cosmos columns ${status}`, { user, columns: rows.map(r => r.target_column) });
  return rows.length;
}

/** The ETL stops filling the column; the column and its data stay in the tables. */
export const deprecateColumn = (targetColumnName: string, user: string) =>
  restate(r => r.target_column === targetColumnName && r.status === 'LIVE', 'DEPRECATED', user, `${targetColumnName} is not a LIVE config column.`);
