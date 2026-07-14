import React, { useEffect, useState, useRef } from 'react';
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
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  TextField,
} from '@mui/material';
import FingerprintIcon from '@mui/icons-material/Fingerprint';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import InfoIcon from '@mui/icons-material/Info';
import { useAppStore } from '../../store/appStore';
import { queryAPI, schemaAPI, toastNonApiError } from '../../services/api';
import toast from 'react-hot-toast';
import type { QueryResponse, DatabaseConfiguration, DatabaseInfo } from '../../types';
import QueryWarningDialog from '../Dialog/QueryWarningDialog';
import ReplicationDialog from '../Dialog/ReplicationDialog';
import { detectDangerousQueries } from '../../services/queryValidation.service';
import type { ValidationWarning } from '../../services/queryValidation.service';
import { buildDbMap, buildModesForDb } from './databaseTopology';
import type { DbMap, DbCloudEntry } from './databaseTopology';

interface DatabaseSelectorProps {
  onExecute: (result: QueryResponse) => void;
  compact?: boolean; // When true, hides Execute/Cancel/ContinueOnError — selector only
}

interface DatabaseOption {
  value: string; // Database name (e.g., 'bpp', 'bap')
  label: string; // Display label (e.g., 'Driver (BPP)')
  schemas: string[];
  defaultSchema: string;
}

const POLL_INTERVAL = 1000; // 1 second polling

