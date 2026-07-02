import { useEffect, useState, useRef, useCallback } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  InputLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import HistoryIcon from '@mui/icons-material/History';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import StorageIcon from '@mui/icons-material/Storage';
import { clickhouseAPI, type BackfillJob } from '../../services/api';
import { schemaAPI } from '../../services/api';
import toast from 'react-hot-toast';

const POLL_INTERVAL_MS = 2000;

// ──────────────────────────────────────────────
// Status display helpers
// ──────────────────────────────────────────────

const STATUS_COLORS: Record<BackfillJob['status'], 'default' | 'primary' | 'success' | 'error' | 'warning'> = {
  running: 'primary',
  completed: 'success',
  failed: 'error',
  cancelled: 'warning',
};

const GRANULARITY_COLORS: Record<BackfillJob['granularity'], 'success' | 'warning' | 'error'> = {
  monthly: 'success',
  weekly: 'warning',
  daily: 'error',
};

// ──────────────────────────────────────────────
// Job Progress Card
// ──────────────────────────────────────────────

interface JobCardProps {
  job: BackfillJob;
  onCancel: (id: string) => void;
  cancelLoading: boolean;
}

const JobCard = ({ job, onCancel, cancelLoading }: JobCardProps) => {
  const progress = job.totalChunks > 0
    ? Math.round((job.completedChunks / job.totalChunks) * 100)
    : 0;

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} mb={1}>
        <Typography variant="body2" fontWeight={700} flexGrow={1}>
          {job.pgSchema}.{job.table}
        </Typography>
        <Chip
          size="small"
          label={job.status}
          color={STATUS_COLORS[job.status]}
          variant="outlined"
          sx={{ fontSize: 11 }}
        />
        {job.status === 'running' && (
          <Chip
            size="small"
            label={job.granularity}
            color={GRANULARITY_COLORS[job.granularity]}
            variant="filled"
            sx={{ fontSize: 11 }}
          />
        )}
      </Stack>

      <Typography variant="caption" color="text.secondary" display="block" mb={1}>
        {job.fromDate} → {job.toDate} · DB: {job.pgDatabase} → {job.chDatabase}
      </Typography>

      {job.status === 'running' && (
        <>
          <LinearProgress
            variant={job.totalChunks > 0 ? 'determinate' : 'indeterminate'}
            value={progress}
            sx={{ borderRadius: 1, mb: 1 }}
          />
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="caption" color="text.secondary">
              {job.currentPeriod}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {job.completedChunks}/{job.totalChunks} chunks · {job.rowsInserted.toLocaleString()} rows
            </Typography>
          </Stack>
        </>
      )}

      {job.status === 'completed' && (
        <Typography variant="caption" color="success.main">
          ✅ Completed — {job.rowsInserted.toLocaleString()} rows inserted
        </Typography>
      )}

      {job.status === 'failed' && (
        <Alert severity="error" sx={{ mt: 1, py: 0.5, fontSize: 12 }}>
          {job.error}
        </Alert>
      )}

      {job.status === 'cancelled' && (
        <Typography variant="caption" color="warning.main">
          Cancelled after {job.rowsInserted.toLocaleString()} rows
        </Typography>
      )}

      {job.status === 'running' && (
        <Box mt={1}>
          <Button
            size="small"
            color="error"
            variant="outlined"
            startIcon={cancelLoading ? <CircularProgress size={12} /> : <StopIcon />}
            disabled={cancelLoading}
            onClick={() => onCancel(job.id)}
          >
            Cancel
          </Button>
        </Box>
      )}
    </Paper>
  );
};

// ──────────────────────────────────────────────
// Main Panel
// ──────────────────────────────────────────────

