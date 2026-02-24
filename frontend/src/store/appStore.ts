import { create } from 'zustand';
import type { User, QueryExecution } from '../types';
import type { editor } from 'monaco-editor';

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
  managerMode: 'db' | 'redis';
  setManagerMode: (mode: 'db' | 'redis') => void;

  // User state
  user: User | null;
  setUser: (user: User | null) => void;

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

  // UI state
  showHistory: boolean;
  setShowHistory: (show: boolean) => void;

  // Ref slot for execute shortcut bridge
  executeRef: { current: (() => void) | null };
}

export const useAppStore = create<AppState>((set, get) => ({
  // Manager mode
  managerMode: loadPersistedStringSetting('managerMode', 'db') as 'db' | 'redis',
  setManagerMode: (mode) => {
    savePersistedStringSetting('managerMode', mode);
    set({ managerMode: mode });
  },

  // User
  user: null,
  setUser: (user) => set({ user }),

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

  // UI
  showHistory: false,
  setShowHistory: (show) => set({ showHistory: show }),

  // Ref slot
  executeRef: { current: null },
}));
