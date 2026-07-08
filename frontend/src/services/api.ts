import axios from 'axios';
import toast from 'react-hot-toast';
import type { User, QueryRequest, QueryResponse, QueryExecution, HistoryFilter, DatabaseConfiguration } from '../types';
import type { Role } from '../constants/roles';

// @ts-ignore - runtime config loaded from /config.js
const backendUrl = window.__APP_CONFIG__?.BACKEND_URL;
// Use configured URL if valid, otherwise fallback to localhost
const API_BASE_URL = (backendUrl && backendUrl !== 'BACKEND_URL_PLACEHOLDER' && backendUrl !== '')
  ? backendUrl
  : (import.meta.env.VITE_API_URL || 'http://localhost:3000');

// Create axios instance with defaults
const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true, // Send cookies for session
  headers: {
    'Content-Type': 'application/json',
  },
});

// Response interceptor for error handling
let isRedirecting = false;
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const url = error.config?.url || '';
    // Let login/register callers handle their own errors (no redirect, no toast).
    // /auth/me is the session probe: its callers (LoginPage, ConsolePage) decide
    // what to do with a 401 themselves — auto-redirecting here would loop the
    // LoginPage probe (401 → /login → mount → probe → 401 → …).
    const isAuthForm =
      url.includes('/auth/login') ||
      url.includes('/auth/register') ||
      url.includes('/auth/me');

    if (error.response?.status === 401 && !isAuthForm) {
      // Expired session — redirect to login (deduplicated)
      if (!isRedirecting) {
        isRedirecting = true;
        window.location.href = '/login';
      }
    } else if (!isAuthForm) {
      // Show one toast per failed API call. Server messages are crafted to be
      // user-facing, but guard the UX: truncate long ones, and never surface a
      // raw 5xx body (could be an unsanitized internal error).
      const status: number | undefined = error.response?.status;
      const serverMsg: string = (error.response?.data?.error || error.response?.data?.message || '').trim();
      const MAX_TOAST_LEN = 220;
      let msg: string;
      if (serverMsg && (status === undefined || status < 500)) {
        msg = serverMsg.length > MAX_TOAST_LEN ? `${serverMsg.slice(0, MAX_TOAST_LEN - 1)}…` : serverMsg;
      } else if (status && status >= 500) {
        msg = 'Server error — please retry or check the server logs';
      } else {
        msg = 'An unexpected error occurred';
      }
      toast.error(msg);
    }
    return Promise.reject(error);
  }
);

/**
 * The response interceptor above already shows a toast for every failed API
 * call (the server's error message, or a generic fallback). Use this in catch
 * blocks around API calls so only NON-API failures (e.g. runtime errors in a
 * response handler) produce a toast — otherwise the user sees the same error
 * twice.
 */
export const toastNonApiError = (error: unknown, fallback: string) => {
  if (!(error as { isAxiosError?: boolean })?.isAxiosError) {
    toast.error(fallback);
  }
};

// Auth API
export const authAPI = {
  getCurrentUser: async (): Promise<User> => {
    const response = await api.get('/api/auth/me');
    return response.data.user;
  },

  login: async (username: string, password: string): Promise<{ user: User; message: string }> => {
    const response = await api.post('/api/auth/login', { username, password });
    return response.data;
  },

  register: async (username: string, password: string, email: string, name: string): Promise<{ user: User; message: string }> => {
    const response = await api.post('/api/auth/register', { username, password, email, name });
    return response.data;
  },

  logout: async (): Promise<void> => {
    await api.post('/api/auth/logout');
    localStorage.clear();
  },

  listUsers: async (): Promise<{ users: any[] }> => {
    const response = await api.get('/api/auth/users');
    return response.data;
  },

  activateUser: async (username: string): Promise<void> => {
    await api.post('/api/auth/activate', { usernames: [username] });
  },

  deactivateUser: async (username: string): Promise<void> => {
    await api.post('/api/auth/deactivate', { usernames: [username] });
  },

  changeRole: async (username: string, role: Role): Promise<void> => {
    await api.post('/api/auth/change-role', { username, role });
  },

  deleteUser: async (username: string): Promise<void> => {
    await api.post('/api/auth/delete', { username });
  },

  searchUsers: async (q: string): Promise<{ users: { id: string; username: string; name: string; email: string }[] }> => {
    const response = await api.get('/api/auth/users/search', { params: { q, limit: 10 } });
    return response.data;
  },
};

// Query API
export const queryAPI = {
  execute: async (request: QueryRequest): Promise<{ executionId: string; status: string; message: string }> => {
    const response = await api.post('/api/query/execute', request);
    return response.data;
  },

  getStatus: async (executionId: string): Promise<{
    executionId: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    result?: QueryResponse;
    error?: string;
    errorCode?: string;
    progress?: {
      currentStatement: number;
      totalStatements: number;
      currentStatementText?: string;
    };
    startTime: number;
    endTime?: number;
  }> => {
    const response = await api.get(`/api/query/status/${executionId}`);
    return response.data;
  },

  cancel: async (executionId: string): Promise<{ success: boolean; message: string }> => {
    const response = await api.post(`/api/query/cancel/${executionId}`);
    return response.data;
  },

  validate: async (query: string): Promise<{ valid: boolean; error?: string }> => {
    const response = await api.post('/api/query/validate', { query });
    return response.data;
  },
};

