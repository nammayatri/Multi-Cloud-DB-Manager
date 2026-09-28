import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import toast from 'react-hot-toast';

const AUTOSAVE_KEY = 'dual_db_manager_autosave_query';
const AUTOSAVE_INTERVAL = 5000; // 5 seconds
const AUTOSAVE_TTL_HOURS = 2; // Clear draft after 2 hours

interface AutoSaveData {
  query: string;
  selectedDatabase: string;
  selectedPgSchema: string;
  selectedMode: string;
  timestamp: number;
}

/**
 * Draft autosave for the console's shared query.
 *
 * `enabled` is false for editors that aren't the console's — the composer's,
 * say — since those edit their own text: restoring a draft there would
 * overwrite the console's query, and saving one would overwrite the draft.
 */
export const useAutoSave = (enabled = true) => {
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
    if (!enabled || hasRestoredRef.current) return;
    hasRestoredRef.current = true;

    try {
      const saved = localStorage.getItem(AUTOSAVE_KEY);
      if (saved) {
        const data: AutoSaveData = JSON.parse(saved);

        // Check if draft is within TTL
        const maxAge = AUTOSAVE_TTL_HOURS * 60 * 60 * 1000;
        if (Date.now() - data.timestamp > maxAge) {
          localStorage.removeItem(AUTOSAVE_KEY);
          return;
        }

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
  }, [enabled, setCurrentQuery, setSelectedDatabase, setSelectedPgSchema, setSelectedMode]);

  // Auto-save query when it changes
  useEffect(() => {
    // Clear any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Don't save if query is empty
    if (!enabled || !currentQuery.trim()) {
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
  }, [enabled, currentQuery, selectedDatabase, selectedPgSchema, selectedMode]);

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
      // Don't clear currentQuery - let user keep working with the same query
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
