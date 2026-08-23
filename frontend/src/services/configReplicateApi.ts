import api from './api';
import type {
  AnalysisResult,
  ApplyResult,
  ConfigGroup,
  ConfigGroupSummary,
  DiffSelection,
  GroupInput,
  RunSummaryRecord,
  TableMeta,
} from '../types/configReplicate';

export interface ReplicateTarget {
  groupId: string;
  database: string;
  cloud: string;
  baseValues: string[];
  newValues: string[];
}

export const configReplicateAPI = {
  listGroups: async (): Promise<ConfigGroupSummary[]> => {
    const response = await api.get('/api/config-replicate/groups');
    return response.data.groups;
  },

  getGroup: async (id: string): Promise<ConfigGroup> => {
    const response = await api.get(`/api/config-replicate/groups/${id}`);
    return response.data.group;
  },

  createGroup: async (input: GroupInput): Promise<ConfigGroup> => {
    const response = await api.post('/api/config-replicate/groups', input);
    return response.data.group;
  },

  updateGroup: async (id: string, input: GroupInput): Promise<ConfigGroup> => {
    const response = await api.put(`/api/config-replicate/groups/${id}`, input);
    return response.data.group;
  },

  deleteGroup: async (id: string): Promise<void> => {
    await api.delete(`/api/config-replicate/groups/${id}`);
  },

  listTables: async (params: {
    database: string;
    cloud: string;
    dimensionColumns?: string[];
  }): Promise<Array<{ schema: string; table: string; dimensionColumns: string[] }>> => {
    const response = await api.post('/api/config-replicate/introspect/tables', params);
    return response.data.tables;
  },

  getTableMeta: async (params: {
    database: string;
    cloud: string;
    schema: string;
    table: string;
    dimensionColumns: string[];
  }): Promise<TableMeta> => {
    const response = await api.post('/api/config-replicate/introspect/table', params);
    return response.data;
  },

  analyze: async (params: ReplicateTarget): Promise<AnalysisResult> => {
    const response = await api.post('/api/config-replicate/analyze', params);
    return response.data;
  },

  apply: async (
    params: ReplicateTarget & { analysisToken: string; selections: DiffSelection[] }
  ): Promise<ApplyResult> => {
    const response = await api.post('/api/config-replicate/apply', params);
    return response.data;
  },

  listRuns: async (params?: {
    groupId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ runs: RunSummaryRecord[]; total: number }> => {
    const response = await api.get('/api/config-replicate/runs', { params });
    return response.data;
  },
};

export default configReplicateAPI;