const BackfillPanel = () => {
  // Form state
  const [pgDatabase, setPgDatabase] = useState('');
  const [pgSchema, setPgSchema] = useState('');
  const [table, setTable] = useState('');
  const [chDatabase, setChDatabase] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // DB configuration
  const [dbOptions, setDbOptions] = useState<Array<{ name: string; schemas: string[] }>>([]);
  const [configLoading, setConfigLoading] = useState(true);

  // Job tracking
  const [jobs, setJobs] = useState<BackfillJob[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [cancelLoading, setCancelLoading] = useState<Set<string>>(new Set());

  const pollTimers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  // ── Load DB config ──

  useEffect(() => {
    schemaAPI.getConfiguration()
      .then(cfg => {
        const dbs = cfg.primary.databases ?? [];
        setDbOptions(
          dbs.map(db => ({
            name: db.name,
            schemas: db.schemas,
          })),
        );
        if (dbs.length > 0) {
          setPgDatabase(dbs[0].name);
          if (dbs[0].schemas.length > 0) setPgSchema(dbs[0].schemas[0]);
        }
      })
      .catch(() => toast.error('Failed to load database configuration'))
      .finally(() => setConfigLoading(false));
  }, []);

  // Derive CH database from pgSchema (convention: pgSchema = chDatabase)
  useEffect(() => {
    if (pgSchema) setChDatabase(pgSchema);
  }, [pgSchema]);

  // ── Polling ──

  const pollJob = useCallback(async (id: string) => {
    try {
      const updated = await clickhouseAPI.getBackfillStatus(id);
      setJobs(prev => prev.map(j => j.id === id ? updated : j));

      if (updated.status !== 'running') {
        const timer = pollTimers.current.get(id);
        if (timer) {
          clearInterval(timer);
          pollTimers.current.delete(id);
        }
        if (updated.status === 'completed') {
          toast.success(`Backfill for ${updated.table} completed — ${updated.rowsInserted.toLocaleString()} rows`);
        } else if (updated.status === 'failed') {
          toast.error(`Backfill failed: ${updated.error}`);
        }
      }
    } catch {
      // silently ignore polling errors
    }
  }, []);

  const startPolling = useCallback((id: string) => {
    if (pollTimers.current.has(id)) return;
    const timer = setInterval(() => pollJob(id), POLL_INTERVAL_MS);
    pollTimers.current.set(id, timer);
  }, [pollJob]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      pollTimers.current.forEach(t => clearInterval(t));
    };
  }, []);

  // ── Form submit ──

  const handleStart = async () => {
    if (!pgDatabase || !pgSchema || !table || !chDatabase || !fromDate || !toDate) {
      toast.error('Please fill in all fields');
      return;
    }

    setSubmitting(true);
    try {
      const { backfillId } = await clickhouseAPI.startBackfill({
        pgDatabase, pgSchema, table, chDatabase, fromDate, toDate,
      });

      // Fetch initial status and add to list
      const initial = await clickhouseAPI.getBackfillStatus(backfillId);
      setJobs(prev => [initial, ...prev]);
      startPolling(backfillId);
      toast.success(`Backfill started for ${table}`);
    } catch {
      toast.error('Failed to start backfill');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Cancel ──

  const handleCancel = async (id: string) => {
    setCancelLoading(prev => new Set(prev).add(id));
    try {
      await clickhouseAPI.cancelBackfill(id);
      toast('Cancellation requested…', { icon: '⏹' });
    } catch {
      toast.error('Failed to cancel backfill');
    } finally {
      setCancelLoading(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  // ── Schema options for selected database ──

  const schemaOptions = dbOptions.find(d => d.name === pgDatabase)?.schemas ?? [];

  // ── Render ──

  const runningJobs = jobs.filter(j => j.status === 'running');
  const pastJobs = jobs.filter(j => j.status !== 'running');

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Form */}
      <Paper elevation={2} sx={{ p: 2.5, borderRadius: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1} mb={2}>
          <StorageIcon fontSize="small" color="primary" />
          <Typography variant="subtitle1" fontWeight={700}>
            Data Backfill
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
            PG → ClickHouse · Monthly / Weekly / Daily fallback
          </Typography>
        </Stack>

        <Stack spacing={2}>
          <Stack direction="row" spacing={2}>
            {/* PG Database */}
            <FormControl size="small" sx={{ minWidth: 180 }} disabled={configLoading}>
              <InputLabel>PG Database</InputLabel>
              <Select
                value={pgDatabase}
                label="PG Database"
                onChange={e => {
                  setPgDatabase(e.target.value);
                  const schemas = dbOptions.find(d => d.name === e.target.value)?.schemas ?? [];
                  setPgSchema(schemas[0] ?? '');
                }}
              >
                {dbOptions.map(d => (
                  <MenuItem key={d.name} value={d.name}>{d.name}</MenuItem>
                ))}
              </Select>
            </FormControl>

            {/* PG Schema */}
            <FormControl size="small" sx={{ minWidth: 200 }} disabled={configLoading || !pgDatabase}>
              <InputLabel>PG Schema (= CH Database)</InputLabel>
              <Select
                value={pgSchema}
                label="PG Schema (= CH Database)"
                onChange={e => setPgSchema(e.target.value)}
              >
                {schemaOptions.map(s => (
                  <MenuItem key={s} value={s}>{s}</MenuItem>
                ))}
              </Select>
            </FormControl>

            {/* Table */}
            <TextField
              size="small"
              label="Table name"
              value={table}
              onChange={e => setTable(e.target.value)}
              sx={{ minWidth: 200 }}
              placeholder="e.g. search_request"
            />
          </Stack>

          <Stack direction="row" spacing={2} alignItems="center">
            {/* Date range */}
            <Stack direction="row" spacing={1} alignItems="center">
              <CalendarTodayIcon fontSize="small" color="action" />
              <TextField
                size="small"
                label="From date"
                type="date"
                value={fromDate}
                onChange={e => setFromDate(e.target.value)}
                InputLabelProps={{ shrink: true }}
                sx={{ width: 160 }}
              />
              <Typography variant="caption" color="text.secondary">to</Typography>
              <TextField
                size="small"
                label="To date"
                type="date"
                value={toDate}
                onChange={e => setToDate(e.target.value)}
                InputLabelProps={{ shrink: true }}
                sx={{ width: 160 }}
              />
            </Stack>

            <Box flexGrow={1} />

            {/* CH Database (auto-derived, shown for confirmation) */}
            <Typography variant="caption" color="text.secondary">
              CH Database: <strong>{chDatabase || '—'}</strong>
            </Typography>

            <Button
              variant="contained"
              startIcon={submitting ? <CircularProgress size={14} color="inherit" /> : <PlayArrowIcon />}
              disabled={submitting || configLoading}
              onClick={handleStart}
            >
              {submitting ? 'Starting…' : 'Start Backfill'}
            </Button>
          </Stack>
        </Stack>

        {/* Strategy note */}
        <Alert severity="info" sx={{ mt: 2, fontSize: 12 }} icon={false}>
          <strong>Strategy:</strong> Scans PG by month. If a month fails → retries by week. If a week fails → retries by day. If a day fails → stops and reports the error.
        </Alert>
      </Paper>

      {/* Active jobs */}
      {runningJobs.length > 0 && (
        <Box>
          <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ display: 'block', mb: 1, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Active ({runningJobs.length})
          </Typography>
          <Stack spacing={1.5}>
            {runningJobs.map(job => (
              <JobCard
                key={job.id}
                job={job}
                onCancel={handleCancel}
                cancelLoading={cancelLoading.has(job.id)}
              />
            ))}
          </Stack>
        </Box>
      )}

      {/* Past jobs */}
      {pastJobs.length > 0 && (
        <Box>
          <Stack direction="row" alignItems="center" spacing={1} mb={1}>
            <HistoryIcon fontSize="small" color="action" />
            <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
              History ({pastJobs.length})
            </Typography>
          </Stack>
          <Stack spacing={1.5}>
            {pastJobs.map(job => (
              <JobCard
                key={job.id}
                job={job}
                onCancel={handleCancel}
                cancelLoading={cancelLoading.has(job.id)}
              />
            ))}
          </Stack>
        </Box>
      )}
    </Box>
  );
};

export default BackfillPanel;
