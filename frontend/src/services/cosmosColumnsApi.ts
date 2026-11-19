import api from './api';
import type {
  ApplyProgress,
  ApplyResult,
  BatchCheck,
  BatchItem,
  BatchPreview,
  BatchSummary,
  CosmosAccess,
  CosmosColumnsResponse,
  CosmosSourcesResponse,
} from '../types/cosmosColumns';

const base = '/api/cosmos-columns';
const strip = (items: BatchItem[]): BatchItem[] =>
  items.map(({ etlConfigName, sourceColumn, sourceColumnType, transformType, targetColumnName, targetColumnType, targetTables }) =>
    ({ etlConfigName, sourceColumn, sourceColumnType, transformType, targetColumnName, targetColumnType, targetTables }));

export const cosmosColumnsAPI = {
  access: async (): Promise<CosmosAccess> => (await api.get(`${base}/access`)).data,
  sources: async (): Promise<CosmosSourcesResponse> => (await api.get(`${base}/sources`)).data,
  columns: async (etlConfigName: string): Promise<CosmosColumnsResponse> =>
    (await api.get(`${base}/sources/${encodeURIComponent(etlConfigName)}/columns`)).data,
  setEnabled: async (etlConfigName: string, column: string, enabled: boolean): Promise<void> => {
    await api.post(`${base}/visibility`, { etlConfigName, column, enabled });
  },
  // Preview and check run on every batch edit; their failures show in the panel, not as toasts.
  preview: async (items: BatchItem[]): Promise<BatchPreview> =>
    (await api.post(`${base}/batches/preview`, { items: strip(items) }, { silentError: true })).data,
  check: async (items: BatchItem[]): Promise<BatchCheck> =>
    (await api.post(`${base}/batches/check`, { items: strip(items) }, { silentError: true })).data,
  saveAndApply: async (items: BatchItem[], applyId?: string): Promise<ApplyResult> =>
    (await api.post(`${base}/batches/apply`, { items: strip(items), applyId })).data,
  // Polled while Apply runs; a miss only means no bar, so it never toasts.
  applyProgress: async (applyId: string): Promise<ApplyProgress> =>
    (await api.get(`${base}/apply-progress/${encodeURIComponent(applyId)}`, { silentError: true })).data,
  batches: async (): Promise<{ configTableReady: boolean; batches: BatchSummary[] }> => (await api.get(`${base}/batches`)).data,
  deprecate: async (name: string): Promise<void> => { await api.post(`${base}/columns/${encodeURIComponent(name)}/deprecate`); },
};
