import { create } from 'zustand';
import toast from 'react-hot-toast';
import { toastNonApiError } from '../services/api';
import configReplicateAPI from '../services/configReplicateApi';
import {
  ActionableOperation,
  AnalysisResult,
  ApplyResult,
  ConfigGroup,
  ConfigGroupSummary,
  DiffSelection,
  GroupInput,
  RowDiff,
  RunSummaryRecord,
  TableAnalysis,
  tableKeyOf,
} from '../types/configReplicate';

type OpFilter = 'all' | ActionableOperation | 'AMBIGUOUS';

const isActionable = (diff: RowDiff): diff is RowDiff & { operation: ActionableOperation } =>
  diff.operation !== 'NO_CHANGE';

const selectionOf = (diff: RowDiff): DiffSelection => ({
  diffId: diff.diffId,
  operation: diff.operation as ActionableOperation,
  sourceHash: diff.sourceHash,
  targetHash: diff.targetHash,
});

interface ConfigReplicateState {
  groups: ConfigGroupSummary[];
  activeGroup: ConfigGroup | null;
  loadingGroups: boolean;

  groupId: string;
  database: string;
  cloud: string;
  baseValues: string[];
  newValues: string[];

  isAnalyzing: boolean;
  analysis: AnalysisResult | null;
  error: string | null;

  isApplying: boolean;
  lastRun: ApplyResult | null;
  runs: RunSummaryRecord[];

  expandedTables: Set<string>;
  expandedDiffs: Set<string>;
  opFilter: OpFilter;
  selectedDiffs: Set<string>;
  retainedColumns: Record<string, string[]>;
  overrides: Record<string, Record<string, string | null>>;

  setGroupId: (id: string) => void;
  setDatabase: (db: string) => void;
  setCloud: (cloud: string) => void;
  setBaseValue: (index: number, value: string) => void;
  setNewValue: (index: number, value: string) => void;
  setOpFilter: (filter: OpFilter) => void;
  toggleTable: (tableKey: string) => void;
  toggleDiffExpanded: (diffId: string) => void;

  toggleDiff: (diffId: string) => void;
  toggleRetainedColumn: (diffId: string, column: string) => void;
  setOverride: (diffId: string, column: string, value: string | null) => void;
  clearOverride: (diffId: string, column: string) => void;
  selectAllInTable: (tableKey: string) => void;
  deselectAllInTable: (tableKey: string) => void;
  selectAllInSection: (tableKey: string, operation: ActionableOperation) => void;
  selectAllDefaults: () => void;
  deselectAll: () => void;
  getSelectedCount: () => number;
  getSelections: () => DiffSelection[];
  getSelectedTotals: () => { insert: number; update: number; delete: number };

  loadGroups: () => Promise<void>;
  loadGroup: (id: string) => Promise<ConfigGroup | null>;
  saveGroup: (input: GroupInput, id?: string) => Promise<ConfigGroup | null>;
  deleteGroup: (id: string) => Promise<void>;
  analyze: () => Promise<void>;
  apply: () => Promise<ApplyResult | null>;
  loadRuns: () => Promise<void>;
  reset: () => void;
}

const allDiffs = (analysis: AnalysisResult | null): RowDiff[] =>
  analysis ? analysis.tables.flatMap(t => t.diffs) : [];

const diffsOfTable = (analysis: AnalysisResult | null, tableKey: string): RowDiff[] => {
  const table = analysis?.tables.find(t => tableKeyOf(t) === tableKey);
  return table ? table.diffs : [];
};

