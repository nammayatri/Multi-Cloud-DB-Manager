import type { Role } from '../constants/roles';

export interface User {
  id: string; // Aligned with backend (UUID)
  username: string;
  email: string;
  name: string;
  role: Role;
  picture?: string;
}

export interface QueryRequest {
  query: string;
  database: string; // Database name (e.g., 'bpp', 'bap')
  mode: string; // 'both' or specific cloud name
  timeout?: number;
  pgSchema?: string;
  password?: string; // Password for sensitive operations (ALTER/DROP)
  indexCreationPassword?: string; // Unique password for CREATE INDEX on protected tables
  continueOnError?: boolean; // Continue executing remaining statements if one fails
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
  user_id: string; // Aligned with backend (UUID)
  query: string;
  database_name: string; // Database name (e.g., 'bpp', 'bap')
  execution_mode: string; // 'both' or specific cloud name
  [key: string]: any; // Dynamic cloud result fields
  created_at: string;
  username?: string;
  email?: string;
  name?: string;
}

export interface HistoryFilter {
  database?: string; // Database name filter
  user_id?: string; // Filter by specific user (MASTER only)
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
  publicationName?: string;
  subscriptionName?: string;
}

export interface CloudInfo {
  cloudName: string;
  databases: DatabaseInfo[];
}

export interface DatabaseConfiguration {
  primary: CloudInfo;
  secondary: CloudInfo[];
}

// Redis Manager Types
export interface RedisCommandField {
  name: string;
  label: string;
  required: boolean;
  default?: string;
}

export interface RedisCommandDefinition {
  command: string;
  label: string;
  category: string;
  isWrite: boolean;
  fields: RedisCommandField[];
}

export interface RedisCommandRequest {
  command: string;
  args: Record<string, any>;
  cloud: string;
  service?: string; // defaults to 'main' if omitted
}

export interface RedisScanRequest {
  pattern: string;
  cloud: string;
  action: 'preview' | 'delete';
  scanCount?: number;
  service?: string;
}

// Returned by GET /api/redis/configuration — only identifiers, no hosts.
export interface RedisServicePublic {
  name: string;
  label: string;
  primary: { cloudName: string };
  secondary: Array<{ cloudName: string }>;
}

export interface RedisConfiguration {
  services: RedisServicePublic[];
}

export interface RedisCloudResult {
  success: boolean;
  data?: any;
  error?: string;
  duration_ms: number;
}

export interface RedisCommandResponse {
  id: string;
  success: boolean;
  command: string;
  [cloudName: string]: any;
}

export interface RedisScanProgress {
  cloudName: string;
  nodesTotal: number;
  nodesScanned: number;
  keysFound: number;
  keysDeleted: number;
  keys?: string[];
  status: 'scanning' | 'deleting' | 'completed' | 'cancelled' | 'error';
  error?: string;
}

export interface RedisScanResponse {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  action: 'preview' | 'delete';
  pattern: string;
  clouds: Record<string, RedisScanProgress>;
}

// Shudhi (In-Memory Cache Management) Types

// GET /api/shudhi/pods — mirrors Shudhi's PodInfo { podName, sidecarUrl }
export interface ShudhiPodInfo {
  podName: string;
  sidecarUrl: string;
}

// GET /api/shudhi/keys — mirrors Shudhi's key entry
export interface ShudhiKeyEntry {
  keyName: string;
  podName: string;
  keySchema?: any;
  ttlInSeconds?: number;
  registeredAt?: string;
}

// POST /api/shudhi/get — mirrors Shudhi's PodGetReq
export interface ShudhiGetRequest {
  serviceName: string;
  podName: string;
  key: string;
}

// POST /api/shudhi/refresh — mirrors Shudhi's RefreshReq
export interface ShudhiRefreshRequest {
  serviceName: string;
  keyInfix?: string;
}

// POST /api/shudhi/refresh response
export interface ShudhiPodAckResult {
  podName: string;
  success: boolean;
  error?: string;
}

export interface ShudhiRefreshResponse {
  service: string;
  total: number;
  confirmed: number;
  pods: ShudhiPodAckResult[];
}

// GET /api/shudhi/status
export interface ShudhiStatusResponse {
  status: string;
  shudhi: string;
  redis?: boolean;
  app?: boolean;
  message?: string;
}

// System Configs Manager Types (all routes under /api/system-configs)

export type SystemConfigTarget = 'rider' | 'driver';

export interface SystemConfigTargetInfo {
  key: SystemConfigTarget;
  label: string;
  schema: string;
}

// GET /api/system-configs/targets
// configured:false means the backend config file is missing — the panel shows
// a friendly empty state instead of an error.
export interface SystemConfigTargetsResponse {
  configured: boolean;
  targets: SystemConfigTargetInfo[];
}

// GET /api/system-configs/keys
export interface SystemConfigKeysResponse {
  keys: string[];
}

// GET /api/system-configs/config
export interface SystemConfigResponse {
  id: string;
  exists: boolean;
  configValue: string | null;
}

// POST /api/system-configs/validate
export interface SystemConfigValidateResponse {
  valid: boolean;
  errors: string[];
}

// POST /api/system-configs/execute request body
export interface SystemConfigExecuteRequest {
  target: SystemConfigTarget;
  id: string;
  configValue: string;
  password: string;
}

// POST /api/system-configs/execute response.
// verified: 'verified' = applied & read back successfully; 'pending' = the
// dashboard accepted the write but the read replica hasn't caught up yet.
export interface SystemConfigExecuteResponse {
  success: true;
  target: SystemConfigTarget;
  id: string;
  operation: 'UPDATE';
  durationMs: number;
  verified: 'verified' | 'pending';
  oldValue: string | null;
}
