export interface MigrationStatement {
  sql: string;
  type: 'DDL' | 'DML' | 'OTHER';
  operation: string;
  objectName: string;
  status: 'applied' | 'pending' | 'manual_check' | 'error' | 'skipped';
  details: string;
  verificationQuery?: string;
  rollbackSql?: string;
}

export interface MigrationFileResult {
  path: string;
  folder: string;
  filename: string;
  status: 'applied' | 'pending' | 'partial' | 'manual_check' | 'error';
  content: string;
  statements: MigrationStatement[];
  targetDatabase?: string;
  migrationGroup?: string;
  appliedCount?: number;
}

export interface AnalysisResult {
  success: boolean;
  fromRef: string;
  toRef: string;
  environment: string;
  summary: {
    totalFilesInDiff?: number;
    totalFiles: number;
    fullyAppliedFiles?: number;
    totalStatements: number;
    applied: number;
    pending: number;
    manualCheck: number;
    skipped: number;
    errors: number;
  };
  files: MigrationFileResult[];
}

export interface MigrationsConfigResponse {
  environments: Record<string, { label: string; databases: Array<{ name: string; label: string }> }>;
  pathMapping: Array<{ path: string; database: string; defaultSchema: string; label: string }>;
  repoPath: string;
}

export interface RefsResponse {
  branches: string[];
  tags: string[];
}

export type LiteStatementType = 'DDL' | 'NON_DDL';

export interface LiteStatement {
  sql: string;
  type: LiteStatementType;
  operation: string;
  objectName: string;
  /** Schema this statement targets, or null when unqualified (runs under search_path). */
  schema: string | null;
  /** Requires password re-verification to run (DROP, ALTER DROP/RENAME/TYPE, ...). */
  dangerous: boolean;
  /**
   * Why this statement is dangerous, when the reason is not obvious from the
   * SQL alone (e.g. it depends on what the rest of the diff does).
   */
  dangerousReason?: string;
}

export type LiteFileKind = 'DDL' | 'NON_DDL' | 'MIXED';

export interface LiteDiffFile {
  path: string;
  directory: string;
  filename: string;
  statementCount: number;
  ddlCount: number;
  nonDdlCount: number;
  dangerousCount: number;
  /** Distinct schemas named by this file's statements, sorted. */
  schemas: string[];
  kind: LiteFileKind;
  statements: LiteStatement[];
  sql: string;
}

export interface LiteDiffDirectory {
  directory: string;
  statementCount: number;
  ddlCount: number;
  files: LiteDiffFile[];
}

export interface LiteDiffResult {
  success: boolean;
  owner: string;
  repo: string;
  base: string;
  head: string;
  totalFiles: number;
  totalStatements: number;
  totalDdlStatements: number;
  totalDangerousStatements: number;
  directories: LiteDiffDirectory[];
}
