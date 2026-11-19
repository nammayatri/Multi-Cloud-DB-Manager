// Cosmos Columns: add columns to cosmos.txn_historic + txn_live from the tables the txn ETL reads.

export type TransformType = 'RAW' | 'TO_FLAG' | 'HAS_VALUE';

export interface CosmosAccess {
  allowed: boolean;
  reason?: string;
}

export interface CosmosSource {
  etlConfigName: string;
  db: string;
  table: string;
  enabled: number;
  disabled: number;
}

export interface CosmosSourcesResponse {
  configTableReady: boolean;
  target: { db: string; table: string; liveTable: string };
  sources: CosmosSource[];
}

export interface TransformOption {
  transform: TransformType;
  suggestedName: string;
  targetTypes: string[];
}

export interface EnabledColumn {
  name: string;
  type: string;
  kind: string;
  transforms: TransformOption[];
}

export interface DisabledColumn {
  name: string;
  type: string;
  locked: boolean;
  hint: string;
}

export interface CosmosColumnsResponse {
  configTableReady: boolean;
  sourceFound: boolean;
  source: { etlConfigName: string; db: string; table: string; agg: boolean };
  enabled: EnabledColumn[];
  disabled: DisabledColumn[];
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

/** A batch item plus what the form needs to offer (transforms and types for its source column). */
export interface CartItem extends BatchItem {
  sourceLabel: string;
  options: TransformOption[];
}

export interface BatchPreview {
  configRows: string;
  alter: string;
  etl: string;
}

export interface BatchCheck {
  items: string[][];
  batch: string[];
  ok: boolean;
}

export interface ApplyStep {
  label: string;
  ok: boolean;
  error?: string;
  columns?: Array<{ name: string; ok: boolean; error?: string }>;
}

/** Where a running Apply is: `done` of `total` steps finished, `label` = the step running now. */
export interface ApplyProgress {
  done: number;
  total: number;
  label: string;
}

/** Where one applied column ended up: the target tables it was added to, and its LIVE row in the config table. */
export interface AddedColumn {
  column: string;
  source: string;
  tables: string[];
  configTable: string;
  status: 'LIVE';
}

export interface ApplyResult {
  batchId: string;
  applied: boolean;
  steps: ApplyStep[];
  undone?: string;
  added?: AddedColumn[];
}

export interface BatchSummary {
  id: string;
  status: 'DRAFT' | 'LIVE' | 'DEPRECATED' | 'DISCARDED';
  createdAt: string;
  insertedAt: string;
  columns: Array<{ targetColumnName: string; targetColumnType: string; source: string; etlConfigName: string; transformType: TransformType; status: string; targetTables: string[] }>;
}
