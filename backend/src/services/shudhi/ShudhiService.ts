import logger from '../../utils/logger';

export interface ShudhiConfig {
  url: string;
}

// Matches Shudhi's PodInfo struct: { podName, sidecarUrl }
export interface ShudhiPodInfo {
  podName: string;
  sidecarUrl: string;
}

// Matches Shudhi's key entry from handleKeys: { keyName, podName, keySchema?, ttlInSeconds?, registeredAt? }
export interface ShudhiKeyEntry {
  keyName: string;
  podName: string;
  keySchema?: any;
  ttlInSeconds?: number;
  registeredAt?: string;
}

// Matches Shudhi's PodGetReq struct
export interface ShudhiGetRequest {
  serviceName: string;
  podName: string;
  key: string;
}

// Matches Shudhi's RefreshReq struct
export interface ShudhiRefreshRequest {
  serviceName: string;
  keyInfix?: string;
}

// Matches Shudhi's refresh response
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

// Matches Shudhi's health endpoint: { redis: bool, app: bool }
export interface ShudhiHealthResponse {
  redis: boolean;
  app: boolean;
}

class ShudhiService {
  private baseUrl: string | null = null;

  constructor() {
    this.loadConfig();
  }

  private loadConfig() {
    try {
      const config = require('../../config/shudhi.json') as ShudhiConfig;
      if (config.url) {
        this.baseUrl = config.url.replace(/\/+$/, '');
        logger.info('Shudhi service configured', { url: this.baseUrl });
      }
    } catch {
      // Config not found — Shudhi not configured, which is fine
    }

    // Fallback to env var
    if (!this.baseUrl && process.env.SHUDHI_URL) {
      this.baseUrl = process.env.SHUDHI_URL.replace(/\/+$/, '');
      logger.info('Shudhi service configured from env', { url: this.baseUrl });
    }
  }

  isConfigured(): boolean {
    return this.baseUrl !== null;
  }

  getConfigUrl(): string | null {
    return this.baseUrl;
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(options?.headers || {}),
        },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Shudhi ${res.status}: ${text}`);
      }
      return await res.json() as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Returns array of service name strings */
  async getServices(): Promise<string[]> {
    const data = await this.request<{ services: string[] }>('/api/services');
    return data.services ?? [];
  }

  /** Returns array of PodInfo objects for a service */
  async getPods(service: string): Promise<ShudhiPodInfo[]> {
    const data = await this.request<{ pods: ShudhiPodInfo[] }>(
      `/api/pods?service=${encodeURIComponent(service)}`
    );
    return data.pods ?? [];
  }

  /** Returns array of key entries for a service (optionally filtered by pod and pattern) */
  async getKeys(service: string, pod?: string, pattern?: string): Promise<ShudhiKeyEntry[]> {
    let path = `/api/keys?service=${encodeURIComponent(service)}`;
    if (pod) path += `&pod=${encodeURIComponent(pod)}`;
    if (pattern) path += `&pattern=${encodeURIComponent(pattern)}`;
    const data = await this.request<{ keys: ShudhiKeyEntry[] }>(path);
    return data.keys ?? [];
  }

  /** Get cached value from a specific pod */
  async getValue(body: ShudhiGetRequest): Promise<any> {
    return this.request<any>('/api/pod/get', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /** Refresh (invalidate) cache across pods */
  async refresh(body: ShudhiRefreshRequest): Promise<ShudhiRefreshResponse> {
    return this.request<ShudhiRefreshResponse>('/api/refresh', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /** Health check — returns { redis: bool, app: bool } */
  async health(): Promise<ShudhiHealthResponse> {
    return this.request<ShudhiHealthResponse>('/api/health');
  }
}

export default new ShudhiService();
