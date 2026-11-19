/**
 * Cosmos Columns: the pure rules behind the API (no I/O).
 *
 * Adds columns to cosmos.txn_historic + cosmos.txn_live from the tables the txn ETL
 * (control-center etl/ride_hailing_txn_job.R) already reads. Each added column becomes one row
 * in cosmos.etl_column_config; the ETL's registry_loader.R reads LIVE rows and appends the
 * column to the matching source query. The SQL expression built here must stay identical to
 * column_config_expr() in registry_loader.R.
 */
export const CONFIG_TABLE = 'cosmos.etl_column_config';
export const TARGET = { db: 'cosmos', table: 'txn_historic', liveTable: 'txn_live' } as const;
export const MAX_BATCH = 30;
/** DDL runs ON CLUSTER '{cluster}': each ClickHouse server fills in its own cluster name (same as control-center etl/ddl). */
export const ON_CLUSTER = "ON CLUSTER '{cluster}'";

/** A table the txn ETL reads (TXN_EXT_REGISTRY in registry_loader.R). `agg`: its query groups by id with argMax(…, updated_at). */
export interface EtlSource {
  etlConfigName: string;
  db: string;
  table: string;
  agg: boolean;
}

const source = (etlConfigName: string, db: string, table: string, agg = false): EtlSource => ({ etlConfigName, db, table, agg });

/**
 * The tables this tool offers. Which of their columns the ETL already writes is not kept here:
 * cosmos.etl_column_config (BUILT_IN + LIVE rows) is the source of truth for that.
 */
export const SOURCES: EtlSource[] = [
  source('BAP_BOOKING', 'atlas_app', 'booking'),
  source('BAP_PERSON', 'atlas_app', 'person', true),
  source('BAP_SEARCH_REQUEST', 'atlas_app', 'search_request'),
  source('BPP_BOOKING', 'atlas_driver_offer_bpp', 'booking'),
  source('BPP_CANCELLATION', 'atlas_driver_offer_bpp', 'booking_cancellation_reason'),
  source('BPP_FARE_PARAMETERS', 'atlas_driver_offer_bpp', 'fare_parameters'),
  source('BPP_FEEDBACK', 'atlas_driver_offer_bpp', 'feedback'),
  source('BPP_PERSON', 'atlas_driver_offer_bpp', 'person', true),
  source('BPP_RATING', 'atlas_driver_offer_bpp', 'rating'),
  source('BPP_RIDE', 'atlas_driver_offer_bpp', 'ride', true),
  source('BPP_SEARCH_REQUEST', 'atlas_driver_offer_bpp', 'search_request'),
  source('BPP_SEARCH_TRY', 'atlas_driver_offer_bpp', 'search_try'),
];

export type TransformType = 'RAW' | 'TO_FLAG' | 'HAS_VALUE';
export const TRANSFORMS: TransformType[] = ['RAW', 'TO_FLAG', 'HAS_VALUE'];

export const ALLOWED_TARGET_TYPES = [
  'Nullable(String)', 'LowCardinality(Nullable(String))',
  'Nullable(Int32)', 'Nullable(Int64)', 'Nullable(UInt8)', 'Nullable(UInt16)', 'Nullable(UInt32)',
  'Nullable(Float64)', 'Nullable(DateTime)', 'Nullable(Date)',
  'UInt8 DEFAULT 0', 'UInt32 DEFAULT 0',
];

const NAME_RE = /^[a-z][a-z0-9_]{1,62}$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const SECRET_RE = /(otp|password|passwd|token|secret|hash|salt|encrypted|api_key|private_key)/;
const LOWCARD_RE = /(status|type|category|mode|variant|tag|reason|code|behaviour|bearer|unit|currency|source|tier|_os|manufacturer|model|version|initiated_by|cancelled_by|settlement)/;

/** ClickHouse type without Nullable/LowCardinality wrappers or a DEFAULT clause. */
export function baseType(chType: string): string {
  let t = chType.replace(/\s+DEFAULT\s+.*$/i, '').trim();
  for (;;) {
    const m = t.match(/^(?:Nullable|LowCardinality)\((.*)\)$/);
    if (!m) return t;
    t = m[1];
  }
}

export type ColumnKind = 'text' | 'number' | 'time' | 'array' | 'other';
export function kindOf(sourceType: string): ColumnKind {
  const b = baseType(sourceType);
  if (b.startsWith('Array(')) return 'array';
  if (/^(U?Int\d+|Float\d+|Decimal)/.test(b)) return 'number';
  if (/^(DateTime|Date)/.test(b)) return 'time';
  if (b === 'String' || b.startsWith('FixedString')) return 'text';
  return 'other';
}

