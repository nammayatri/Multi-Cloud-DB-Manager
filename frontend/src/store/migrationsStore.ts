import { create } from 'zustand';
import type { AnalysisResult, MigrationsConfigResponse, RefsResponse } from '../types/migrations';
import { migrationsAPI } from '../services/migrationsApi';
import toast from 'react-hot-toast';

type StatusFilter = 'all' | 'applied' | 'pending' | 'manual_check' | 'error';

interface MigrationsState {
  // Config
  config: MigrationsConfigResponse | null;
  refs: RefsResponse | null;

  // Inputs
  fromRef: string;
  toRef: string;
  environment: string;
  databaseFilter: string;

  // Analysis state
  isAnalyzing: boolean;
  analysisResult: AnalysisResult | null;
  error: string | null;

  // UI state
  selectedFilePath: string | null;
  statusFilter: StatusFilter;
  expandedFolders: Set<string>;
  viewMode: 'pending' | 'all';
  selectedStatements: Set<string>;

  // Actions
  setFromRef: (ref: string) => void;
  setToRef: (ref: string) => void;
  setEnvironment: (env: string) => void;
  setDatabaseFilter: (db: string) => void;
  setSelectedFilePath: (path: string | null) => void;
  setStatusFilter: (filter: StatusFilter) => void;
  toggleFolder: (folder: string) => void;
  setViewMode: (mode: 'pending' | 'all') => void;

  // Selection actions
  toggleStatement: (key: string) => void;
  selectStatement: (key: string) => void;
  deselectStatement: (key: string) => void;
  selectAllPending: () => void;
  selectAllInFile: (filePath: string) => void;
  selectAllInCategory: (filePath: string, statementIndices: number[]) => void;
  deselectAll: () => void;
  getSelectedSQL: () => string;
  getSelectedCount: () => number;

  loadConfig: () => Promise<void>;
  loadRefs: () => Promise<void>;
  analyze: () => Promise<void>;
  refreshRepo: () => Promise<void>;
}

function makeKey(filePath: string, index: number): string {
  return `${filePath}:${index}`;
}

export const useMigrationsStore = create<MigrationsState>((set, get) => ({
  // Config
  config: null,
  refs: null,

  // Inputs
  fromRef: '',
  toRef: '',
  environment: '',
  databaseFilter: '',

  // Analysis state
  isAnalyzing: false,
  analysisResult: null,
  error: null,

  // UI state
  selectedFilePath: null,
  statusFilter: 'pending',
  expandedFolders: new Set<string>(),
  viewMode: 'pending',
  selectedStatements: new Set<string>(),

  // Actions
  setFromRef: (ref) => set({ fromRef: ref }),
  setToRef: (ref) => set({ toRef: ref }),
  setEnvironment: (env) => set({ environment: env }),
  setDatabaseFilter: (db) => set({ databaseFilter: db }),
  setSelectedFilePath: (path) => set({ selectedFilePath: path }),
  setStatusFilter: (filter) => set({ statusFilter: filter }),
  toggleFolder: (folder) =>
    set((state) => {
      const next = new Set(state.expandedFolders);
      if (next.has(folder)) {
        next.delete(folder);
      } else {
        next.add(folder);
      }
      return { expandedFolders: next };
    }),
  setViewMode: (mode) => set({ viewMode: mode }),

  // Selection actions
  toggleStatement: (key) =>
    set((state) => {
      const next = new Set(state.selectedStatements);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return { selectedStatements: next };
    }),

  selectStatement: (key) =>
    set((state) => {
      const next = new Set(state.selectedStatements);
      next.add(key);
      return { selectedStatements: next };
    }),

  deselectStatement: (key) =>
    set((state) => {
      const next = new Set(state.selectedStatements);
      next.delete(key);
      return { selectedStatements: next };
    }),

  selectAllPending: () =>
    set((state) => {
      const next = new Set(state.selectedStatements);
      if (state.analysisResult) {
        for (const file of state.analysisResult.files) {
          file.statements.forEach((stmt, i) => {
            if (stmt.status === 'pending') {
              next.add(makeKey(file.path, i));
            }
          });
        }
      }
      return { selectedStatements: next };
    }),

  selectAllInFile: (filePath) =>
    set((state) => {
      const next = new Set(state.selectedStatements);
      const file = state.analysisResult?.files.find(f => f.path === filePath);
      if (file) {
        file.statements.forEach((stmt, i) => {
          if (stmt.status === 'pending') {
            next.add(makeKey(filePath, i));
          }
        });
      }
      return { selectedStatements: next };
    }),

  selectAllInCategory: (filePath, statementIndices) =>
    set((state) => {
      const next = new Set(state.selectedStatements);
      const file = state.analysisResult?.files.find(f => f.path === filePath);
      if (file) {
        for (const i of statementIndices) {
          if (file.statements[i]?.status === 'pending') {
            next.add(makeKey(filePath, i));
          }
        }
      }
      return { selectedStatements: next };
    }),

  deselectAll: () => set({ selectedStatements: new Set<string>() }),

  getSelectedSQL: () => {
    const { selectedStatements, analysisResult } = get();
    if (!analysisResult || selectedStatements.size === 0) return '';
    const parts: string[] = [];
    for (const file of analysisResult.files) {
      file.statements.forEach((stmt, i) => {
        if (selectedStatements.has(makeKey(file.path, i)) && stmt.sql) {
          parts.push(stmt.sql);
        }
      });
    }
    return parts.join(';\n\n');
  },

  getSelectedCount: () => {
    return get().selectedStatements.size;
  },

  loadConfig: async () => {
    try {
      const config = await migrationsAPI.getConfig();
      const envKeys = Object.keys(config.environments);
      set({
        config,
        environment: envKeys.length > 0 ? envKeys[0] : '',
      });
    } catch {
      toast.error('Failed to load migrations config');
    }
  },

  loadRefs: async () => {
    try {
      const refs = await migrationsAPI.getRefs();
      set({ refs });
    } catch {
      toast.error('Failed to load git refs');
    }
  },

  analyze: async () => {
    const { fromRef, toRef, environment, databaseFilter } = get();
    if (!fromRef.trim() || !toRef.trim()) {
      toast.error('Please specify both From and To refs');
      return;
    }
    if (!environment) {
      toast.error('Please select an environment');
      return;
    }

    set({ isAnalyzing: true, error: null, analysisResult: null, selectedFilePath: null, selectedStatements: new Set<string>() });

    try {
      const result = await migrationsAPI.analyze({
        fromRef: fromRef.trim(),
        toRef: toRef.trim(),
        environment,
        database: databaseFilter || undefined,
      });
      // Auto-expand all database groups and migration sub-groups
      const expandAll = new Set<string>();
      for (const f of result.files) {
        const db = f.targetDatabase || 'Unknown';
        expandAll.add(`db:${db}`);
        expandAll.add(f.migrationGroup || f.folder || 'Other');
      }
      set({ analysisResult: result, expandedFolders: expandAll });
      toast.success(`Analysis complete: ${result.summary.totalFiles} files, ${result.summary.totalStatements} statements`);
    } catch (err: any) {
      const msg = err.response?.data?.error || 'Analysis failed';
      set({ error: msg });
    } finally {
      set({ isAnalyzing: false });
    }
  },

  refreshRepo: async () => {
    try {
      await migrationsAPI.refreshRepo();
      toast.success('Repository refreshed');
      // Reload refs after refresh
      const refs = await migrationsAPI.getRefs();
      set({ refs });
    } catch {
      toast.error('Failed to refresh repository');
    }
  },
}));

export { makeKey };
