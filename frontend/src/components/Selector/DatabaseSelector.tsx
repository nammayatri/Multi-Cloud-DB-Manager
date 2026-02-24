import { useEffect, useState, useRef } from 'react';
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
  Typography,
  LinearProgress,
  Checkbox,
  FormControlLabel,
  Tooltip,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import InfoIcon from '@mui/icons-material/Info';
import { useAppStore } from '../../store/appStore';
import { queryAPI, schemaAPI } from '../../services/api';
import toast from 'react-hot-toast';
import type { QueryResponse, DatabaseConfiguration, DatabaseInfo } from '../../types';
import QueryWarningDialog from '../Dialog/QueryWarningDialog';
import ReplicationDialog from '../Dialog/ReplicationDialog';
import { detectDangerousQueries } from '../../services/queryValidation.service';
import type { ValidationWarning } from '../../services/queryValidation.service';

interface DatabaseSelectorProps {
  onExecute: (result: QueryResponse) => void;
}

interface DatabaseOption {
  value: string; // Database name (e.g., 'bpp', 'bap')
  label: string; // Display label (e.g., 'Driver (BPP)')
  schemas: string[];
  defaultSchema: string;
}

const POLL_INTERVAL = 1000; // 1 second polling

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
    currentExecutionId,
    setCurrentExecutionId,
    continueOnError,
    setContinueOnError,
    user,
  } = useAppStore();

  const [databaseOptions, setDatabaseOptions] = useState<DatabaseOption[]>([]);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [showWarningDialog, setShowWarningDialog] = useState(false);
  const [currentWarning, setCurrentWarning] = useState<ValidationWarning | null>(null);
  const [pendingExecution, setPendingExecution] = useState(false);
  const [verificationPassword, setVerificationPassword] = useState('');
  const [executionModes, setExecutionModes] = useState<Array<{ value: string; label: string; cloudName: string }>>([]);
  const [cloudNames, setCloudNames] = useState<{ primary: string; secondary: string[] }>({ primary: '', secondary: [] });
  const [showReplicationDialog, setShowReplicationDialog] = useState(false);
  const [detectedTables, setDetectedTables] = useState<Array<{ schema: string; table: string }>>([]);
  const dbConfigRef = useRef<DatabaseConfiguration | null>(null);
  
  // Execution state
  const [executionProgress, setExecutionProgress] = useState<{ current: number; total: number } | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

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
      dbConfigRef.current = config;

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

  const pollExecutionStatus = async (executionId: string) => {
    try {
      const status = await queryAPI.getStatus(executionId);
      
      // Update progress
      if (status.progress) {
        setExecutionProgress({
          current: status.progress.currentStatement,
          total: status.progress.totalStatements
        });
      }

      // Check if execution is complete
      if (status.status === 'completed' || status.status === 'failed' || status.status === 'cancelled') {
        // Stop polling
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }

        setIsExecuting(false);
        setCurrentExecutionId(null);
        setExecutionProgress(null);

        // Show results if available (including partial results when cancelled)
        if (status.result) {
          onExecute(status.result);
        }

        // Detect CREATE TABLE for replication popup (check primary result regardless of overall status)
        if (status.result && (status.status === 'completed' || status.status === 'failed')) {
          const primaryCloud = cloudNames.primary;
          const modeIncludesPrimary = selectedMode === 'both' || selectedMode === primaryCloud;
          const primaryDbInfo = dbConfigRef.current?.primary.databases.find(
            (db) => db.name === selectedDatabase
          );
          const hasPublication = !!primaryDbInfo?.publicationName;
          const primaryResult = status.result[primaryCloud];

          if (modeIncludesPrimary && hasPublication && primaryResult?.success) {
            const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:("?[a-zA-Z_][a-zA-Z0-9_]*"?)\.)?("?[a-zA-Z_][a-zA-Z0-9_]*"?)/i;
            const foundTables: Array<{ schema: string; table: string }> = [];

            const checkStatement = (stmt: { success: boolean; statement?: string; result?: any }) => {
              if (stmt.success && stmt.result?.command?.startsWith('CREATE') && stmt.statement) {
                const match = stmt.statement.match(createTableRegex);
                if (match) {
                  const schema = match[1]?.replace(/"/g, '') || selectedPgSchema;
                  const table = match[2]?.replace(/"/g, '') || '';
                  if (table) {
                    foundTables.push({ schema, table });
                  }
                }
              }
            };

            if (primaryResult.results && Array.isArray(primaryResult.results)) {
              primaryResult.results.forEach(checkStatement);
            } else if (primaryResult.result?.command?.startsWith('CREATE')) {
              const queryText = getQueryToExecute();
              const match = queryText.match(createTableRegex);
              if (match) {
                const schema = match[1]?.replace(/"/g, '') || selectedPgSchema;
                const table = match[2]?.replace(/"/g, '') || '';
                if (table) {
                  foundTables.push({ schema, table });
                }
              }
            }

            if (foundTables.length > 0) {
              setDetectedTables(foundTables);
              setShowReplicationDialog(true);
            }
          }
        }

        // Show appropriate message based on status
        if (status.status === 'completed') {
          toast.success('Query executed successfully!');
        } else if (status.status === 'cancelled') {
          toast('Query was cancelled', { icon: '⚠️' });
        } else if (status.status === 'failed') {
          if (status.error) {
            toast.error(status.error);
          } else {
            toast.error('Query execution failed');
          }
        }
      }
    } catch (error: any) {
      console.error('Failed to poll execution status:', error);
      // Stop polling on error
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      setIsExecuting(false);
      setCurrentExecutionId(null);
      setExecutionProgress(null);
      toast.error('Failed to get execution status');
    }
  };

  const executeQueryInternal = async (password?: string) => {
    const queryToExecute = getQueryToExecute();

    setIsExecuting(true);
    setExecutionProgress(null);

    try {
      // Validate query first
      const validation = await queryAPI.validate(queryToExecute);
      if (!validation.valid) {
        toast.error(validation.error || 'Invalid query');
        setIsExecuting(false);
        return;
      }

      // Start execution (returns immediately with executionId)
      const { executionId } = await queryAPI.execute({
        query: queryToExecute,
        database: selectedDatabase,
        mode: selectedMode,
        pgSchema: selectedPgSchema,
        password, // Include password if provided
        continueOnError,
      });

      setCurrentExecutionId(executionId);

      // Clear any existing polling interval first
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }

      // Start polling for status
      pollIntervalRef.current = setInterval(() => {
        pollExecutionStatus(executionId);
      }, POLL_INTERVAL);

      // Initial poll
      pollExecutionStatus(executionId);

    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to execute query');
      setIsExecuting(false);
      setCurrentExecutionId(null);
      setExecutionProgress(null);
    }
  };

  const handleCancelExecution = async () => {
    if (!currentExecutionId) return;

    try {
      await queryAPI.cancel(currentExecutionId);
      // Don't show toast here - wait for the actual cancellation status from polling
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to cancel query');
    }
  };

  const handleExecute = async () => {
    const queryToExecute = getQueryToExecute();

    if (!queryToExecute.trim()) {
      toast.error('Please enter a query');
      return;
    }

    // Check for dangerous queries (pass user role for role-aware warnings)
    const warning = detectDangerousQueries(queryToExecute, user?.role);
    if (warning) {
      setCurrentWarning(warning);
      setShowWarningDialog(true);
      setPendingExecution(true);
      return;
    }

    // No warning, execute directly
    await executeQueryInternal();
  };

  const handleConfirmExecution = async (password?: string) => {
    setShowWarningDialog(false);
    setCurrentWarning(null);
    setPendingExecution(false);
    await executeQueryInternal(password);
  };

  // Register execute handler on store ref so Monaco keybinding can call it
  const { executeRef } = useAppStore();
  useEffect(() => {
    executeRef.current = handleExecute;
    return () => { executeRef.current = null; };
  }, [handleExecute, executeRef]);

  const handleCancelWarning = () => {
    setShowWarningDialog(false);
    setCurrentWarning(null);
    setPendingExecution(false);
  };

  return (
    <>
      <QueryWarningDialog
        open={showWarningDialog}
        warning={currentWarning}
        onConfirm={handleConfirmExecution}
        onCancel={handleCancelWarning}
        requiresPassword={currentWarning?.requiresPassword || false}
        selectedMode={selectedMode}
        cloudNames={cloudNames}
      />

      <ReplicationDialog
        open={showReplicationDialog}
        tables={detectedTables}
        database={selectedDatabase}
        onClose={() => {
          setShowReplicationDialog(false);
          setDetectedTables([]);
        }}
      />

      <Paper elevation={2} sx={{ p: 2 }}>
        <Stack spacing={2}>
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

            {/* Continue on Error Toggle */}
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              <Tooltip title="Run all statements even if some fail (e.g., column already exists)">
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={continueOnError}
                      onChange={(e) => setContinueOnError(e.target.checked)}
                      disabled={isExecuting}
                      size="small"
                    />
                  }
                  label={
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <Typography variant="body2" color="text.secondary">
                        Continue on error
                      </Typography>
                      <InfoIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                    </Box>
                  }
                />
              </Tooltip>
            </Box>

            {/* Execute/Cancel Button */}
            {isExecuting ? (
              <Button
                variant="contained"
                color="error"
                size="large"
                startIcon={<StopIcon />}
                onClick={handleCancelExecution}
                sx={{ minWidth: 150 }}
              >
                Cancel
              </Button>
            ) : (
              <Button
                variant="contained"
                color="success"
                size="large"
                startIcon={<PlayArrowIcon />}
                onClick={handleExecute}
                disabled={!currentQuery.trim()}
                sx={{ minWidth: 150 }}
              >
                Execute
              </Button>
            )}
          </Stack>

          {/* Progress Bar */}
          {isExecuting && executionProgress && executionProgress.total > 0 && (
            <Box sx={{ width: '100%' }}>
              <LinearProgress 
                variant="determinate" 
                value={(executionProgress.current / executionProgress.total) * 100} 
              />
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                Executing statement {executionProgress.current} of {executionProgress.total}
              </Typography>
            </Box>
          )}

          {isExecuting && (!executionProgress || executionProgress.total === 0) && (
            <Box sx={{ width: '100%' }}>
              <LinearProgress />
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                Executing query...
              </Typography>
            </Box>
          )}
        </Stack>
      </Paper>
    </>
  );
};

export default DatabaseSelector;