/** Secrets can never be enabled or added. */
export const isSecret = (column: string, sourceType: string) => kindOf(sourceType) === 'text' && SECRET_RE.test(column);

/** Transforms offered for a source column. Booleans arrive from Postgres as 'true'/'false' strings, so TO_FLAG is offered on text. */
export function transformsFor(sourceType: string): TransformType[] {
  const k = kindOf(sourceType);
  if (k === 'text') return ['RAW', 'TO_FLAG', 'HAS_VALUE'];
  if (k === 'time') return ['RAW', 'HAS_VALUE'];
  return ['RAW'];
}

/** Target types offered, recommended first. Only types that survive the ETL's CSV → R → CSV path and never narrow. */
export function targetTypesFor(column: string, sourceType: string, transform: TransformType): string[] {
  if (transform === 'HAS_VALUE') return ['UInt8 DEFAULT 0'];
  if (transform === 'TO_FLAG') return ['Nullable(UInt8)', 'UInt8 DEFAULT 0'];
  const b = baseType(sourceType);
  switch (kindOf(sourceType)) {
    case 'number':
      if (/^U?Int(8|16|32)$/.test(b)) return ['Nullable(Int32)', 'Nullable(Int64)', 'Nullable(Float64)'];
      if (/^U?Int64$/.test(b)) return ['Nullable(Int64)', 'Nullable(Float64)'];
      return ['Nullable(Float64)'];
    case 'time':
      return b === 'Date' ? ['Nullable(Date)'] : ['Nullable(DateTime)'];
    case 'text':
      return LOWCARD_RE.test(column) ? ['LowCardinality(Nullable(String))', 'Nullable(String)'] : ['Nullable(String)', 'LowCardinality(Nullable(String))'];
    default:
      return ['Nullable(String)'];
  }
}

const PREFIX: Record<string, string> = { BPP_PERSON: 'drv_', BAP_PERSON: 'bap_rider_', BAP_BOOKING: 'bap_', BAP_SEARCH_REQUEST: 'bap_' };
export function suggestName(etlConfigName: string, column: string, transform: TransformType): string {
  if (transform === 'TO_FLAG') return `is_${column.replace(/^(is|has)_/, '')}`;
  if (transform === 'HAS_VALUE') return `has_${column.replace(/_id$/, '').replace(/^has_/, '')}`;
  return `${PREFIX[etlConfigName] ?? 'bpp_'}${column}`;
}

/** Per-row expression on the source table ('' for RAW). Must match column_config_expr() in registry_loader.R. */
export function transformLogic(column: string, transform: TransformType): string {
  if (transform === 'TO_FLAG') return `multiIf(${column} = 'true', 1, ${column} = 'false', 0, NULL)`;
  if (transform === 'HAS_VALUE') return `if(ifNull(toString(${column}), '') != '', 1, 0)`;
  return '';
}

/** What the ETL selects: the logic (or the column), wrapped in argMax for grouped source queries. */
export function selectExpr(source: EtlSource, column: string, transform: TransformType): string {
  const expr = transformLogic(column, transform) || column;
  return source.agg ? `argMax(${expr}, updated_at)` : expr;
}

export interface BatchItem {
  etlConfigName: string;
  sourceColumn: string;
  sourceColumnType: string;
  transformType: TransformType;
  targetColumnName: string;
  targetColumnType: string;
  /** Which of txn_historic / txn_live get the column; both when left out. */
  targetTables?: string[];
}

export const TARGET_TABLES: string[] = [TARGET.table, TARGET.liveTable];
export const tablesOf = (item: BatchItem): string[] => (item.targetTables?.length ? TARGET_TABLES.filter(t => item.targetTables!.includes(t)) : TARGET_TABLES);

/**
 * Problems with a batch that need no database: one list per item (empty = fine) plus batch-level problems.
 * `takenNames` = names already used in the target tables or by other config columns.
 */
