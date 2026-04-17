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
