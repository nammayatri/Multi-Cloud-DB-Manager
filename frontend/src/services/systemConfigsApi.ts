import api from './api';
import type {
  SystemConfigTarget,
  SystemConfigTargetsResponse,
  SystemConfigKeysResponse,
  SystemConfigResponse,
  SystemConfigValidateResponse,
  SystemConfigExecuteRequest,
  SystemConfigExecuteResponse,
} from '../types';

// System Configs Manager API — session-authenticated (shared axios instance
// sends the cookie), role-gated MASTER/ADMIN on the backend.
export const systemConfigsAPI = {
  getTargets: (): Promise<SystemConfigTargetsResponse> =>
    api.get('/api/system-configs/targets').then(r => r.data),

  getKeys: (target: SystemConfigTarget, search?: string): Promise<SystemConfigKeysResponse> =>
    api.get('/api/system-configs/keys', {
      params: { target, ...(search && search.trim() ? { search: search.trim() } : {}) },
    }).then(r => r.data),

  getConfig: (target: SystemConfigTarget, id: string): Promise<SystemConfigResponse> =>
    api.get('/api/system-configs/config', { params: { target, id } }).then(r => r.data),

  validate: (target: SystemConfigTarget, configValue: string): Promise<SystemConfigValidateResponse> =>
    api.post('/api/system-configs/validate', { target, configValue }).then(r => r.data),

  // configValue is sent EXACTLY as edited — callers must never re-stringify it.
  execute: (request: SystemConfigExecuteRequest): Promise<SystemConfigExecuteResponse> =>
    api.post('/api/system-configs/execute', request).then(r => r.data),
};
