export type ColumnClass =
  | 'DIMENSION'
  | 'MATCH_KEY'
  | 'GENERATED'
  | 'TIMESTAMP'
  | 'COPIED'
  | 'IGNORED';

export type MatchStrategy = 'AUTO' | 'UNIQUE_KEY' | 'SIMILARITY';
export type MatchMethod = 'UNIQUE_KEY' | 'SIMILARITY';
export type DiffOperation = 'INSERT' | 'UPDATE' | 'DELETE' | 'NO_CHANGE';
export type ActionableOperation = 'INSERT' | 'UPDATE' | 'DELETE';
export type RunStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ABORTED';

export interface ColumnInfo {
  columnName: string;
  ordinalPosition: number;
  dataType: string;
  udtName: string;
  isNullable: boolean;
  columnDefault: string | null;
  isIdentity: boolean;
  isGenerated: boolean;
}

export interface UniqueKeyInfo {
  name: string;
  columns: string[];
  isPrimary: boolean;
}

export interface GroupTableConfig {
  id?: string;
  schema: string;
  table: string;
  dimensionColumns: string[];
  position: number;
  matchStrategy: MatchStrategy;
  matchKeyColumns: string[];
  columnConfig: Record<string, ColumnClass>;
  fkRemap: Record<string, string>;
}

export interface ConfigGroup {
  id: string;
  name: string;
  description: string | null;
  dimensionColumns: string[];
  createdBy: string | null;
  createdByUsername?: string | null;
  createdAt: string;
  updatedAt: string | null;
  tables: GroupTableConfig[];
}

export interface ConfigGroupSummary {
  id: string;
  name: string;
  description: string | null;
  dimensionColumns: string[];
  tableCount: number;
  createdByUsername: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface GroupInput {
  name: string;
  description?: string;
  dimensionColumns: string[];
  tables: GroupTableConfig[];
}

export interface ColumnDiff {
  column: string;
  oldValue: unknown;
  newValue: unknown;
  udt: string;
}

export interface RowDiff {
  diffId: string;
  operation: DiffOperation;
  schema: string;
  table: string;
  ambiguous: boolean;
  ambiguityReason?: string;
  danglingRefs?: string[];
  multiplicity: number;
  sourceHash: string | null;
  targetHash: string | null;
  columnDiffs?: ColumnDiff[];
  rowPreview: Record<string, unknown>;
}

export interface TableAnalysis {
  schema: string;
  table: string;
  position: number;
  matchMethod: MatchMethod | null;
  matchKeyColumns: string[];
  dimensionColumns: string[];
  baseRowCount: number;
  targetRowCount: number;
  counts: { insert: number; update: number; delete: number; noChange: number };
  diffs: RowDiff[];
  warnings: string[];
  error?: string;
}

export interface AnalysisResult {
  groupId: string;
  groupName: string;
  database: string;
  cloud: string;
  baseValues: string[];
  newValues: string[];
  analysisToken: string;
  tables: TableAnalysis[];
  totals: { insert: number; update: number; delete: number; noChange: number };
  warnings: string[];
  analyzedAt: string;
}

export interface DiffSelection {
  diffId: string;
  operation: ActionableOperation;
  sourceHash: string | null;
  targetHash: string | null;
}

export interface DriftDetail {
  diffId: string;
  reason: 'ROW_VANISHED' | 'OPERATION_CHANGED' | 'ROW_MODIFIED' | 'SCHEMA_CHANGED';
  detail?: string;
}

export interface ApplyResult {
  runId: string;
  status: RunStatus;
  totals: { inserted: number; updated: number; deleted: number };
  summary: Array<{
    schema: string;
    table: string;
    matchMethod: MatchMethod | null;
    inserted: number;
    updated: number;
    deleted: number;
  }>;
  durationMs: number;
  error?: string;
  drift?: DriftDetail[];
}

export interface TableMeta {
  columns: ColumnInfo[];
  uniqueKeys: UniqueKeyInfo[];
  missingDimensionColumns: string[];
  hasDimensionColumn: boolean;
  suggestedMatchKey: { name: string; columns: string[] } | null;
  suggestedClassification: Record<string, ColumnClass>;
}

export interface RunSummaryRecord {
  id: string;
  groupId: string | null;
  groupName: string;
  databaseName: string;
  cloudName: string;
  baseValues: string[];
  newValues: string[];
  status: RunStatus;
  appliedByUsername: string | null;
  rowsInserted: number;
  rowsUpdated: number;
  rowsDeleted: number;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
  finishedAt: string | null;
}

export const tableKeyOf = (t: { schema: string; table: string }): string =>
  `${t.schema}.${t.table}`;

export const describeDimension = (columns: string[], values: string[]): string =>
  columns.map((c, i) => `${c}=${values[i] ?? ''}`).join(', ');
