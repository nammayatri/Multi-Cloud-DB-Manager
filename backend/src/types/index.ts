import { QueryResult } from 'pg';

export interface User {
  id: string;
  email: string;
  name: string;
  picture?: string;
  created_at: Date;
  last_login?: Date;
  role?: string;
  is_active?: boolean;
}

export interface QueryExecution {
  id: string;
  user_id: string;
  query: string;
  database_name: string; // Database name (e.g., 'bpp', 'bap')
  execution_mode: string; // 'both' or specific cloud name
  [key: string]: any; // Dynamic cloud result fields
  created_at: Date;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface QueryRequest {
  query: string;
  database: string; // Database name (e.g., 'bpp', 'bap')
  mode: string; // 'both' or specific cloud name
  timeout?: number;
  pgSchema?: string;
  password?: string; // Password for sensitive operations (ALTER/DROP)
  continueOnError?: boolean; // Continue executing remaining statements if one fails
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
  results?: StatementResult[]; // Multiple statement results
  error?: string;
  duration_ms: number;
  statementCount?: number;
}

export interface QueryResponse {
  id: string;
  success: boolean;
  [cloudName: string]: any; // Dynamic cloud results (cloud1, cloud2, etc.)
}

export interface WebSocketMessage {
  type: 'query_start' | 'query_progress' | 'query_complete' | 'query_error';
  executionId: string;
  data: any;
}

export interface QueryHistoryFilter {
  user_id?: string;
  schema?: string;
  success?: boolean;
  limit?: number;
  offset?: number;
  start_date?: Date;
  end_date?: Date;
}

// JSON Configuration Types
export interface DatabaseConfigJson {
  name: string;            // e.g., "db1", "db2", "analytics"
  label: string;           // UI-friendly name: "Database 1"
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  schemas: string[];       // Pre-configured schemas
  defaultSchema: string;
  publicationName?: string;  // Logical replication publication name (primary only)
  subscriptionName?: string; // Logical replication subscription name (secondary only)
}

export interface CloudConfigJson {
  cloudName: string;       // e.g., "cloud1", "cloud2", "azure"
  db_configs: DatabaseConfigJson[];
}

export interface SlackConfigJson {
  botToken: string;
  channels: string[];  // Channel IDs or names (e.g., "#replication-alerts")
}

export interface DatabasesConfigJson {
  primary: CloudConfigJson;
  secondary: CloudConfigJson[];
  history: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  slack?: SlackConfigJson;
}

// Internal Configuration Types (used by DatabasePools)
export interface DatabaseInfo {
  cloudType: string;
  databaseName: string;
  label: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  schemas: string[];
  defaultSchema: string;
  publicationName?: string;
  subscriptionName?: string;
}

export interface CloudConfiguration {
  primaryCloud: string;
  primaryDatabases: DatabaseInfo[];
  secondaryClouds: string[];
  secondaryDatabases: { [cloudName: string]: DatabaseInfo[] };
}

export interface SchemaInfo {
  databaseName: string;
  cloudType: string;
  label: string;
  schemas: string[];
  defaultSchema: string;
}

declare global {
  namespace Express {
    interface User {
      id: string;
      username: string;
      email: string;
      name: string;
      picture?: string;
      role?: string;
    }
  }
}
