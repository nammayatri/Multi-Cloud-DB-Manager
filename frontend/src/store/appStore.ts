import { create } from 'zustand';
import type { User, QueryExecution } from '../types';
import type { editor } from 'monaco-editor';

interface AppState {
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
  executeQuery: (() => Promise<void>) | null;
  setExecuteQuery: (fn: (() => Promise<void>) | null) => void;

  // History
  queryHistory: QueryExecution[];
  setQueryHistory: (history: QueryExecution[]) => void;
  addToHistory: (execution: QueryExecution) => void;

  // UI state
  showHistory: boolean;
  setShowHistory: (show: boolean) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
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
  executeQuery: null,
  setExecuteQuery: (fn) => set({ executeQuery: fn }),

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
}));
