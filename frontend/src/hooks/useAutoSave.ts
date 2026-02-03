import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import toast from 'react-hot-toast';

const AUTOSAVE_KEY = 'dual_db_manager_autosave_query';
const AUTOSAVE_INTERVAL = 5000; // 5 seconds

interface AutoSaveData {
  query: string;
  selectedDatabase: string;
  selectedPgSchema: string;
  selectedMode: string;
  timestamp: number;
}

export const useAutoSave = () => {
  const {
    currentQuery,
    selectedDatabase,
    selectedPgSchema,
    selectedMode,
    setCurrentQuery,
    setSelectedDatabase,
    setSelectedPgSchema,
    setSelectedMode,
  } = useAppStore();

  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const hasRestoredRef = useRef(false);
  const saveTimeoutRef = useRef<number | null>(null);

  // Restore saved query on mount
  useEffect(() => {
    if (hasRestoredRef.current) return;
    hasRestoredRef.current = true;

    try {
      const saved = localStorage.getItem(AUTOSAVE_KEY);
      if (saved) {
        const data: AutoSaveData = JSON.parse(saved);

        // Only restore if there's actually a query
        if (data.query && data.query.trim()) {
          setCurrentQuery(data.query);
          setSelectedDatabase(data.selectedDatabase);
          setSelectedPgSchema(data.selectedPgSchema);
          setSelectedMode(data.selectedMode);
          setLastSaved(new Date(data.timestamp));
          // Silently restore - no toast notification
        }
      }
    } catch (error) {
      console.error('Failed to restore saved query:', error);
    }
  }, [setCurrentQuery, setSelectedDatabase, setSelectedPgSchema, setSelectedMode]);

  // Auto-save query when it changes
  useEffect(() => {
    // Clear any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Don't save if query is empty
    if (!currentQuery.trim()) {
      return;
    }

    // Set saving state immediately
    setIsSaving(true);

    // Debounce save for 5 seconds
    saveTimeoutRef.current = setTimeout(() => {
      try {
        const data: AutoSaveData = {
          query: currentQuery,
          selectedDatabase,
          selectedPgSchema,
          selectedMode,
          timestamp: Date.now(),
        };

        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(data));
        setLastSaved(new Date());
      } catch (error) {
        console.error('Failed to auto-save query:', error);
      } finally {
        setIsSaving(false);
      }
    }, AUTOSAVE_INTERVAL);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [currentQuery, selectedDatabase, selectedPgSchema, selectedMode]);

  // Clear saved draft
  const clearDraft = () => {
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
      setLastSaved(null);
      toast.success('Draft cleared');
    } catch (error) {
      console.error('Failed to clear draft:', error);
      toast.error('Failed to clear draft');
    }
  };

  // Clear draft on successful query execution
  const clearDraftOnSuccess = () => {
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
      setLastSaved(null);
    } catch (error) {
      console.error('Failed to clear draft:', error);
    }
  };

  // Warn before unload if there are unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (currentQuery.trim() && lastSaved) {
        e.preventDefault();
        e.returnValue = '';
        return '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [currentQuery, lastSaved]);

  return {
    lastSaved,
    isSaving,
    clearDraft,
    clearDraftOnSuccess,
  };
};
