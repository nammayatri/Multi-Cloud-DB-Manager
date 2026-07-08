import { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  InputAdornment,
  LinearProgress,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import SyncIcon from '@mui/icons-material/Sync';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import { clickhouseAPI, type ChTableInfo, type ChTableCheckResult } from '../../services/api';
import toast from 'react-hot-toast';

type TableStatus = 'unchecked' | 'checking' | 'synced' | 'columns_out_of_sync' | 'missing';

interface RowState {
  status: TableStatus;
  result?: ChTableCheckResult;
}

function rowKey(t: ChTableInfo): string {
  return `${t.pgDatabase}.${t.pgSchema}.${t.table}`;
}

function statusFromResult(result: ChTableCheckResult): TableStatus {
  if (!result.inCH) return 'missing';
  if (result.missingColumns.length > 0) return 'columns_out_of_sync';
  return 'synced';
}

const STATUS_CONFIG: Record<Exclude<TableStatus, 'unchecked' | 'checking'>, {
  label: string;
  color: 'success' | 'warning' | 'error';
  icon: React.ReactNode;
}> = {
  synced: {
    label: 'Synced',
    color: 'success',
    icon: <CheckCircleIcon sx={{ fontSize: 14 }} />,
  },
  columns_out_of_sync: {
    label: 'Columns out of sync',
    color: 'warning',
    icon: <WarningAmberIcon sx={{ fontSize: 14 }} />,
  },
  missing: {
    label: 'Missing from CH',
    color: 'error',
    icon: <ErrorOutlineIcon sx={{ fontSize: 14 }} />,
  },
};

interface TableRowProps {
  table: ChTableInfo;
  rowState: RowState;
  onCheck: (t: ChTableInfo) => void;
  onAction: (t: ChTableInfo, result: ChTableCheckResult) => void;
  actionLoading: boolean;
}

const TableRow = ({ table, rowState, onCheck, onAction, actionLoading }: TableRowProps) => {
  const { status, result } = rowState;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        px: 2,
        py: 1.25,
        borderRadius: 1,
        transition: 'background 0.15s',
        '&:hover': { bgcolor: 'action.hover' },
      }}
    >
      {/* Table name */}
      <Box sx={{ minWidth: 0, flexGrow: 1 }}>
        <Typography variant="body2" fontWeight={600} noWrap>
          {table.table}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap>
          {table.pgSchema} · {table.pgDatabase}
        </Typography>
      </Box>

      {/* Column info — only shown once a check has run */}
      {result && (
        <Tooltip
          title={
            <>
              <div>PG: {result.pgColumnCount} cols · CH: {result.chColumnCount} cols</div>
              {result.missingColumns.length > 0 && (
                <div>Missing in CH: {result.missingColumns.join(', ')}</div>
              )}
              {result.extraChColumns.length > 0 && (
                <div>CH-only (expected, not a gap): {result.extraChColumns.join(', ')}</div>
              )}
            </>
          }
        >
          <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
            {result.inCH ? `${result.chColumnCount}/${result.pgColumnCount} cols` : `${result.pgColumnCount} cols in PG`}
            {status === 'columns_out_of_sync' && (
              <Box component="span" sx={{ color: 'warning.main', ml: 0.5 }}>
                ({result.missingColumns.length} missing)
              </Box>
            )}
          </Typography>
        </Tooltip>
      )}

      {/* Status badge */}
      {status === 'unchecked' && (
        <Chip size="small" label="Not checked" variant="outlined" sx={{ fontSize: 11, height: 22 }} />
      )}
      {status !== 'unchecked' && status !== 'checking' && (
        <Chip
          size="small"
          label={STATUS_CONFIG[status].label}
          color={STATUS_CONFIG[status].color}
          icon={STATUS_CONFIG[status].icon as any}
          variant="outlined"
          sx={{ fontSize: 11, height: 22 }}
        />
      )}

      {/* Check / Re-check button */}
      <Tooltip title={status === 'unchecked' ? 'Check ClickHouse sync status' : 'Re-check'}>
        <span>
          <IconButton
            size="small"
            onClick={() => onCheck(table)}
            disabled={status === 'checking'}
          >
            {status === 'checking' ? (
              <CircularProgress size={16} />
            ) : (
              <FactCheckIcon fontSize="small" />
            )}
          </IconButton>
        </span>
      </Tooltip>

      {/* Action button — only once we know the real status from a check */}
      {result && status !== 'synced' && (
        <Button
          size="small"
          variant="contained"
          color={status === 'missing' ? 'primary' : 'warning'}
          disabled={actionLoading}
          onClick={() => onAction(table, result)}
          startIcon={
            actionLoading ? (
              <CircularProgress size={12} color="inherit" />
            ) : status === 'missing' ? (
              <AddCircleOutlineIcon />
            ) : (
              <SyncIcon />
            )
          }
          sx={{ fontSize: 12, py: 0.5, px: 1.5, minWidth: 130, whiteSpace: 'nowrap' }}
        >
          {actionLoading ? 'Working…' : status === 'missing' ? 'Create in CH' : 'Sync Columns'}
        </Button>
      )}
      {(!result || status === 'synced') && <Box sx={{ width: 130 }} />}
    </Box>
  );
};

