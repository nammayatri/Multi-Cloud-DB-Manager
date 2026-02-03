import { useEffect, useState } from 'react';
import {
  Box,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Button,
  Paper,
  Stack,
  Chip,
  CircularProgress,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { useAppStore } from '../../store/appStore';
import { queryAPI, schemaAPI } from '../../services/api';
import toast from 'react-hot-toast';
import type { QueryResponse, DatabaseConfiguration, DatabaseInfo } from '../../types';
import QueryWarningDialog from '../Dialog/QueryWarningDialog';
import { detectDangerousQueries } from '../../services/queryValidation.service';
import type { ValidationWarning } from '../../services/queryValidation.service';
import { useAutoSave } from '../../hooks/useAutoSave';

interface DatabaseSelectorProps {
  onExecute: (result: QueryResponse) => void;
}

interface DatabaseOption {
  value: string; // Database name (e.g., 'bpp', 'bap')
  label: string; // Display label (e.g., 'Driver (BPP)')
  schemas: string[];
  defaultSchema: string;
}

const DatabaseSelector = ({ onExecute }: DatabaseSelectorProps) => {
  const {
    selectedDatabase,
    setSelectedDatabase,
    selectedPgSchema,
    setSelectedPgSchema,
    selectedMode,
    setSelectedMode,
    currentQuery,
    getQueryToExecute,
    isExecuting,
    setIsExecuting,
    setExecuteQuery,
  } = useAppStore();

  const { clearDraftOnSuccess } = useAutoSave();

  const [databaseOptions, setDatabaseOptions] = useState<DatabaseOption[]>([]);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [showWarningDialog, setShowWarningDialog] = useState(false);
  const [currentWarning, setCurrentWarning] = useState<ValidationWarning | null>(null);
  const [pendingExecution, setPendingExecution] = useState(false);
  const [executionModes, setExecutionModes] = useState<Array<{ value: string; label: string; cloudName: string }>>([]);
  const [cloudNames, setCloudNames] = useState<{ primary: string; secondary: string[] }>({ primary: '', secondary: [] });

  // Shared function to fetch configuration
  const fetchConfiguration = async (forceRefresh = false) => {
    try {
      if (forceRefresh) {
        // Clear cache before fetching
        schemaAPI.clearCache();
      }

      const config: DatabaseConfiguration = await schemaAPI.getConfiguration();

      // Build unique database options (use primary cloud as source of truth)
      // All clouds should have same database structure (bpp, bap, etc.)
      const options: DatabaseOption[] = config.primary.databases.map((db) => ({
        value: db.name, // Database name (e.g., 'bpp', 'bap')
        label: db.label, // Display label (e.g., 'Driver (BPP)')
        schemas: db.schemas,
        defaultSchema: db.defaultSchema
      }));

      setDatabaseOptions(options);

      // Build execution modes dynamically
      const primaryCloud = config.primary.cloudName;
      const secondaryClouds = config.secondary.map(s => s.cloudName);

      setCloudNames({ primary: primaryCloud, secondary: secondaryClouds });

      // Build "Both" label with all clouds
      const allClouds = [primaryCloud, ...secondaryClouds].map(c => c.toUpperCase()).join(' + ');
      const modes: Array<{ value: string; label: string; cloudName: string }> = [
        { value: 'both', label: `Multi-Cloud (${allClouds})`, cloudName: 'both' }
      ];

      if (primaryCloud) {
        modes.push({ value: primaryCloud, label: `${primaryCloud.toUpperCase()} Only`, cloudName: primaryCloud });
      }

      secondaryClouds.forEach(cloud => {
        modes.push({ value: cloud, label: `${cloud.toUpperCase()} Only`, cloudName: cloud });
      });

      setExecutionModes(modes);

      // Set initial database and schema if available
      if (options.length > 0) {
        // If current selection is not valid, reset to first option
        const currentOption = options.find(opt => opt.value === selectedDatabase);
        if (!currentOption) {
          setSelectedDatabase(options[0].value);
          setSelectedPgSchema(options[0].defaultSchema);
        } else {
          setSelectedPgSchema(currentOption.defaultSchema);
        }
      }

      if (forceRefresh) {
        toast.success('Configuration refreshed successfully!');
      }
    } catch (error) {
      console.error('Failed to load database configuration:', error);
      toast.error('Failed to load database configuration');

      // Fallback to hardcoded options
      setDatabaseOptions([
        {
          value: 'db1',
          label: 'Database 1',
          schemas: ['public'],
          defaultSchema: 'public'
        },
        {
          value: 'db2',
          label: 'Database 2',
          schemas: ['public'],
          defaultSchema: 'public'
        }
      ]);

      // Fallback execution modes
      setExecutionModes([
        { value: 'both', label: 'Both (CLOUD1 + CLOUD2)', cloudName: 'both' },
        { value: 'cloud1', label: 'CLOUD1 Only', cloudName: 'cloud1' },
        { value: 'cloud2', label: 'CLOUD2 Only', cloudName: 'cloud2' }
      ]);

      setCloudNames({ primary: 'cloud1', secondary: ['cloud2'] });
    }
  };

  // Fetch database configuration on mount
  useEffect(() => {
    let cancelled = false;

    const loadInitialConfig = async () => {
      setLoadingConfig(true);
      try {
        await fetchConfiguration(false);
      } finally {
        if (!cancelled) {
          setLoadingConfig(false);
        }
      }
    };

    loadInitialConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  // Update schemas when database changes
  useEffect(() => {
    const currentOption = databaseOptions.find(opt => opt.value === selectedDatabase);
    if (currentOption) {
      setSelectedPgSchema(currentOption.defaultSchema);
    }
  }, [selectedDatabase, databaseOptions, setSelectedPgSchema]);

  const executeQueryInternal = async () => {
    const queryToExecute = getQueryToExecute();

    setIsExecuting(true);

    try {
      // Validate query first
      const validation = await queryAPI.validate(queryToExecute);
      if (!validation.valid) {
        toast.error(validation.error || 'Invalid query');
        setIsExecuting(false);
        return;
      }

      // Execute query
      const result = await queryAPI.execute({
        query: queryToExecute,
        database: selectedDatabase,
        mode: selectedMode,
        pgSchema: selectedPgSchema,
      });

      onExecute(result);

      if (result.success) {
        toast.success('Query executed successfully!');
        // Clear auto-saved draft after successful execution
        clearDraftOnSuccess();
      } else {
        toast.error('Query execution failed');
      }
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to execute query');
    } finally {
      setIsExecuting(false);
    }
  };

  const handleExecute = async () => {
    const queryToExecute = getQueryToExecute();

    if (!queryToExecute.trim()) {
      toast.error('Please enter a query');
      return;
    }

    // Check for dangerous queries
    const warning = detectDangerousQueries(queryToExecute);
    if (warning) {
      setCurrentWarning(warning);
      setShowWarningDialog(true);
      setPendingExecution(true);
      return;
    }

    // No warning, execute directly
    await executeQueryInternal();
  };

  const handleConfirmExecution = async () => {
    setShowWarningDialog(false);
    setCurrentWarning(null);
    setPendingExecution(false);
    await executeQueryInternal();
  };

  const handleCancelExecution = () => {
    setShowWarningDialog(false);
    setCurrentWarning(null);
    setPendingExecution(false);
  };

  // Store execute function in app store for keyboard shortcuts
  useEffect(() => {
    setExecuteQuery(handleExecute);
    return () => setExecuteQuery(null);
  }, [selectedDatabase, selectedMode, selectedPgSchema, setExecuteQuery]);

  return (
    <>
      <QueryWarningDialog
        open={showWarningDialog}
        warning={currentWarning}
        onConfirm={handleConfirmExecution}
        onCancel={handleCancelExecution}
      />

      <Paper elevation={2} sx={{ p: 2 }}>
        <Stack direction="row" spacing={2} alignItems="center">
          {/* Database Selector */}
          <FormControl sx={{ flex: 1 }}>
            <InputLabel>Database</InputLabel>
            <Select
              value={selectedDatabase}
              label="Database"
              onChange={(e) => setSelectedDatabase(e.target.value)}
              disabled={isExecuting || loadingConfig}
            >
              {loadingConfig ? (
                <MenuItem value="">
                  <CircularProgress size={20} />
                </MenuItem>
              ) : (
                databaseOptions.map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {option.label}
                  </MenuItem>
                ))
              )}
            </Select>
          </FormControl>

          {/* PostgreSQL Schema Selector */}
          <FormControl sx={{ flex: 1 }}>
            <InputLabel>PostgreSQL Schema</InputLabel>
            <Select
              value={selectedPgSchema}
              label="PostgreSQL Schema"
              onChange={(e) => setSelectedPgSchema(e.target.value)}
              disabled={isExecuting || loadingConfig}
            >
              {loadingConfig ? (
                <MenuItem value="">
                  <CircularProgress size={20} />
                </MenuItem>
              ) : (
                databaseOptions
                  .find(opt => opt.value === selectedDatabase)
                  ?.schemas.map((schema) => (
                    <MenuItem key={schema} value={schema}>
                      {schema}
                    </MenuItem>
                  ))
              )}
            </Select>
          </FormControl>

          {/* Execution Mode Selector */}
          <FormControl sx={{ flex: 1 }}>
            <InputLabel>Execution Mode</InputLabel>
            <Select
              value={selectedMode}
              label="Execution Mode"
              onChange={(e) => setSelectedMode(e.target.value as any)}
              disabled={isExecuting || loadingConfig}
            >
              {loadingConfig ? (
                <MenuItem value="">
                  <CircularProgress size={20} />
                </MenuItem>
              ) : (
                executionModes.map((mode) => (
                  <MenuItem key={mode.value} value={mode.value}>
                    {mode.label}
                  </MenuItem>
                ))
              )}
            </Select>
          </FormControl>

          {/* Status Chips */}
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            {selectedMode === 'both' && (
              <>
                <Chip label={cloudNames.primary.toUpperCase()} color="primary" size="small" />
                {cloudNames.secondary.map((cloud, index) => (
                  <Chip
                    key={cloud}
                    label={cloud.toUpperCase()}
                    color={index === 0 ? 'secondary' : 'info'}
                    size="small"
                  />
                ))}
              </>
            )}
            {selectedMode !== 'both' && executionModes.find(m => m.value === selectedMode) && (
              <Chip
                label={executionModes.find(m => m.value === selectedMode)?.label || selectedMode.toUpperCase()}
                color="primary"
                size="small"
              />
            )}
          </Box>

          <Box sx={{ flexGrow: 1 }} />

          {/* Execute Button */}
          <Button
            variant="contained"
            color="success"
            size="large"
            startIcon={<PlayArrowIcon />}
            onClick={handleExecute}
            disabled={isExecuting || !currentQuery.trim()}
            sx={{ minWidth: 150 }}
          >
            {isExecuting ? 'Executing...' : 'Execute'}
          </Button>
        </Stack>
      </Paper>
    </>
  );
};

export default DatabaseSelector;
