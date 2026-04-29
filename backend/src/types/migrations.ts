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
  migrationGroup?: string; // label from pathMapping e.g. "BPP Migrations", "BAP Read-Only"
  appliedCount?: number; // count of applied/skipped statements (stripped from response)
}

export interface AnalysisResult {
  success: boolean;
  fromRef: string;
  toRef: string;
  environment: string;
  summary: {
    totalFiles: number;
    totalStatements: number;
    applied: number;
    pending: number;
    manualCheck: number;
    skipped: number;
    errors: number;
  };
  files: MigrationFileResult[];
}

export interface MigrationReplicaConfig {
  name: string;
  label: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  defaultSchema: string;
}

export interface MigrationEnvironmentConfig {
  label: string;
  databases: MigrationReplicaConfig[];
}

export interface PathMapping {
  path: string;
  database: string;
  defaultSchema: string;
  label: string;
}

export interface MigrationsConfig {
  repoPath: string;
  // Optional clone URL — if present, the backend will auto-clone the repo into
  // repoPath on startup (in the background). Allows dropping the K8s init container.
  repoUrl?: string;
  pathMapping: PathMapping[];
}

// State for the background clone task. Migration endpoints gate on this so
// users get a clear "still cloning" message instead of cryptic errors.
export type RepoCloneState = 'NOT_STARTED' | 'CLONING' | 'READY' | 'ERROR';

export interface RepoStatus {
  state: RepoCloneState;
  repoPath: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  message?: string;
}