const DatabaseSelector = ({ onExecute, compact = false }: DatabaseSelectorProps) => {
  const selectedDatabase = useAppStore(s => s.selectedDatabase);
  const setSelectedDatabase = useAppStore(s => s.setSelectedDatabase);
  const selectedPgSchema = useAppStore(s => s.selectedPgSchema);
  const setSelectedPgSchema = useAppStore(s => s.setSelectedPgSchema);
  const selectedMode = useAppStore(s => s.selectedMode);
  const setSelectedMode = useAppStore(s => s.setSelectedMode);
  const currentQuery = useAppStore(s => s.currentQuery);
  const getQueryToExecute = useAppStore(s => s.getQueryToExecute);
  const isExecuting = useAppStore(s => s.isExecuting);
  const setIsExecuting = useAppStore(s => s.setIsExecuting);
  const currentExecutionId = useAppStore(s => s.currentExecutionId);
  const setCurrentExecutionId = useAppStore(s => s.setCurrentExecutionId);
  const continueOnError = useAppStore(s => s.continueOnError);
  const setContinueOnError = useAppStore(s => s.setContinueOnError);
  const user = useAppStore(s => s.user);

  const [databaseOptions, setDatabaseOptions] = useState<DatabaseOption[]>([]);
  const [dbMap, setDbMap] = useState<DbMap>({});
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [showWarningDialog, setShowWarningDialog] = useState(false);
  const [currentWarning, setCurrentWarning] = useState<ValidationWarning | null>(null);
  const [pendingExecution, setPendingExecution] = useState(false);
  const [verificationPassword, setVerificationPassword] = useState('');
  const [executionModes, setExecutionModes] = useState<Array<{ value: string; label: string; cloudName: string }>>([]);
  const [cloudNames, setCloudNames] = useState<{ primary: string; secondary: string[] }>({ primary: '', secondary: [] });
  const [showReplicationDialog, setShowReplicationDialog] = useState(false);
  const [detectedTables, setDetectedTables] = useState<Array<{ schema: string; table: string }>>([]);
  const [showUuidDialog, setShowUuidDialog] = useState(false);
  const [uuidErrorMessage, setUuidErrorMessage] = useState<string>('');
  const [showIndexPasswordDialog, setShowIndexPasswordDialog] = useState(false);
  const [indexBlockedMessage, setIndexBlockedMessage] = useState<string>('');
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

      // Group databases by name across every cloud. The dropdown lists the
      // UNION of all database names (so a database that lives on only one cloud
      // — primary-only or secondary-only — still appears), not just the primary
      // cloud's databases.
      const map = buildDbMap(config);
      const options: DatabaseOption[] = Object.entries(map).map(([name, meta]) => ({
        value: name,
        label: meta.label,
        schemas: meta.schemas,
        defaultSchema: meta.defaultSchema,
      }));

      setDbMap(map);
      setDatabaseOptions(options);
      dbConfigRef.current = config;
      // Execution modes are derived per selected database in a dedicated effect
      // below (they depend on which clouds the chosen DB actually lives on).

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
      toastNonApiError(error, 'Failed to load database configuration');

      // Fallback to hardcoded options (execution modes derive from dbMap via the
      // per-database effect, so populate a matching fallback map here too).
      const fallbackCloud = (cloudType: string, role: 'primary' | 'secondary'): DbCloudEntry => ({
        cloudType,
        role,
      });
      const fallbackMap: DbMap = {
        db1: {
          label: 'Database 1',
          schemas: ['public'],
          defaultSchema: 'public',
          clouds: [fallbackCloud('cloud1', 'primary'), fallbackCloud('cloud2', 'secondary')],
          replicationEnabled: false,
        },
        db2: {
          label: 'Database 2',
          schemas: ['public'],
          defaultSchema: 'public',
          clouds: [fallbackCloud('cloud1', 'primary'), fallbackCloud('cloud2', 'secondary')],
          replicationEnabled: false,
        },
      };

      setDbMap(fallbackMap);
      setDatabaseOptions(
        Object.entries(fallbackMap).map(([name, meta]) => ({
          value: name,
          label: meta.label,
          schemas: meta.schemas,
          defaultSchema: meta.defaultSchema,
        }))
      );
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

  // Rebuild Execution Mode options whenever the selected database (or config)
  // changes. Modes are PER-DATABASE: a single-cloud database offers only its one
  // cloud and no "Multi-Cloud" option, because there is nothing to fan out to.
  useEffect(() => {
    const meta = dbMap[selectedDatabase];
    const modes = buildModesForDb(meta);
    setExecutionModes(modes);

    // Reflect the selected database's actual clouds (used by the status chips
    // and the post-CREATE replication detection).
    const primaryCloud = meta?.clouds.find(c => c.role === 'primary')?.cloudType || '';
    const secondaryClouds = meta
      ? meta.clouds.filter(c => c.role === 'secondary').map(c => c.cloudType)
      : [];
    setCloudNames({ primary: primaryCloud, secondary: secondaryClouds });

    // If the current mode is no longer valid for this database, fall back to the
    // default: Multi-Cloud when available, otherwise the single cloud.
    if (modes.length > 0 && !modes.some(m => m.value === selectedMode)) {
      setSelectedMode(modes[0].value as any);
    }
    // selectedMode intentionally excluded: we only re-validate on DB/config change,
    // not when the user deliberately picks a (valid) mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDatabase, dbMap, setSelectedMode]);

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
          const meta = dbMap[selectedDatabase];
          // Only prompt for replication when the database is genuinely
          // multi-cloud (a primary publisher AND a secondary subscriber).
          // Single-cloud databases (primary-only or secondary-only) never prompt.
          const replicationEnabled = !!meta?.replicationEnabled;
          const primaryCloud = meta?.clouds.find(c => c.role === 'primary')?.cloudType || cloudNames.primary;
          const modeIncludesPrimary = selectedMode === 'both' || selectedMode === primaryCloud;
          const primaryResult = status.result[primaryCloud];

          if (modeIncludesPrimary && replicationEnabled && primaryResult?.success) {
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
          if (status.errorCode === 'UUID_DIVERGENCE') {
            setUuidErrorMessage(status.error || '');
            setShowUuidDialog(true);
          } else if (status.error) {
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
      toastNonApiError(error, 'Failed to get execution status');
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
        password,
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
      const errMsg = error.response?.data?.error || '';
      // If backend signals protected table / blocked index creation, show info dialog
      if (errMsg.includes('CREATE INDEX is blocked') || errMsg.includes('protected table')) {
        setIndexBlockedMessage(errMsg);
        setShowIndexPasswordDialog(true);
        setIsExecuting(false);
        setCurrentExecutionId(null);
        setExecutionProgress(null);
        return;
      }
      // Safety net: the backend demands password verification for this query but
      // our client-side detection didn't prompt for one (rule drift). Re-open the
      // warning dialog with a password field so the user can retry, instead of
      // dead-ending on an error toast.
      if (errMsg.includes('Password verification required')) {
        setCurrentWarning({
          type: 'danger',
          title: 'Password Required',
          message: 'This query contains a sensitive operation that requires your password to execute.',
          affectedStatements: [],
          requiresPassword: true,
        });
        setShowWarningDialog(true);
        setPendingExecution(true);
        setIsExecuting(false);
        setCurrentExecutionId(null);
        setExecutionProgress(null);
        return;
      }
      // The axios interceptor already toasts API errors.
      toastNonApiError(error, 'Failed to execute query');
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
      // The axios interceptor already toasts API errors.
      toastNonApiError(error, 'Failed to cancel query');
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

  // Register execute handler on store ref so Monaco keybinding can call it.
  // Gated on managerMode: this component is rendered in both the DB and Batch
  // panels, so we own the slot only when one of those is active. Identity-
  // checked cleanup avoids clobbering a sibling that has already reclaimed.
  const executeRef = useAppStore(s => s.executeRef);
  const managerMode = useAppStore(s => s.managerMode);
  useEffect(() => {
    if (managerMode !== 'db' && managerMode !== 'batch') return;
    executeRef.current = handleExecute;
    return () => {
      if (executeRef.current === handleExecute) {
        executeRef.current = null;
      }
    };
  }, [handleExecute, executeRef, managerMode]);

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

            {!compact && <Box sx={{ flexGrow: 1 }} />}

            {/* Continue on Error Toggle — hidden in compact mode */}
            {!compact && (
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
            )}

            {/* Execute/Cancel Button — hidden in compact mode */}
            {!compact && (isExecuting ? (
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
            ))}
          </Stack>

          {/* Progress Bar — hidden in compact mode */}
          {!compact && isExecuting && executionProgress && executionProgress.total > 0 && (
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

          {!compact && isExecuting && (!executionProgress || executionProgress.total === 0) && (
            <Box sx={{ width: '100%' }}>
              <LinearProgress />
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                Executing query...
              </Typography>
            </Box>
          )}
        </Stack>
      </Paper>

      {/* UUID Divergence Dialog */}
      {(() => {
        const colMatch = uuidErrorMessage.match(/Columns with UUID defaults that must be explicitly set: ([^.]+)\./);
        const implicitCols = colMatch ? colMatch[1].split(',').map(c => c.trim()) : [];
        const isImplicit = implicitCols.length > 0;
        return (
          <Dialog open={showUuidDialog} onClose={() => setShowUuidDialog(false)} maxWidth="sm" fullWidth>
            <DialogTitle>⚠️ UUID Divergence Detected</DialogTitle>
            <DialogContent>
              <Alert severity="error" sx={{ mb: 2 }}>
                Running this INSERT on multiple clouds would generate <strong>different UUIDs on each cloud</strong>, causing data divergence.
              </Alert>

              {isImplicit && (
                <Box sx={{ mb: 2, p: 1.5, bgcolor: 'warning.main', borderRadius: 1 }}>
                  <Typography variant="body2" fontWeight="bold" color="warning.contrastText" sx={{ mb: 1 }}>
                    These columns have UUID defaults and are missing from your INSERT:
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                    {implicitCols.map(col => (
                      <Chip
                        key={col}
                        label={col}
                        size="small"
                        sx={{ fontFamily: 'monospace', fontWeight: 'bold', bgcolor: 'warning.dark', color: 'white' }}
                      />
                    ))}
                  </Box>
                </Box>
              )}

              <Typography variant="body2" fontWeight="bold" sx={{ mb: 1 }}>
                To fix this:
              </Typography>
              {isImplicit ? (
                <Stack spacing={0.75}>
                  <Typography variant="body2">1. Add the column(s) above to your INSERT column list</Typography>
                  <Typography variant="body2">2. Place your cursor at the corresponding value position</Typography>
                  <Typography variant="body2">3. Click <strong><FingerprintIcon sx={{ fontSize: 14, verticalAlign: 'middle' }} /> Generate UUID</strong> to insert an explicit UUID literal</Typography>
                  <Typography variant="body2">4. Repeat for each missing column, then re-run</Typography>
                </Stack>
              ) : (
                <Stack spacing={0.75}>
                  <Typography variant="body2">1. Place your cursor where <code>gen_random_uuid()</code> appears</Typography>
                  <Typography variant="body2">2. Click <strong><FingerprintIcon sx={{ fontSize: 14, verticalAlign: 'middle' }} /> Generate UUID</strong> in the editor toolbar</Typography>
                  <Typography variant="body2">3. It inserts an explicit UUID literal — same value used on all clouds</Typography>
                  <Typography variant="body2">4. Re-run the query</Typography>
                </Stack>
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setShowUuidDialog(false)} variant="contained">Got it</Button>
            </DialogActions>
          </Dialog>
        );
      })()}

      {/* Index creation blocked dialog — hard block on protected tables */}
      <Dialog open={showIndexPasswordDialog} onClose={() => setShowIndexPasswordDialog(false)} maxWidth="sm" fullWidth>
        <DialogTitle>🚫 Index Creation Blocked</DialogTitle>
        <DialogContent>
          <Alert severity="error" sx={{ mb: 2 }}>
            {indexBlockedMessage || 'CREATE INDEX is blocked on this table.'}
          </Alert>
          <Typography variant="body2" sx={{ mb: 1 }}>
            These tables are critical for production. Index creation is <strong>not allowed</strong> from this tool.
          </Typography>
          <Typography variant="body2">
            <strong>Please contact your administrator</strong> to run this index query through the proper operational process.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowIndexPasswordDialog(false)} variant="contained">Got it</Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default React.memo(DatabaseSelector);