const ColumnSyncPanel = () => {
  const [tables, setTables] = useState<ChTableInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedChDb, setSelectedChDb] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [actionLoading, setActionLoading] = useState<Set<string>>(new Set());
  const [checkResults, setCheckResults] = useState<Record<string, RowState>>({});

  const fetchTables = useCallback(async () => {
    setLoading(true);
    try {
      const { tables: t } = await clickhouseAPI.listTables();
      setTables(t);
      setCheckResults({});
    } catch {
      toast.error('Failed to load table list');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTables();
  }, [fetchTables]);

  const handleCheck = useCallback(async (t: ChTableInfo) => {
    const key = rowKey(t);
    setCheckResults(prev => ({ ...prev, [key]: { status: 'checking' } }));
    try {
      const result = await clickhouseAPI.checkTable(t.pgDatabase, t.pgSchema, t.table);
      setCheckResults(prev => ({ ...prev, [key]: { status: statusFromResult(result), result } }));
    } catch {
      toast.error(`Failed to check ${t.table}`);
      setCheckResults(prev => ({ ...prev, [key]: { status: 'unchecked' } }));
    }
  }, []);

  const handleAction = async (t: ChTableInfo, result: ChTableCheckResult) => {
    const key = rowKey(t);
    setActionLoading(prev => new Set(prev).add(key));
    try {
      const status = statusFromResult(result);
      let actionResult;
      if (status === 'missing') {
        actionResult = await clickhouseAPI.createTable(t.pgDatabase, t.pgSchema, t.table);
        if (actionResult.success) {
          toast.success(`✅ Created ${t.table} in ClickHouse (main + queue + MV)`);
        } else {
          toast.error(`Failed: ${actionResult.error || actionResult.details}`);
        }
      } else {
        actionResult = await clickhouseAPI.syncColumns(t.pgDatabase, t.pgSchema, t.table);
        if (actionResult.success) {
          toast.success(
            actionResult.action === 'skipped'
              ? `${t.table}: already up to date`
              : `✅ Synced columns for ${t.table}`,
          );
        } else {
          toast.error(`Failed: ${actionResult.error || actionResult.details}`);
        }
      }
      // Re-check just this table rather than reloading/re-checking the whole list
      await handleCheck(t);
    } catch {
      toast.error('Action failed — see server logs');
    } finally {
      setActionLoading(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const chDatabases = Array.from(new Set(tables.map(t => t.chDatabase)));

  const filtered = tables.filter(t => {
    if (selectedChDb !== 'all' && t.chDatabase !== selectedChDb) return false;
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      t.table.toLowerCase().includes(q) ||
      t.pgSchema.toLowerCase().includes(q) ||
      t.pgDatabase.toLowerCase().includes(q)
    );
  });

  // Group by pgDatabase
  const grouped = filtered.reduce<Record<string, ChTableInfo[]>>((acc, t) => {
    (acc[t.pgDatabase] = acc[t.pgDatabase] ?? []).push(t);
    return acc;
  }, {});

  const checkedCount = Object.values(checkResults).filter(
    r => r.status !== 'unchecked' && r.status !== 'checking',
  ).length;

  return (
    <Paper elevation={2} sx={{ p: 2, height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <Stack direction="row" alignItems="center" spacing={2} mb={2}>
        <Typography variant="subtitle1" fontWeight={700}>
          Column Sync
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {tables.length} tables{checkedCount > 0 ? ` · ${checkedCount} checked` : ''} — click{' '}
          <FactCheckIcon sx={{ fontSize: 13, verticalAlign: 'text-bottom' }} /> to check a table's CH sync status
        </Typography>
        <Box flexGrow={1} />
        <Tooltip title="Refresh table list">
          <IconButton size="small" onClick={fetchTables} disabled={loading}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {/* Filters: Search and DB Select */}
      <Stack direction="row" spacing={2} mb={2}>
        <TextField
          size="small"
          placeholder="Search tables, schemas, databases…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          sx={{ flexGrow: 1 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />

        <FormControl size="small" sx={{ minWidth: 220 }}>
          <InputLabel id="ch-db-select-label">ClickHouse Database</InputLabel>
          <Select
            labelId="ch-db-select-label"
            value={selectedChDb}
            label="ClickHouse Database"
            onChange={e => setSelectedChDb(e.target.value)}
          >
            <MenuItem value="all">All Databases</MenuItem>
            {chDatabases.map(db => (
              <MenuItem key={db} value={db}>
                {db}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Stack>

      {/* Loading bar */}
      {loading && <LinearProgress sx={{ mb: 1, borderRadius: 1 }} />}

      {/* Table list */}
      <Box sx={{ overflowY: 'auto', flexGrow: 1 }}>
        {!loading && tables.length === 0 && (
          <Typography color="text.secondary" align="center" sx={{ py: 6 }}>
            No tables found. Is ClickHouse configured?
          </Typography>
        )}
        {Object.entries(grouped).map(([dbName, dbTables]) => (
          <Box key={dbName} mb={2}>
            <Typography
              variant="caption"
              fontWeight={700}
              color="text.secondary"
              sx={{ px: 2, display: 'block', mb: 0.5, textTransform: 'uppercase', letterSpacing: 1 }}
            >
              {dbName}
            </Typography>
            <Paper variant="outlined" sx={{ borderRadius: 1, overflow: 'hidden' }}>
              {dbTables.map((t, idx) => {
                const key = rowKey(t);
                return (
                  <Box key={key}>
                    {idx > 0 && <Divider />}
                    <TableRow
                      table={t}
                      rowState={checkResults[key] ?? { status: 'unchecked' }}
                      onCheck={handleCheck}
                      onAction={handleAction}
                      actionLoading={actionLoading.has(key)}
                    />
                  </Box>
                );
              })}
            </Paper>
          </Box>
        ))}
      </Box>
    </Paper>
  );
};

export default ColumnSyncPanel;