export function validateBatch(items: BatchItem[], sources: EtlSource[], takenNames: Set<string>): { items: string[][]; batch: string[] } {
  const batch: string[] = [];
  if (items.length === 0) batch.push('The batch is empty.');
  if (items.length > MAX_BATCH) batch.push(`A batch can hold at most ${MAX_BATCH} columns.`);
  const counts = new Map<string, number>();
  items.forEach(i => counts.set(i.targetColumnName, (counts.get(i.targetColumnName) ?? 0) + 1));

  const perItem = items.map(item => {
    const p: string[] = [];
    const source = sources.find(s => s.etlConfigName === item.etlConfigName);
    const name = item.targetColumnName;
    if (!source) p.push(`${item.etlConfigName} is not a txn ETL source.`);
    if (!IDENT_RE.test(item.sourceColumn)) p.push('Source column is not a valid identifier.');
    else if (source && isSecret(item.sourceColumn, item.sourceColumnType)) p.push(`${item.sourceColumn} cannot be added.`);
    if (!NAME_RE.test(name)) p.push('Name: lowercase letters, digits and _, starting with a letter.');
    else if (takenNames.has(name)) p.push(`NAME_TAKEN: "${name}" already exists in cosmos.txn_historic / txn_live or another config column.`);
    if ((counts.get(name) ?? 0) > 1) p.push(`Two columns in this batch are both named "${name}".`);
    if (item.targetTables && (item.targetTables.length === 0 || item.targetTables.some(t => !TARGET_TABLES.includes(t)))) p.push(`Target tables must be ${TARGET_TABLES.join(' and/or ')}.`);
    if (/^num_/.test(name)) p.push('num_ names are reserved for ETL counters.');
    if (!transformsFor(item.sourceColumnType).includes(item.transformType)) p.push(`${item.transformType} is not available for a ${item.sourceColumnType} column.`);
    else if (!targetTypesFor(item.sourceColumn, item.sourceColumnType, item.transformType).includes(item.targetColumnType)) p.push(`Type ${item.targetColumnType} is not offered for this column.`);
    if (/^is_/.test(name) && !item.targetColumnType.includes('UInt8')) p.push('is_ names must hold 1/0 (the ETL turns text is_* columns into 1/0).');
    return p;
  });
  return { items: perItem, batch };
}

/** One ALTER per selected target table, holding every batch column that goes to that table. */
export function alterStatements(items: BatchItem[]): Array<{ table: string; items: BatchItem[]; sql: string }> {
  return TARGET_TABLES.map(table => ({ table, items: items.filter(i => tablesOf(i).includes(table)) }))
    .filter(a => a.items.length > 0)
    .map(({ table, items: list }) => {
      return {
        table, items: list,
        sql: `ALTER TABLE ${TARGET.db}.${table} ${ON_CLUSTER}\n` +
          list.map(i => `    ADD COLUMN IF NOT EXISTS \`${i.targetColumnName}\` ${i.targetColumnType}`).join(',\n'),
      };
    });
}

/** Plain-text preview of what a batch writes and runs (config rows, ALTERs, ETL lines). */
export function previewBatch(items: BatchItem[], sources: EtlSource[]): { configRows: string; alter: string; etl: string } {
  const src = (i: BatchItem) => sources.find(s => s.etlConfigName === i.etlConfigName)!;
  const q = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const configRows = `-- One LIVE row per column; target_tables lists the tables it goes to. Written on Apply, after the ALTERs below worked.\n` +
    `INSERT INTO ${CONFIG_TABLE}\n  (batch_id, source_db, source_table, source_column, source_column_type, etl_config_name,\n` +
    `   target_db, target_tables, target_column, target_column_type, transform_type, transform_logic, select_expr, status)\nVALUES\n` +
    items.map(i => `  (${['<batch_id>', src(i).db, src(i).table, i.sourceColumn, i.sourceColumnType, i.etlConfigName, TARGET.db, `[${tablesOf(i).map(q).join(', ')}]`, i.targetColumnName, i.targetColumnType,
      i.transformType, transformLogic(i.sourceColumn, i.transformType), selectExpr(src(i), i.sourceColumn, i.transformType), 'LIVE'].map(v => (v === '<batch_id>' || v.startsWith('[') ? v : q(v))).join(', ')})`).join(',\n') + ';';
  const alter = `-- Runs first on Apply, after every column passed its checks\n${alterStatements(items).map(a => a.sql).join(';\n\n')};`;
  const byConfig = new Map<string, BatchItem[]>();
  items.forEach(i => byConfig.set(i.etlConfigName, [...(byConfig.get(i.etlConfigName) ?? []), i]));
  const etl = '# registry_loader.R appends each LIVE column to its own source query on every run:\n' +
    [...byConfig.entries()].map(([cfg, list]) => `\n# ${cfg}  (${src(list[0]).db}.${src(list[0]).table}${src(list[0]).agg ? ', query groups by id → argMax' : ''})\n` +
      list.map(i => `${cfg}$txn_custom <- c(${cfg}$txn_custom, list(list(expr = "${selectExpr(src(i), i.sourceColumn, i.transformType).replace(/"/g, '\\"')}", as = "${i.targetColumnName}")))`).join('\n')).join('\n');
  return { configRows, alter, etl };
}
