import api from './api';
import type { MigrationsConfigResponse, RefsResponse, AnalysisResult } from '../types/migrations';

export type RepoCloneState = 'NOT_STARTED' | 'CLONING' | 'READY' | 'ERROR';

export interface RepoStatus {
  state: RepoCloneState;
  repoPath: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  message?: string;
}

export const migrationsAPI = {
  getConfig: (): Promise<MigrationsConfigResponse> =>
    api.get('/api/migrations/config').then(r => r.data),

  getRepoStatus: (): Promise<RepoStatus> =>
    api.get('/api/migrations/repo-status').then(r => r.data),

  getRefs: (): Promise<RefsResponse> =>
    api.get('/api/migrations/refs').then(r => r.data),

  analyze: (params: { fromRef: string; toRef: string; environment: string; database?: string }): Promise<AnalysisResult> =>
    api.post('/api/migrations/analyze', params).then(r => r.data),

  getFileContent: (ref: string, path: string): Promise<{ content: string }> =>
    api.get('/api/migrations/file', { params: { ref, path } }).then(r => r.data),

  refreshRepo: (): Promise<{ success: boolean; message: string; repoStatus?: RepoStatus }> =>
    api.post('/api/migrations/refresh-repo').then(r => r.data),
};