export const useConfigReplicateStore = create<ConfigReplicateState>((set, get) => ({
  groups: [],
  activeGroup: null,
  loadingGroups: false,

  groupId: '',
  database: '',
  cloud: '',
  baseValues: [],
  newValues: [],

  isAnalyzing: false,
  analysis: null,
  error: null,

  isApplying: false,
  lastRun: null,
  runs: [],

  expandedTables: new Set<string>(),
  expandedDiffs: new Set<string>(),
  opFilter: 'all',
  selectedDiffs: new Set<string>(),
  retainedColumns: {},
  overrides: {},

  setGroupId: groupId => {
    const summary = get().groups.find(g => g.id === groupId);
    const arity = summary?.dimensionColumns.length ?? 0;
    set({
      groupId,
      analysis: null,
      selectedDiffs: new Set(),
      lastRun: null,
      retainedColumns: {},
      overrides: {},
      baseValues: Array(arity).fill(''),
      newValues: Array(arity).fill(''),
    });
    if (groupId) void get().loadGroup(groupId);
  },
  setDatabase: database => set({ database, analysis: null, selectedDiffs: new Set(), retainedColumns: {}, overrides: {} }),
  setCloud: cloud => set({ cloud, analysis: null, selectedDiffs: new Set(), retainedColumns: {}, overrides: {} }),
  setBaseValue: (index, value) =>
    set(state => {
      const baseValues = [...state.baseValues];
      baseValues[index] = value;
      return { baseValues, analysis: null, selectedDiffs: new Set(), retainedColumns: {}, overrides: {} };
    }),
  setNewValue: (index, value) =>
    set(state => {
      const newValues = [...state.newValues];
      newValues[index] = value;
      return { newValues, analysis: null, selectedDiffs: new Set(), retainedColumns: {}, overrides: {} };
    }),
  setOpFilter: opFilter => set({ opFilter }),

  toggleTable: tableKey =>
    set(state => {
      const next = new Set(state.expandedTables);
      if (next.has(tableKey)) next.delete(tableKey);
      else next.add(tableKey);
      return { expandedTables: next };
    }),

  toggleDiffExpanded: diffId =>
    set(state => {
      const next = new Set(state.expandedDiffs);
      if (next.has(diffId)) next.delete(diffId);
      else next.add(diffId);
      return { expandedDiffs: next };
    }),

  toggleDiff: diffId =>
    set(state => {
      const next = new Set(state.selectedDiffs);
      if (next.has(diffId)) next.delete(diffId);
      else next.add(diffId);
      return { selectedDiffs: next };
    }),

  toggleRetainedColumn: (diffId, column) =>
    set(state => {
      const current = state.retainedColumns[diffId] || [];
      const next = current.includes(column)
        ? current.filter(c => c !== column)
        : [...current, column];
      return { retainedColumns: { ...state.retainedColumns, [diffId]: next } };
    }),

  setOverride: (diffId, column, value) =>
    set(state => ({
      overrides: {
        ...state.overrides,
        [diffId]: { ...(state.overrides[diffId] || {}), [column]: value },
      },
    })),

  clearOverride: (diffId, column) =>
    set(state => {
      const row = { ...(state.overrides[diffId] || {}) };
      delete row[column];
      return { overrides: { ...state.overrides, [diffId]: row } };
    }),

  selectAllInTable: tableKey =>
    set(state => {
      const next = new Set(state.selectedDiffs);
      for (const diff of diffsOfTable(state.analysis, tableKey)) {
        if (isActionable(diff)) next.add(diff.diffId);
      }
      return { selectedDiffs: next };
    }),

  deselectAllInTable: tableKey =>
    set(state => {
      const next = new Set(state.selectedDiffs);
      for (const diff of diffsOfTable(state.analysis, tableKey)) next.delete(diff.diffId);
      return { selectedDiffs: next };
    }),

  selectAllInSection: (tableKey, operation) =>
    set(state => {
      const next = new Set(state.selectedDiffs);
      const diffs = diffsOfTable(state.analysis, tableKey).filter(d => d.operation === operation);
      const allSelected = diffs.every(d => next.has(d.diffId));
      for (const diff of diffs) {
        if (allSelected) next.delete(diff.diffId);
        else next.add(diff.diffId);
      }
      return { selectedDiffs: next };
    }),

  selectAllDefaults: () =>
    set(state => {
      const next = new Set<string>();
      for (const diff of allDiffs(state.analysis)) {
        if (diff.operation === 'INSERT' && !diff.ambiguous) next.add(diff.diffId);
      }
      return { selectedDiffs: next };
    }),

  deselectAll: () => set({ selectedDiffs: new Set<string>() }),

  getSelectedCount: () => get().selectedDiffs.size,

  getSelections: () => {
    const { analysis, selectedDiffs, retainedColumns, overrides } = get();
    return allDiffs(analysis)
      .filter(d => isActionable(d) && selectedDiffs.has(d.diffId))
      .map(diff => {
        const selection = selectionOf(diff);
        if (diff.operation === 'UPDATE') {
          const retained = retainedColumns[diff.diffId] || [];
          if (retained.length > 0) selection.excludeColumns = retained;
        }
        if (diff.operation === 'INSERT') {
          const row = overrides[diff.diffId] || {};
          if (Object.keys(row).length > 0) selection.overrides = row;
        }
        return selection;
      });
  },

  getSelectedTotals: () => {
    const { analysis, selectedDiffs, retainedColumns } = get();
    const selected = allDiffs(analysis).filter(d => isActionable(d) && selectedDiffs.has(d.diffId));

    const writtenUpdates = selected.filter(d => {
      if (d.operation !== 'UPDATE') return false;
      const changed = (d.columnDiffs || []).length;
      const retained = (retainedColumns[d.diffId] || []).length;
      return changed === 0 || retained < changed;
    });

    return {
      insert: selected.filter(d => d.operation === 'INSERT').length,
      update: writtenUpdates.length,
      delete: selected.filter(d => d.operation === 'DELETE').length,
    };
  },

  loadGroups: async () => {
    set({ loadingGroups: true });
    try {
      set({ groups: await configReplicateAPI.listGroups() });
    } catch (error) {
      toastNonApiError(error, 'Failed to load config groups');
    } finally {
      set({ loadingGroups: false });
    }
  },

  loadGroup: async id => {
    try {
      const group = await configReplicateAPI.getGroup(id);
      set({ activeGroup: group });
      return group;
    } catch (error) {
      toastNonApiError(error, 'Failed to load config group');
      return null;
    }
  },

  saveGroup: async (input, id) => {
    try {
      const group = id
        ? await configReplicateAPI.updateGroup(id, input)
        : await configReplicateAPI.createGroup(input);
      toast.success(id ? 'Group updated' : 'Group created');
      await get().loadGroups();
      set({ activeGroup: group });
      return group;
    } catch (error) {
      toastNonApiError(error, 'Failed to save config group');
      return null;
    }
  },

  deleteGroup: async id => {
    try {
      await configReplicateAPI.deleteGroup(id);
      toast.success('Group deleted');
      if (get().groupId === id) set({ groupId: '', activeGroup: null, analysis: null });
      await get().loadGroups();
    } catch (error) {
      toastNonApiError(error, 'Failed to delete config group');
    }
  },

  analyze: async () => {
    const { groupId, database, cloud, baseValues, newValues, activeGroup } = get();
    const arity = activeGroup?.dimensionColumns.length ?? 0;

    if (!groupId || !database || !cloud || arity === 0) {
      toast.error('Pick a group, database, and cloud first');
      return;
    }
    if (
      baseValues.length !== arity ||
      newValues.length !== arity ||
      baseValues.some(v => !v.trim()) ||
      newValues.some(v => !v.trim())
    ) {
      toast.error('Fill in every dimension value on both sides');
      return;
    }
    if (baseValues.join('\u0000') === newValues.join('\u0000')) {
      toast.error('Base and new dimension values must differ in at least one column');
      return;
    }

    set({ isAnalyzing: true, error: null, lastRun: null });
    try {
      const analysis = await configReplicateAPI.analyze({
        groupId,
        database,
        cloud,
        baseValues,
        newValues,
      });

      const expanded = new Set(
        analysis.tables
          .filter(t => t.error || t.counts.insert + t.counts.update + t.counts.delete > 0)
          .map(tableKeyOf)
      );

      set({ analysis, expandedTables: expanded, expandedDiffs: new Set(), retainedColumns: {}, overrides: {} });
      get().selectAllDefaults();
    } catch (error: any) {
      const message = error?.response?.data?.error || error?.message || 'Analysis failed';
      set({ error: message, analysis: null, selectedDiffs: new Set(), retainedColumns: {}, overrides: {} });
      toastNonApiError(error, 'Analysis failed');
    } finally {
      set({ isAnalyzing: false });
    }
  },

  apply: async () => {
    const { analysis, groupId, database, cloud, baseValues, newValues } = get();
    if (!analysis) return null;

    const selections = get().getSelections();
    if (selections.length === 0) {
      toast.error('Nothing selected to apply');
      return null;
    }

    set({ isApplying: true });
    try {
      const result = await configReplicateAPI.apply({
        groupId,
        database,
        cloud,
        baseValues,
        newValues,
        analysisToken: analysis.analysisToken,
        selections,
      });

      set({ lastRun: result });
      toast.success(
        `Applied: ${result.totals.inserted} inserted, ${result.totals.updated} updated, ` +
          `${result.totals.deleted} deleted`
      );

      set({ selectedDiffs: new Set() });
      await get().analyze();
      await get().loadRuns();
      return result;
    } catch (error: any) {
      const data = error?.response?.data;
      if (data?.drift?.length) {
        set({ lastRun: data });
        toast.error('The data changed since this analysis. Re-analyzing now.');
        await get().analyze();
      } else {
        toastNonApiError(error, 'Apply failed');
        if (data) set({ lastRun: data });
      }
      return null;
    } finally {
      set({ isApplying: false });
    }
  },

  loadRuns: async () => {
    try {
      const { runs } = await configReplicateAPI.listRuns({ limit: 25 });
      set({ runs });
    } catch (error) {
      toastNonApiError(error, 'Failed to load run history');
    }
  },

  reset: () =>
    set({
      analysis: null,
      selectedDiffs: new Set(),
      expandedDiffs: new Set(),
      expandedTables: new Set(),
      retainedColumns: {},
      overrides: {},
      lastRun: null,
      error: null,
    }),
}));

export const actionableCount = (table: TableAnalysis): number =>
  table.counts.insert + table.counts.update + table.counts.delete;