// Shared in-flight promise to deduplicate concurrent getConfiguration calls
let configInFlight: Promise<DatabaseConfiguration> | null = null;

// Schema API with caching
export const schemaAPI = {
  // Get full database configuration
  getConfiguration: async (): Promise<DatabaseConfiguration> => {
    const cacheKey = 'database_configuration';
    const cacheTTL = 1000 * 60 * 60;

    // Check cache first
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      try {
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < cacheTTL) {
          return data;
        }
      } catch (e) {
        // Invalid cache, continue to fetch
      }
    }

    // Deduplicate: if a fetch is already in flight, reuse it
    if (configInFlight) {
      return configInFlight;
    }

    // Fetch from API
    configInFlight = api.get('/api/schemas/configuration').then(response => {
      try {
        const existing = localStorage.getItem(cacheKey);
        if (existing) {
          const { data: old } = JSON.parse(existing);
          if (old?.primary?.cloudName !== response.data?.primary?.cloudName) {
            Object.keys(localStorage)
              .filter(k => k.startsWith('schemas_'))
              .forEach(k => localStorage.removeItem(k));
          }
        }
      } catch (_) { }

      localStorage.setItem(cacheKey, JSON.stringify({
        data: response.data,
        timestamp: Date.now()
      }));
      return response.data;
    }).finally(() => {
      configInFlight = null;
    });

    return configInFlight;
  },

  getSchemas: async (database: 'primary' | 'secondary', cloud?: 'aws' | 'gcp'): Promise<{ schemas: string[]; default: string }> => {
    const cacheKey = `schemas_${database}_${cloud ?? 'default'}`;
    const cacheTTL = 1000 * 60 * 60;

    // Check cache first
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      try {
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < cacheTTL) {
          return data;
        }
      } catch (e) {
        // Invalid cache, continue to fetch
      }
    }

    // Fetch from API
    const response = await api.get(`/api/schemas/${database}`, { params: { cloud } });

    // Cache the result
    localStorage.setItem(cacheKey, JSON.stringify({
      data: response.data,
      timestamp: Date.now()
    }));

    return response.data;
  },

  clearCache: () => {
    // Clear all schema caches
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('schemas_') || key === 'database_configuration') {
        localStorage.removeItem(key);
      }
    });
  }
};

// CSV Batch API
export const csvBatchAPI = {
  start: async (request: {
    queryTemplate: string;
    ids: string[];
    database: string;
    pgSchema?: string;
    batchSize?: number;
    sleepMs?: number;
    dryRun?: boolean;
    stopOnError?: boolean;
  }): Promise<{ executionId: string; totalIds: number; uniqueIds: number; totalBatches: number; status: string; message: string }> => {
    const response = await api.post('/api/query/csv-batch', request);
    return response.data;
  },

  getStatus: async (executionId: string): Promise<{
    executionId: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    result?: { csvBatch?: any;[key: string]: any };
    error?: string;
    progress?: { currentStatement: number; totalStatements: number };
    startTime: number;
    endTime?: number;
  }> => {
    const response = await api.get(`/api/query/csv-batch/status/${executionId}`);
    return response.data;
  },

  cancel: async (executionId: string): Promise<{ success: boolean; message: string }> => {
    const response = await api.post(`/api/query/csv-batch/cancel/${executionId}`);
    return response.data;
  },
};

// Replication API
export const replicationAPI = {
  addTables: async (params: {
    tables: Array<{ schema: string; table: string }>;
    database: string;
  }): Promise<{
    success: boolean;
    results: {
      publication: { success: boolean; error?: string };
      subscriptions: Array<{ cloud: string; success: boolean; error?: string }>;
    };
  }> => {
    const response = await api.post('/api/replication/add-tables', params);
    return response.data;
  },
};

// History API
export const historyAPI = {
  getHistory: async (filter?: HistoryFilter): Promise<QueryExecution[]> => {
    const response = await api.get('/api/history', { params: filter });
    return response.data.data;
  },

  getExecutionById: async (id: string): Promise<QueryExecution> => {
    const response = await api.get(`/api/history/${id}`);
    return response.data;
  },
};

// Redis API
export const redisAPI = {
  executeCommand: async (request: any): Promise<any> => {
    const response = await api.post('/api/redis/execute', request);
    return response.data;
  },

  startScan: async (request: any): Promise<{ executionId: string; status: string; message: string }> => {
    const response = await api.post('/api/redis/scan', request);
    return response.data;
  },

  getScanStatus: async (id: string): Promise<any> => {
    const response = await api.get(`/api/redis/scan/${id}`);
    return response.data;
  },

  cancelScan: async (id: string): Promise<any> => {
    const response = await api.post(`/api/redis/scan/${id}/cancel`);
    return response.data;
  },

  getHistory: async (filter?: { limit?: number; offset?: number; user_id?: string }): Promise<any[]> => {
    const response = await api.get('/api/redis/history', { params: filter });
    return response.data.data;
  },

  getConfiguration: async (): Promise<{ services: Array<{ name: string; label: string; primary: { cloudName: string }; secondary: Array<{ cloudName: string }> }> }> => {
    const response = await api.get('/api/redis/configuration');
    return response.data;
  },
};

