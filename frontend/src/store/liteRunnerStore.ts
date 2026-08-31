import { create } from 'zustand';
import type { LiteDiffResult, LiteDiffFile } from '../types/migrations';
import { migrationsAPI } from '../services/migrationsApi';
import toast from 'react-hot-toast';

export type FileRunStatus = 'idle' | 'running' | 'success' | 'failed' | 'skipped';

export interface FileRunState {
  status: FileRunStatus;
  error?: string;
  /** Each failing statement in this file — a continue-on-error run can fail several. */
  statementErrors?: Array<{ statement: string; error: string }>;
  rowsAffected?: number;
  durationMs?: number;
}

/** A file plus the subset of its statements the user picked, in file order. */
export interface SelectedFileSql {
  path: string;
  filename: string;
  sql: string;
  statementCount: number;
  /** How many of the picked statements need password verification. */
  dangerousCount: number;
}

export const ALL_FILES = 'all';

interface LiteRunnerState {
  compareUrl: string;
  isFetching: boolean;
  diff: LiteDiffResult | null;
  error: string | null;

  /** Keyed `${filePath}:${statementIndex}` — selection is per statement. */
  selectedStatements: Set<string>;
  expandedFiles: Set<string>;

  /** View filters — these narrow what is shown, never what is selected. */
  directoryFilter: string;
  search: string;

  /** Last file whose checkbox was clicked — the anchor for range selection. */
  lastAnchorPath: string | null;

  database: string;
  mode: string;
  pgSchema: string;
  continueOnError: boolean;

  isRunning: boolean;
  runState: Record<string, FileRunState>;

  setCompareUrl: (url: string) => void;
  setDatabase: (db: string) => void;
  setMode: (mode: string) => void;
  setPgSchema: (schema: string) => void;
  setContinueOnError: (value: boolean) => void;
  setDirectoryFilter: (directory: string) => void;
  setSearch: (search: string) => void;

  toggleStatement: (path: string, index: number) => void;
  toggleFile: (path: string) => void;
  /** Select every file between the anchor and `path` (inclusive), in view order. */
  selectFileRangeTo: (path: string) => void;
  toggleFileExpanded: (path: string) => void;
  expandAll: () => void;
  collapseAll: () => void;
  selectAllDdl: () => void;
  deselectAll: () => void;

  fetchDiff: () => Promise<void>;
  getVisibleFiles: () => LiteDiffFile[];
  getSelectedFiles: () => SelectedFileSql[];
  setFileRunState: (path: string, state: FileRunState) => void;
  resetRunState: () => void;
  setIsRunning: (value: boolean) => void;
}

export function stmtKey(path: string, index: number): string {
  return `${path}:${index}`;
}

function allFiles(diff: LiteDiffResult | null): LiteDiffFile[] {
  if (!diff) return [];
  return diff.directories.flatMap(d => d.files);
}

function ddlKeys(files: LiteDiffFile[]): string[] {
  return files.flatMap(f =>
    f.statements
      .map((s, i) => (s.type === 'DDL' ? stmtKey(f.path, i) : null))
      .filter((k): k is string => k !== null)
  );
}

function visible(diff: LiteDiffResult | null, directoryFilter: string, search: string): LiteDiffFile[] {
  const term = search.trim().toLowerCase();
  return allFiles(diff).filter(f => {
    if (directoryFilter !== ALL_FILES && f.directory !== directoryFilter) return false;
    if (term && !f.path.toLowerCase().includes(term)) return false;
    return true;
  });
}

