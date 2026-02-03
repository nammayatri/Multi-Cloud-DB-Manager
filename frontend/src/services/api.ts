import axios from 'axios';
import toast from 'react-hot-toast';
import type { User, QueryRequest, QueryResponse, QueryExecution, HistoryFilter, DatabaseConfiguration } from '../types';

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
api.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    if (error.response?.status === 401) {
      // Unauthorized - redirect to login
      window.location.href = '/login';
    } else if (error.response?.data?.error) {
      // Show error message
      toast.error(error.response.data.error);
    } else {
      toast.error('An unexpected error occurred');
    }
    return Promise.reject(error);
  }
);

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

  changeRole: async (username: string, role: 'MASTER' | 'USER' | 'READER'): Promise<void> => {
    await api.post('/api/auth/change-role', { username, role });
  },
};

// Query API
export const queryAPI = {
  execute: async (request: QueryRequest): Promise<QueryResponse> => {
    const response = await api.post('/api/query/execute', request);
    return response.data;
  },

  validate: async (query: string): Promise<{ valid: boolean; error?: string }> => {
    const response = await api.post('/api/query/validate', { query });
    return response.data;
  },
};

// Schema API with caching
export const schemaAPI = {
  // Get full database configuration
  getConfiguration: async (): Promise<DatabaseConfiguration> => {
    const cacheKey = 'database_configuration';
    const cacheTTL = 1000 * 60 * 60; // 1 hour

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
    const response = await api.get('/api/schemas/configuration');

    // Cache the result
    localStorage.setItem(cacheKey, JSON.stringify({
      data: response.data,
      timestamp: Date.now()
    }));

    return response.data;
  },

  getSchemas: async (database: 'primary' | 'secondary', cloud: 'aws' | 'gcp' = 'aws'): Promise<{ schemas: string[]; default: string }> => {
    const cacheKey = `schemas_${database}_${cloud}`;
    const cacheTTL = 1000 * 60 * 60; // 1 hour

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

export default api;
