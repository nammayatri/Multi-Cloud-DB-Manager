import { useEffect, useState, lazy, Suspense } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import CircleIcon from '@mui/icons-material/Circle';
import SyncIcon from '@mui/icons-material/Sync';
import BackupIcon from '@mui/icons-material/Backup';
import CodeIcon from '@mui/icons-material/Code';
import { useAppStore } from '../../store/appStore';
import { clickhouseAPI } from '../../services/api';
import toast from 'react-hot-toast';
import type { QueryResponse } from '../../types';

// Heavy panels: loaded lazily so they don't block the initial render
const ColumnSyncPanel = lazy(() => import('./ColumnSyncPanel'));
const BackfillPanel = lazy(() => import('./BackfillPanel'));

type ChTab = 'query' | 'sync' | 'backfill';
type ChStatus = 'unknown' | 'ok' | 'error' | 'disabled';

const statusColor: Record<ChStatus, 'default' | 'success' | 'error' | 'warning'> = {
  unknown: 'default',
  ok: 'success',
  error: 'error',
  disabled: 'warning',
};

const panelLoader = (
  <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 8 }}>
    <CircularProgress size={28} />
  </Box>
);

interface ClickhouseToolbarProps {
  onExecute: (response: QueryResponse) => void;
  queryEditor?: React.ReactNode;
}

const ClickhouseToolbar = ({ onExecute, queryEditor }: ClickhouseToolbarProps) => {
  const isExecuting = useAppStore(s => s.isExecuting);
  const setIsExecuting = useAppStore(s => s.setIsExecuting);
  const getQueryToExecute = useAppStore(s => s.getQueryToExecute);
  const executeRef = useAppStore(s => s.executeRef);
  const managerMode = useAppStore(s => s.managerMode);

  const [status, setStatus] = useState<ChStatus>('unknown');
  const [statusDetail, setStatusDetail] = useState<string>('');
  const [activeTab, setActiveTab] = useState<ChTab>('query');
  const [visitedTabs, setVisitedTabs] = useState<Set<ChTab>>(new Set(['query']));

  // ── CH health check ──

  useEffect(() => {
    let cancelled = false;
    clickhouseAPI
      .getStatus()
      .then(s => {
        if (cancelled) return;
        const next: ChStatus =
          s.status === 'ok' ? 'ok' : s.status === 'disabled' ? 'disabled' : 'error';
        setStatus(next);
        setStatusDetail(s.host ? `${s.host} / ${s.database}` : s.message || '');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => { cancelled = true; };
  }, []);

  // ── Query execution ──

  const handleExecute = async () => {
    const query = getQueryToExecute().trim();
    if (!query) {
      toast.error('Editor is empty');
      return;
    }
    if (status === 'disabled') {
      toast.error('ClickHouse is not configured on this server');
      return;
    }

    setIsExecuting(true);
    try {
      const response = await clickhouseAPI.executeQuery(query);
      onExecute(response);
      const cloud = response.clickhouse;
      if (cloud?.success) {
        toast.success(`Query OK (${cloud.duration_ms}ms)`);
      }
    } catch (err: any) {
      const data = err?.response?.data;
      if (data) onExecute(data);
    } finally {
      setIsExecuting(false);
    }
  };

  // Wire Cmd+Enter from SQLEditor when on the query tab
  useEffect(() => {
    if (managerMode !== 'clickhouse' || activeTab !== 'query') return;
    executeRef.current = handleExecute;
    return () => {
      if (executeRef.current === handleExecute) {
        executeRef.current = null;
      }
    };
  });

  // ── Tab switch ──

  const handleTabChange = (_: React.SyntheticEvent, val: ChTab) => {
    setActiveTab(val);
    setVisitedTabs(prev => new Set(prev).add(val));
  };

  // ── Render ──

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {/* Header bar */}
      <Paper elevation={1} sx={{ px: 2, py: 1 }}>
        <Stack direction="row" alignItems="center" spacing={2}>
          <Typography variant="subtitle2" fontWeight={700}>
            ClickHouse Manager
          </Typography>

          <Tooltip title={statusDetail || status}>
            <Chip
              size="small"
              color={statusColor[status]}
              icon={<CircleIcon sx={{ fontSize: 10 }} />}
              label={
                status === 'ok' ? 'connected' :
                status === 'disabled' ? 'disabled' :
                status === 'error' ? 'unreachable' : 'checking…'
              }
              variant="outlined"
            />
          </Tooltip>

          <Box flexGrow={1} />

          {/* Tabs */}
          <Tabs
            value={activeTab}
            onChange={handleTabChange}
            textColor="primary"
            indicatorColor="primary"
            sx={{ minHeight: 36 }}
          >
            <Tab
              value="query"
              label="Query"
              icon={<CodeIcon sx={{ fontSize: 16 }} />}
              iconPosition="start"
              sx={{ minHeight: 36, py: 0.5, fontSize: 13 }}
            />
            <Tab
              value="sync"
              label="Column Sync"
              icon={<SyncIcon sx={{ fontSize: 16 }} />}
              iconPosition="start"
              sx={{ minHeight: 36, py: 0.5, fontSize: 13 }}
              disabled={status === 'disabled'}
            />
            <Tab
              value="backfill"
              label="Data Backfill"
              icon={<BackupIcon sx={{ fontSize: 16 }} />}
              iconPosition="start"
              sx={{ minHeight: 36, py: 0.5, fontSize: 13 }}
              disabled={status === 'disabled'}
            />
          </Tabs>

          <Box flexGrow={1} />

          {/* Execute button — only on Query tab */}
          {activeTab === 'query' && (
            <Button
              variant="contained"
              color="primary"
              startIcon={<PlayArrowIcon />}
              onClick={handleExecute}
              disabled={isExecuting || status === 'disabled'}
              size="small"
            >
              {isExecuting ? 'Executing…' : 'Execute (⌘↵)'}
            </Button>
          )}
        </Stack>
      </Paper>

      {/* Panel content */}
      <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
        {/* Query tab content */}
        {activeTab === 'query' && (
          <Box sx={{ p: 1 }}>
            {queryEditor}
          </Box>
        )}

        {/* Column Sync tab */}
        {activeTab === 'sync' && visitedTabs.has('sync') && (
          <Suspense fallback={panelLoader}>
            <ColumnSyncPanel />
          </Suspense>
        )}

        {/* Data Backfill tab */}
        {activeTab === 'backfill' && visitedTabs.has('backfill') && (
          <Suspense fallback={panelLoader}>
            <BackfillPanel />
          </Suspense>
        )}
      </Box>
    </Box>
  );
};

export default ClickhouseToolbar;