export const useLiteRunnerStore = create<LiteRunnerState>((set, get) => ({
  compareUrl: '',
  isFetching: false,
  diff: null,
  error: null,

  selectedStatements: new Set<string>(),
  expandedFiles: new Set<string>(),

  directoryFilter: ALL_FILES,
  search: '',
  lastAnchorPath: null,

  database: '',
  mode: '',
  pgSchema: '',
  continueOnError: false,

  isRunning: false,
  runState: {},

  setCompareUrl: (url) => set({ compareUrl: url }),
  setDatabase: (db) => set({ database: db }),
  setMode: (mode) => set({ mode }),
  setPgSchema: (schema) => set({ pgSchema: schema }),
  setContinueOnError: (value) => set({ continueOnError: value }),
  setDirectoryFilter: (directory) => set({ directoryFilter: directory }),
  setSearch: (search) => set({ search }),

  toggleStatement: (path, index) =>
    set((state) => {
      const next = new Set(state.selectedStatements);
      const key = stmtKey(path, index);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { selectedStatements: next };
    }),

  toggleFile: (path) =>
    set((state) => {
      const file = allFiles(state.diff).find(f => f.path === path);
      if (!file) return state;
      const next = new Set(state.selectedStatements);
      // Partial counts as "not all", so the first click completes the file.
      const allSelected = file.statements.every((_s, i) => next.has(stmtKey(path, i)));
      file.statements.forEach((_s, i) => {
        const key = stmtKey(path, i);
        if (allSelected) next.delete(key);
        else next.add(key);
      });
      return { selectedStatements: next, lastAnchorPath: path };
    }),

  // Range select across the visible list. Whether the range is selected or
  // cleared follows the anchor file's current state, so a modifier-click
  // extends what you just did rather than inverting each file individually.
  selectFileRangeTo: (path) =>
    set((state) => {
      const inView = visible(state.diff, state.directoryFilter, state.search);
      const to = inView.findIndex(f => f.path === path);
      if (to === -1) return state;

      const anchor = state.lastAnchorPath
        ? inView.findIndex(f => f.path === state.lastAnchorPath)
        : -1;
      // No usable anchor — behave like a plain toggle.
      if (anchor === -1) {
        const next = new Set(state.selectedStatements);
        const file = inView[to];
        const allSelected = file.statements.every((_s, i) => next.has(stmtKey(file.path, i)));
        file.statements.forEach((_s, i) => {
          const key = stmtKey(file.path, i);
          if (allSelected) next.delete(key);
          else next.add(key);
        });
        return { selectedStatements: next, lastAnchorPath: path };
      }

      const [start, end] = anchor <= to ? [anchor, to] : [to, anchor];
      const anchorFile = inView[anchor];
      const anchorSelected = anchorFile.statements.some(
        (_s, i) => state.selectedStatements.has(stmtKey(anchorFile.path, i))
      );

      const next = new Set(state.selectedStatements);
      for (let i = start; i <= end; i++) {
        const file = inView[i];
        file.statements.forEach((_s, j) => {
          const key = stmtKey(file.path, j);
          if (anchorSelected) next.add(key);
          else next.delete(key);
        });
      }
      return { selectedStatements: next, lastAnchorPath: path };
    }),

  toggleFileExpanded: (path) =>
    set((state) => {
      const next = new Set(state.expandedFiles);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { expandedFiles: next };
    }),

  expandAll: () =>
    set((state) => ({
      expandedFiles: new Set(
        visible(state.diff, state.directoryFilter, state.search).map(f => f.path)
      ),
    })),

  collapseAll: () => set({ expandedFiles: new Set<string>() }),

  // Scoped to the files currently in view: selecting inside a filtered view
  // must not silently discard picks made under a different filter.
  selectAllDdl: () =>
    set((state) => {
      const inView = visible(state.diff, state.directoryFilter, state.search);
      const next = new Set(state.selectedStatements);
      for (const file of inView) {
        file.statements.forEach((_s, i) => next.delete(stmtKey(file.path, i)));
      }
      for (const key of ddlKeys(inView)) next.add(key);
      return { selectedStatements: next };
    }),

  deselectAll: () =>
    set((state) => {
      const inView = visible(state.diff, state.directoryFilter, state.search);
      const next = new Set(state.selectedStatements);
      for (const file of inView) {
        file.statements.forEach((_s, i) => next.delete(stmtKey(file.path, i)));
      }
      return { selectedStatements: next };
    }),

  fetchDiff: async () => {
    const url = get().compareUrl.trim();
    if (!url) {
      toast.error('Paste a GitHub compare URL first');
      return;
    }

    set({
      isFetching: true, error: null, diff: null,
      selectedStatements: new Set<string>(), runState: {},
      directoryFilter: ALL_FILES, search: '', lastAnchorPath: null,
    });

    try {
      const diff = await migrationsAPI.liteDiff(url);

      if (diff.totalFiles === 0) {
        set({ diff, isFetching: false, expandedFiles: new Set<string>() });
        toast('No SQL changes found in this range');
        return;
      }

      // Pre-select the DDL: schema change is the common case for a migration
      // run, and anything touching data is opted into deliberately.
      const files = allFiles(diff);
      const preselected = ddlKeys(files);
      set({
        diff,
        selectedStatements: new Set(preselected),
        // Collapsed by default — a wide range can be dozens of files, and the
        // point of the list is to scan paths first, then open what matters.
        expandedFiles: new Set<string>(),
        isFetching: false,
      });
      toast.success(
        `Found ${diff.totalFiles} file(s), ${diff.totalStatements} statement(s) — ${preselected.length} DDL selected`
      );
    } catch (err: any) {
      const msg = err.response?.data?.error || 'Failed to fetch diff';
      set({ error: msg, isFetching: false });
    }
  },

  getVisibleFiles: () => {
    const { diff, directoryFilter, search } = get();
    return visible(diff, directoryFilter, search);
  },

  // Files that have at least one selected statement, each carrying only the
  // statements actually picked — so a mixed file can run its DDL alone.
  getSelectedFiles: () => {
    const { diff, selectedStatements } = get();
    const out: SelectedFileSql[] = [];

    for (const file of allFiles(diff)) {
      const picked = file.statements.filter((_s, i) => selectedStatements.has(stmtKey(file.path, i)));
      if (picked.length === 0) continue;
      out.push({
        path: file.path,
        filename: file.filename,
        statementCount: picked.length,
        dangerousCount: picked.filter(s => s.dangerous).length,
        sql: picked.map(s => s.sql).join(';\n\n') + ';',
      });
    }

    return out;
  },

  setFileRunState: (path, state) =>
    set((s) => ({ runState: { ...s.runState, [path]: state } })),

  resetRunState: () => set({ runState: {} }),

  setIsRunning: (value) => set({ isRunning: value }),
}));
