import { create } from 'zustand';
import type { User, QueryExecution } from '../types';
import type { editor } from 'monaco-editor';
import { isTransientMode } from '../components/Navigation/consoleSections';

/** Migrations tab faces: the analyze-and-check verifier, or the compare-URL runner. */
export type MigrationView = 'verifier' | 'lite';

/** Every console page. Grouped into header sections in components/Navigation/consoleSections. */
export type ManagerMode =
  | 'db'
  | 'redis'
  | 'batch'
  | 'migrations'
  | 'clickhouse'
  | 'shudhi'
  | 'systemConfigs'
  // The Requests section's pages. 'requests' is the pending queue, kept under
  // its original name so a stored managerMode still resolves.
  | 'requests'
  | 'requestsMine'
  | 'requestsReviewed'
  // Opened by a link, and only while one is being followed — see the
  // `transient` tabs in components/Navigation/consoleSections.
  | 'requestsLinked'
  | 'configreplicate'
  | 'configsync'
  | 'users'
  | 'history';

// Load persisted settings from localStorage
const loadPersistedSetting = (key: string, defaultValue: boolean): boolean => {
  try {
    const stored = localStorage.getItem(key);
    return stored !== null ? stored === 'true' : defaultValue;
  } catch {
    return defaultValue;
  }
};

// Save setting to localStorage
const savePersistedSetting = (key: string, value: boolean) => {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Ignore storage errors
  }
};

// Load persisted string setting from localStorage
const loadPersistedStringSetting = (key: string, defaultValue: string): string => {
  try {
    const stored = localStorage.getItem(key);
    return stored !== null ? stored : defaultValue;
  } catch {
    return defaultValue;
  }
};

// Save string setting to localStorage
const savePersistedStringSetting = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage errors
  }
};

interface AppState {
  // Manager mode
  managerMode: ManagerMode;
  setManagerMode: (mode: ManagerMode) => void;

  // Which face of the Migrations tab is showing. Lives here (not in a panel)
  // because both panels' toolbars render the switch for it.
  migrationView: MigrationView;
  setMigrationView: (view: MigrationView) => void;

  // User state
  user: User | null;
  setUser: (user: User | null) => void;

  /**
   * The group id from a `?request=` link, waiting for the Query Requests panel
   * to pick it up. Held here rather than passed down because the page that
   * reads the URL (ConsolePage) has to open the Requests section before the
   * panel that acts on it is even mounted.
   *
   * Deliberately not persisted: a link is a one-off instruction, not a
   * preference, and a stale one would re-focus a request on every reload.
   */
  linkedRequestGroupId: string | null;
  setLinkedRequestGroupId: (groupId: string | null) => void;

  // Query state
  currentQuery: string;
  setCurrentQuery: (query: string) => void;

  // Editor instance
  editorInstance: editor.IStandaloneCodeEditor | null;
  setEditorInstance: (instance: editor.IStandaloneCodeEditor | null) => void;
  getQueryToExecute: () => string;

  selectedDatabase: string; // Database name (e.g., 'bpp', 'bap')
  setSelectedDatabase: (database: string) => void;

  selectedPgSchema: string;
  setSelectedPgSchema: (pgSchema: string) => void;

  selectedMode: string; // 'both' or cloud name
  setSelectedMode: (mode: string) => void;

  // Redis service selection (mirrors selectedDatabase for the Redis tab)
  selectedRedisService: string;
  setSelectedRedisService: (service: string) => void;

  // Execution state
  isExecuting: boolean;
  setIsExecuting: (isExecuting: boolean) => void;
  currentExecutionId: string | null;
  setCurrentExecutionId: (id: string | null) => void;
  continueOnError: boolean;
  setContinueOnError: (value: boolean) => void;

  // History
  queryHistory: QueryExecution[];
  setQueryHistory: (history: QueryExecution[]) => void;
  addToHistory: (execution: QueryExecution) => void;

  // Ref slot for execute shortcut bridge
  executeRef: { current: (() => void) | null };
}

export const useAppStore = create<AppState>((set, get) => ({
  // Manager mode
  managerMode: (sessionStorage.getItem('managerMode') as ManagerMode) || 'db',
  setManagerMode: (mode) => {
    // A transient page isn't somewhere to come back to: what opened it doesn't
    // survive a reload, so remembering it would restore a page with nothing on
    // it. The last real page stays remembered instead, which is where a reload
    // from a transient one lands.
    if (!isTransientMode(mode)) sessionStorage.setItem('managerMode', mode);
    set({ managerMode: mode });
  },

  migrationView: (sessionStorage.getItem('migrationView') as MigrationView) || 'verifier',
  setMigrationView: (view) => {
    sessionStorage.setItem('migrationView', view);
    set({ migrationView: view });
  },

  // User
  user: null,
  setUser: (user) => set({ user }),

  linkedRequestGroupId: null,
  setLinkedRequestGroupId: (groupId) => set({ linkedRequestGroupId: groupId }),

  // Query
  currentQuery: '',
  setCurrentQuery: (query) => set({ currentQuery: query }),

  // Editor instance
  editorInstance: null,
  setEditorInstance: (instance) => set({ editorInstance: instance }),
  getQueryToExecute: () => {
    const state = get();
    const editor = state.editorInstance;

    if (!editor) {
      return state.currentQuery;
    }

    // Get selected text
    const selection = editor.getSelection();
    if (selection && !selection.isEmpty()) {
      const selectedText = editor.getModel()?.getValueInRange(selection);
      if (selectedText && selectedText.trim()) {
        return selectedText;
      }
    }

    // No selection, return full query
    return state.currentQuery;
  },

  selectedDatabase: 'bpp', // Default to first database
  setSelectedDatabase: (database) => set({ selectedDatabase: database }),

  selectedPgSchema: 'public',
  setSelectedPgSchema: (pgSchema) => set({ selectedPgSchema: pgSchema }),

  selectedMode: 'both',
  setSelectedMode: (mode) => set({ selectedMode: mode }),

  selectedRedisService: 'main',
  setSelectedRedisService: (service) => set({ selectedRedisService: service }),

  // Execution
  isExecuting: false,
  setIsExecuting: (isExecuting) => set({ isExecuting }),
  currentExecutionId: null,
  setCurrentExecutionId: (id) => set({ currentExecutionId: id }),
  continueOnError: loadPersistedSetting('continueOnError', false),
  setContinueOnError: (value) => {
    savePersistedSetting('continueOnError', value);
    set({ continueOnError: value });
  },

  // History
  queryHistory: [],
  setQueryHistory: (history) => set({ queryHistory: history }),
  addToHistory: (execution) =>
    set((state) => ({
      queryHistory: [execution, ...state.queryHistory],
    })),

  // Ref slot
  executeRef: { current: null },
}));
