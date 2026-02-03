export interface User {
  id: number;
  username: string;
  email: string;
  name: string;
  role: 'MASTER' | 'USER' | 'READER';
  picture?: string;
}

export interface QueryRequest {
  query: string;
  database: string; // Database name (e.g., 'bpp', 'bap')
  mode: string; // 'both' or specific cloud name
  timeout?: number;
  pgSchema?: string;
}

export interface QueryResult {
  rows: any[];
  fields?: Array<{ name: string; dataTypeID: number }>;
  rowCount: number;
  command: string;
}

export interface StatementResult {
  statement: string;
  success: boolean;
  result?: QueryResult;
  error?: string;
  rowsAffected?: number;
}

export interface CloudResult {
  success: boolean;
  result?: QueryResult;
  results?: StatementResult[];
  error?: string;
  duration_ms: number;
  statementCount?: number;
}

export interface QueryResponse {
  id: string;
  success: boolean;
  [cloudName: string]: any; // Dynamic cloud results (cloud1, cloud2, etc.)
}

export interface QueryExecution {
  id: string;
  user_id: number;
  query: string;
  database_name: string; // Database name (e.g., 'bpp', 'bap')
  execution_mode: string; // 'both' or specific cloud name
  [key: string]: any; // Dynamic cloud result fields
  created_at: string;
  email?: string;
  name?: string;
}

export interface HistoryFilter {
  database?: string; // Database name filter
  success?: boolean;
  limit?: number;
  offset?: number;
  start_date?: string;
  end_date?: string;
}

// Database Configuration Types
export interface DatabaseInfo {
  name: string;
  label: string;
  cloudType: string;
  schemas: string[];
  defaultSchema: string;
}

export interface CloudInfo {
  cloudName: string;
  databases: DatabaseInfo[];
}

export interface DatabaseConfiguration {
  primary: CloudInfo;
  secondary: CloudInfo[];
}