// ClickHouse API
export interface ChTableInfo {
  pgDatabase: string;
  pgSchema: string;
  table: string;
  chDatabase: string;
}

export interface ChTableCheckResult {
  pgDatabase: string;
  pgSchema: string;
  table: string;
  chDatabase: string;
  inCH: boolean;
  pgColumnCount: number;
  chColumnCount: number;
  missingColumns: string[];
  extraChColumns: string[];
}

export interface ChSyncResult {
  success: boolean;
  action: 'created' | 'altered' | 'skipped' | 'disabled';
  table?: string;
  details: string;
  error?: string;
}

export interface BackfillJob {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  table: string;
  pgDatabase: string;
  pgSchema: string;
  chDatabase: string;
  fromDate: string;
  toDate: string;
  totalChunks: number;
  completedChunks: number;
  rowsInserted: number;
  currentPeriod: string;
  granularity: 'monthly' | 'weekly' | 'daily';
  error?: string;
  startedAt: string;
  completedAt?: string;
  cancelRequested: boolean;
}

export const clickhouseAPI = {
  getStatus: async (): Promise<{ status: string; clickhouse: string; host?: string; database?: string; message?: string }> => {
    const response = await api.get('/api/clickhouse/status');
    return response.data;
  },

  executeQuery: async (query: string): Promise<QueryResponse> => {
    const response = await api.post('/api/clickhouse/query', { query });
    return response.data;
  },

  sync: async (sql: string, database: string, schema?: string): Promise<any> => {
    const response = await api.post('/api/clickhouse/sync', { sql, database, schema });
    return response.data;
  },

  listTables: async (): Promise<{ tables: ChTableInfo[] }> => {
    const response = await api.get('/api/clickhouse/tables');
    return response.data;
  },

  checkTable: async (pgDatabase: string, pgSchema: string, table: string): Promise<ChTableCheckResult> => {
    const response = await api.post('/api/clickhouse/check-table', { pgDatabase, pgSchema, table });
    return response.data;
  },

  syncColumns: async (pgDatabase: string, pgSchema: string, table: string): Promise<ChSyncResult> => {
    const response = await api.post('/api/clickhouse/sync-columns', { pgDatabase, pgSchema, table });
    return response.data;
  },

  createTable: async (pgDatabase: string, pgSchema: string, table: string): Promise<ChSyncResult> => {
    const response = await api.post('/api/clickhouse/create-table', { pgDatabase, pgSchema, table });
    return response.data;
  },

  startBackfill: async (params: {
    pgDatabase: string;
    pgSchema: string;
    table: string;
    chDatabase: string;
    fromDate: string;
    toDate: string;
  }): Promise<{ backfillId: string; status: string }> => {
    const response = await api.post('/api/clickhouse/backfill', params);
    return response.data;
  },

  getBackfillStatus: async (id: string): Promise<BackfillJob> => {
    const response = await api.get(`/api/clickhouse/backfill/${id}`);
    return response.data;
  },

  cancelBackfill: async (id: string): Promise<{ success: boolean; message: string }> => {
    const response = await api.post(`/api/clickhouse/backfill/${id}/cancel`);
    return response.data;
  },
};

// Shudhi (In-Memory Cache Management) API
export const shudhiAPI = {
  getStatus: async (): Promise<import('../types').ShudhiStatusResponse> => {
    const response = await api.get('/api/shudhi/status');
    return response.data;
  },

  /** Returns string[] of service names */
  getServices: async (): Promise<string[]> => {
    const response = await api.get('/api/shudhi/services');
    return response.data.services ?? [];
  },

  /** Returns ShudhiPodInfo[] — { podName, sidecarUrl } */
  getPods: async (service: string): Promise<import('../types').ShudhiPodInfo[]> => {
    const response = await api.get('/api/shudhi/pods', { params: { service } });
    return response.data.pods ?? [];
  },

  /** Returns ShudhiKeyEntry[] — { keyName, podName, keySchema?, ... } */
  getKeys: async (service: string, pod?: string): Promise<import('../types').ShudhiKeyEntry[]> => {
    const params: Record<string, string> = { service };
    if (pod) params.pod = pod;
    const response = await api.get('/api/shudhi/keys', { params });
    return response.data.keys ?? [];
  },

  /** Get cached value from a specific pod. Body: { serviceName, podName, key } */
  getValue: async (request: import('../types').ShudhiGetRequest): Promise<any> => {
    const response = await api.post('/api/shudhi/get', request);
    return response.data;
  },

  /** Refresh cache. Body: { serviceName, keyInfix? }. Returns { service, total, confirmed, pods } */
  refreshCache: async (request: import('../types').ShudhiRefreshRequest): Promise<import('../types').ShudhiRefreshResponse> => {
    const response = await api.post('/api/shudhi/refresh', request);
    return response.data;
  },
};

export default api;
