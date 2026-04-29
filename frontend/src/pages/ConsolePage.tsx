import { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  AppBar,
  Toolbar,
  Typography,
  IconButton,
  Avatar,
  Menu,
  MenuItem,
  Grid,
  Drawer,
  Button,
  Stack,
} from '@mui/material';
import HistoryIcon from '@mui/icons-material/History';
import LogoutIcon from '@mui/icons-material/Logout';
import PeopleIcon from '@mui/icons-material/People';
import RefreshIcon from '@mui/icons-material/Refresh';
import StorageIcon from '@mui/icons-material/Storage';
import MemoryIcon from '@mui/icons-material/Memory';
import TableRowsIcon from '@mui/icons-material/TableRows';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import HubIcon from '@mui/icons-material/Hub';
import { authAPI, schemaAPI } from '../services/api';
import { Role } from '../constants/roles';
import { useAppStore } from '../store/appStore';
import toast from 'react-hot-toast';
import SQLEditor from '../components/Editor/SQLEditor';
import DatabaseSelector from '../components/Selector/DatabaseSelector';
import ResultsPanel from '../components/Results/ResultsPanel';
import QueryHistory from '../components/History/QueryHistory';
import RedisCommandForm from '../components/Redis/RedisCommandForm';
import RedisResultsPanel from '../components/Redis/RedisResultsPanel';
import RedisCacheClearer from '../components/Redis/RedisCacheClearer';
import RedisHistory from '../components/Redis/RedisHistory';
import ClickhouseToolbar from '../components/Clickhouse/ClickhouseToolbar';
import CsvBatchPanel from '../components/CsvBatch/CsvBatchPanel';
import MigrationToolbar from '../components/Migrations/MigrationToolbar';
import MigrationSummaryBar from '../components/Migrations/MigrationSummaryBar';
import MigrationResultsView from '../components/Migrations/MigrationResultsView';
import MigrationActionBar from '../components/Migrations/MigrationActionBar';
import { useMigrationsStore } from '../store/migrationsStore';
import type { QueryResponse, RedisCommandResponse } from '../types';

import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';

type ManagerMode = 'db' | 'redis' | 'batch' | 'migrations' | 'clickhouse';

// Roles that see Redis Manager + Batch Query (general DML access).
// RELEASE_MANAGER is intentionally excluded — schema-change scope only.
const REDIS_BATCH_ROLES: Role[] = [Role.MASTER, Role.USER, Role.READER];

// Roles that see DB Manager / Migrations (RELEASE_MANAGER joins the read+DDL crowd here).
const DB_AND_MIGRATIONS_ROLES: Role[] = [Role.MASTER, Role.USER, Role.READER, Role.RELEASE_MANAGER];

const TAB_CONFIG: Array<{ mode: ManagerMode; label: string; icon: React.ReactNode; visibleTo: Role[] }> = [
  { mode: 'db', label: 'DB Manager', icon: <StorageIcon sx={{ fontSize: 18 }} />, visibleTo: DB_AND_MIGRATIONS_ROLES },
  { mode: 'redis', label: 'Redis Manager', icon: <MemoryIcon sx={{ fontSize: 18 }} />, visibleTo: REDIS_BATCH_ROLES },
  { mode: 'batch', label: 'Batch Query', icon: <TableRowsIcon sx={{ fontSize: 18 }} />, visibleTo: REDIS_BATCH_ROLES },
  { mode: 'migrations', label: 'Migrations', icon: <CompareArrowsIcon sx={{ fontSize: 18 }} />, visibleTo: DB_AND_MIGRATIONS_ROLES },
  { mode: 'clickhouse', label: 'Clickhouse Manager', icon: <HubIcon sx={{ fontSize: 18 }} />, visibleTo: [Role.MASTER, Role.CKH_MANAGER] },
];

const tabsForRole = (role: Role | undefined) =>
  role ? TAB_CONFIG.filter((t) => t.visibleTo.includes(role)) : [];

const PillToggle = ({ managerMode, setManagerMode, userRole }: { managerMode: ManagerMode; setManagerMode: (m: ManagerMode) => void; userRole: Role }) => {
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [indicator, setIndicator] = useState({ left: 3, width: 0 });
  const visibleTabs = tabsForRole(userRole);

  useEffect(() => {
    const el = tabRefs.current[managerMode];
    if (el) {
      const parent = el.parentElement;
      if (parent) {
        const parentRect = parent.getBoundingClientRect();
        const tabRect = el.getBoundingClientRect();
        setIndicator({
          left: tabRect.left - parentRect.left,
          width: tabRect.width,
        });
      }
    }
  }, [managerMode]);

  return (
    <Box
      sx={{
        display: 'flex',
        bgcolor: 'rgba(255,255,255,0.08)',
        borderRadius: '20px',
        p: '3px',
        position: 'relative',
      }}
    >
      {/* Sliding indicator — auto-sized to active tab */}
      <Box
        sx={{
          position: 'absolute',
          top: 3,
          left: indicator.left,
          width: indicator.width,
          height: 'calc(100% - 6px)',
          borderRadius: '17px',
          bgcolor: 'primary.main',
          opacity: 0.25,
          border: '1px solid',
          borderColor: 'primary.main',
          transition: 'left 0.3s cubic-bezier(0.4, 0, 0.2, 1), width 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      />
      {visibleTabs.map((tab) => (
        <Box
          key={tab.mode}
          ref={(el: HTMLDivElement | null) => { tabRefs.current[tab.mode] = el; }}
          onClick={() => setManagerMode(tab.mode)}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            px: 1.5,
            py: 0.75,
            borderRadius: '17px',
            cursor: 'pointer',
            position: 'relative',
            zIndex: 1,
            color: managerMode === tab.mode ? '#fff' : 'rgba(255,255,255,0.5)',
            transition: 'color 0.25s ease',
            fontSize: '0.8rem',
            fontWeight: 500,
            userSelect: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {tab.icon}
          {tab.label}
        </Box>
      ))}
    </Box>
  );
};

// Track last sync time so we don't re-fetch on every page reload
const SYNC_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
let lastSyncTime = 0;

const MigrationsContent = () => {
  const loadConfig = useMigrationsStore((s) => s.loadConfig);
  const loadRefs = useMigrationsStore((s) => s.loadRefs);
  const refreshRepo = useMigrationsStore((s) => s.refreshRepo);
  const config = useMigrationsStore((s) => s.config);
  const [isInit, setIsInit] = useState(false);
  const [initStatus, setInitStatus] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  // null = haven't checked yet; otherwise structured status
  const [repoStatus, setRepoStatus] = useState<import('../services/migrationsApi').RepoStatus | null>(null);
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const waitForRepo = async (): Promise<void> => {
      const { migrationsAPI } = await import('../services/migrationsApi');
      // Poll repo-status every 2s until READY (or ERROR — we surface that to the user)
      for (;;) {
        try {
          const status = await migrationsAPI.getRepoStatus();
          setRepoStatus(status);
          if (status.state === 'READY' || status.state === 'ERROR') return;
        } catch {
          // transient — keep polling
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    };

    const init = async () => {
      setInitStatus('Checking repository status...');
      await waitForRepo();

      // If clone errored, leave the user on the status screen — don't force a load that will 503.
      const finalStatus = await (await import('../services/migrationsApi')).migrationsAPI.getRepoStatus();
      if (finalStatus.state !== 'READY') {
        setIsInit(true); // render error state via repoStatus
        return;
      }

      const now = Date.now();
      const needsSync = now - lastSyncTime > SYNC_COOLDOWN_MS;

      setInitStatus('Loading configuration...');
      await loadConfig();

      if (needsSync) {
        setInitStatus('Fetching latest branches and tags...');
        await loadRefs();
        setInitStatus('Syncing repository...');
        await refreshRepo();
        lastSyncTime = Date.now();
      } else {
        if (!useMigrationsStore.getState().refs) {
          setInitStatus('Loading refs...');
          await loadRefs();
        }
      }

      setIsInit(true);
    };
    init();
  }, []);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refreshRepo();
    } finally {
      setIsRefreshing(false);
    }
  };

  if (!isInit) {
    // While the backend is cloning the NammaYatri repo on this pod, surface a
    // clear "first-pod-startup" message instead of a blank spinner.
    const cloning = repoStatus?.state === 'CLONING';
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', py: 8, gap: 2 }}>
        <CircularProgress size={36} />
        <Typography variant="body1" color="text.secondary">
          {cloning ? 'Cloning NammaYatri repo on backend pod…' : initStatus}
        </Typography>
        {cloning && (
          <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 420, textAlign: 'center' }}>
            This happens once per pod startup (1–3 min). The rest of the app is fully usable while this runs — only the Migrations tab waits on the clone.
          </Typography>
        )}
        <LinearProgress sx={{ width: 300 }} />
      </Box>
    );
  }

  // Clone errored — show actionable message + retry button.
  if (repoStatus?.state === 'ERROR') {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', py: 8, gap: 2, px: 4 }}>
        <Typography variant="h6" color="error">Repository clone failed</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 600, textAlign: 'center' }}>
          {repoStatus.error || 'Unknown error'}
        </Typography>
        <Button variant="contained" startIcon={<RefreshIcon />} onClick={async () => {
          setIsInit(false);
          setRepoStatus(null);
          initRef.current = false;
          // re-trigger the init useEffect by toggling — easiest is reload.
          window.location.reload();
        }}>Retry</Button>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', p: 1, gap: 1.5, position: 'relative' }}>
      {/* Refresh overlay */}
      {isRefreshing && (
        <Box sx={{
          position: 'absolute', inset: 0, zIndex: 10,
          bgcolor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
          borderRadius: 1,
        }}>
          <CircularProgress size={40} />
          <Typography variant="body1" color="white">Pulling latest changes from repository...</Typography>
          <LinearProgress sx={{ width: 250 }} />
        </Box>
      )}

      <MigrationToolbar onRefresh={handleRefresh} />
      <MigrationSummaryBar />
      <Box sx={{ flex: 1, overflow: 'auto' }}>
        <MigrationResultsView />
      </Box>
      <MigrationActionBar />
    </Box>
  );
};

const ConsolePage = () => {
  const navigate = useNavigate();
  const user = useAppStore(s => s.user);
  const setUser = useAppStore(s => s.setUser);
  const showHistory = useAppStore(s => s.showHistory);
  const setShowHistory = useAppStore(s => s.setShowHistory);
  const setCurrentQuery = useAppStore(s => s.setCurrentQuery);
  const managerMode = useAppStore(s => s.managerMode);
  const setManagerMode = useAppStore(s => s.setManagerMode);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [currentResult, setCurrentResult] = useState<QueryResponse | null>(null);
  const [redisResult, setRedisResult] = useState<RedisCommandResponse | null>(null);
  const [clickhouseResult, setClickhouseResult] = useState<QueryResponse | null>(null);
  const [refreshingConfig, setRefreshingConfig] = useState(false);
  const resultsPanelRef = useRef<HTMLDivElement>(null);
  const redisResultsPanelRef = useRef<HTMLDivElement>(null);
  const clickhouseResultsPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Check authentication. Snap managerMode to a role-allowed tab BEFORE
    // setUser fires, so the first render with a non-null user already has the
    // correct active tab. This avoids briefly mounting tabs the user can't
    // see (e.g. CKH_MANAGER landing on the persisted 'db' default).
    const checkAuth = async () => {
      try {
        const currentUser = await authAPI.getCurrentUser();
        const allowed = tabsForRole(currentUser.role);
        if (allowed.length && !allowed.some((t) => t.mode === managerMode)) {
          setManagerMode(allowed[0].mode);
        }
        setUser(currentUser);
      } catch (error) {
        navigate('/login');
      }
    };

    checkAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Safety net: if the active tab ever becomes hidden for the current role
  // (e.g. devtools-edited sessionStorage), snap to the first allowed tab.
  useEffect(() => {
    if (!user) return;
    const allowed = tabsForRole(user.role);
    if (allowed.length === 0) return;
    if (!allowed.some((t) => t.mode === managerMode)) {
      setManagerMode(allowed[0].mode);
    }
  }, [user, managerMode, setManagerMode]);

  const handleLogout = async () => {
    try {
      await authAPI.logout();
      setUser(null);
      setCurrentQuery(''); // Clear the query from editor
      navigate('/login');
      toast.success('Logged out successfully');
    } catch (error) {
      toast.error('Logout failed');
    }
  };

  const handleRefreshConfig = async () => {
    setRefreshingConfig(true);
    try {
      schemaAPI.clearCache();
      await schemaAPI.getConfiguration();
      toast.success('Configuration refreshed successfully!');
      // Trigger a re-render by updating a state or force refresh the page
      window.location.reload();
    } catch (error) {
      toast.error('Failed to refresh configuration');
    } finally {
      setRefreshingConfig(false);
    }
  };

  const handleQueryExecute = useCallback((result: QueryResponse) => {
    setCurrentResult(result);

    // Auto-scroll to results panel after results render
    setTimeout(() => {
      if (resultsPanelRef.current) {
        resultsPanelRef.current.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
          inline: 'nearest'
        });
      }
    }, 200);
  }, []);

  const handleRedisResult = useCallback((result: RedisCommandResponse) => {
    setRedisResult(result);

    setTimeout(() => {
      if (redisResultsPanelRef.current) {
        redisResultsPanelRef.current.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
          inline: 'nearest'
        });
      }
    }, 200);
  }, []);

  const handleClickhouseExecute = useCallback((result: QueryResponse) => {
    setClickhouseResult(result);
    setTimeout(() => {
      clickhouseResultsPanelRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
        inline: 'nearest',
      });
    }, 200);
  }, []);

  if (!user) {
    return <Box>Loading...</Box>;
  }

  // Role-aware panel visibility. Panels not allowed for the current role are
  // not mounted at all — avoids running their mount-time effects (e.g. config
  // fetches in DatabaseSelector, git ref loads in MigrationsContent) for users
  // that have no business there. Allowed but inactive panels stay mounted so
  // the existing opacity-driven tab transitions preserve their internal state.
  const canSee = (mode: ManagerMode) =>
    TAB_CONFIG.find((t) => t.mode === mode)?.visibleTo.includes(user.role) ?? false;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Top Bar */}
      <AppBar position="static" elevation={2}>
        <Toolbar>
          <Typography variant="h6" component="div" noWrap>
            {managerMode === 'db' ? 'Multi-Cloud DB Manager'
              : managerMode === 'redis' ? 'Redis Manager'
              : managerMode === 'batch' ? 'Batch Query Manager'
              : managerMode === 'clickhouse' ? 'Clickhouse Manager'
              : 'DB Migration Verifier'}
          </Typography>

          <Box sx={{ flexGrow: 1 }} />

          {/* Smooth pill toggle — auto-width based on content */}
          <PillToggle managerMode={managerMode} setManagerMode={setManagerMode} userRole={user.role} />

          <Box sx={{ flexGrow: 1 }} />

          <Stack direction="row" spacing={2} alignItems="center">
            {user.role === 'MASTER' && (
              <Button
                color="inherit"
                startIcon={<PeopleIcon />}
                onClick={() => navigate('/users')}
              >
                Users
              </Button>
            )}

            <Button
              color="inherit"
              startIcon={<HistoryIcon />}
              onClick={() => setShowHistory(!showHistory)}
            >
              History
            </Button>

            <Button
              color="inherit"
              startIcon={<RefreshIcon />}
              onClick={handleRefreshConfig}
              disabled={refreshingConfig}
            >
              {refreshingConfig ? 'Refreshing...' : 'Refresh'}
            </Button>

            <IconButton
              onClick={(e) => setAnchorEl(e.currentTarget)}
              sx={{ p: 0 }}
            >
              <Avatar
                alt={user.name}
                src={user.picture}
                sx={{ width: 32, height: 32 }}
              />
            </IconButton>

            <Menu
              anchorEl={anchorEl}
              open={Boolean(anchorEl)}
              onClose={() => setAnchorEl(null)}
            >
              <MenuItem disabled>
                <Box>
                  <Typography variant="subtitle2">{user.name}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {user.email}
                  </Typography>
                </Box>
              </MenuItem>
              <MenuItem onClick={handleLogout}>
                <LogoutIcon fontSize="small" sx={{ mr: 1 }} />
                Logout
              </MenuItem>
            </Menu>
          </Stack>
        </Toolbar>
      </AppBar>

      {/* Main Content */}
      <Box sx={{ display: 'flex', flexGrow: 1, overflow: 'hidden' }}>
        {/* Main Area */}
        <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <Box sx={{ p: 2, height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
            {/* DB Manager View */}
            {canSee('db') && (
            <Box
              key="db-view"
              sx={{
                position: managerMode === 'db' ? 'relative' : 'absolute',
                inset: managerMode === 'db' ? undefined : 0,
                opacity: managerMode === 'db' ? 1 : 0,
                pointerEvents: managerMode === 'db' ? 'auto' : 'none',
                transition: 'opacity 0.3s ease',
                flexGrow: managerMode === 'db' ? 1 : undefined,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                p: managerMode === 'db' ? 0 : 2,
              }}
            >
              <Grid container spacing={2} sx={{ flexGrow: 1, overflow: 'hidden' }}>
                <Grid item xs={12} md={showHistory ? 8 : 12} sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <Box sx={{ overflowY: 'auto', flex: 1 }}>
                    <Stack spacing={2} sx={{ p: 1 }}>
                      <DatabaseSelector onExecute={handleQueryExecute} />
                      <Box sx={{ height: '400px' }}>
                        <SQLEditor />
                      </Box>
                      {currentResult && (
                        <Box ref={resultsPanelRef}>
                          <ResultsPanel result={currentResult} />
                        </Box>
                      )}
                    </Stack>
                  </Box>
                </Grid>
                {showHistory && (
                  <Grid item xs={12} md={4} sx={{ height: '100%' }}>
                    <QueryHistory />
                  </Grid>
                )}
              </Grid>
            </Box>
            )}

            {/* Redis Manager View */}
            {canSee('redis') && (
            <Box
              key="redis-view"
              sx={{
                position: managerMode === 'redis' ? 'relative' : 'absolute',
                inset: managerMode === 'redis' ? undefined : 0,
                opacity: managerMode === 'redis' ? 1 : 0,
                pointerEvents: managerMode === 'redis' ? 'auto' : 'none',
                transition: 'opacity 0.3s ease',
                flexGrow: managerMode === 'redis' ? 1 : undefined,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                p: managerMode === 'redis' ? 0 : 2,
              }}
            >
              <Grid container spacing={2} sx={{ flexGrow: 1, overflow: 'hidden' }}>
                <Grid item xs={12} md={showHistory ? 8 : 12} sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <Box sx={{ overflowY: 'auto', flex: 1 }}>
                    <Stack spacing={2} sx={{ p: 1 }}>
                      <RedisCommandForm onResult={handleRedisResult} />
                      {redisResult && (
                        <Box ref={redisResultsPanelRef}>
                          <RedisResultsPanel result={redisResult} />
                        </Box>
                      )}
                      <RedisCacheClearer />
                    </Stack>
                  </Box>
                </Grid>
                {showHistory && (
                  <Grid item xs={12} md={4} sx={{ height: '100%' }}>
                    <RedisHistory />
                  </Grid>
                )}
              </Grid>
            </Box>
            )}

            {/* Batch Query Manager View */}
            {canSee('batch') && (
            <Box
              key="batch-view"
              sx={{
                position: managerMode === 'batch' ? 'relative' : 'absolute',
                inset: managerMode === 'batch' ? undefined : 0,
                opacity: managerMode === 'batch' ? 1 : 0,
                pointerEvents: managerMode === 'batch' ? 'auto' : 'none',
                transition: 'opacity 0.3s ease',
                flexGrow: managerMode === 'batch' ? 1 : undefined,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                p: managerMode === 'batch' ? 0 : 2,
              }}
            >
              <Box sx={{ overflowY: 'auto', flex: 1 }}>
                <Stack spacing={2} sx={{ p: 1 }}>
                  <DatabaseSelector onExecute={handleQueryExecute} compact />
                  <CsvBatchPanel />
                </Stack>
              </Box>
            </Box>
            )}

            {/* DB Migrations View */}
            {canSee('migrations') && (
            <Box
              key="migrations-view"
              sx={{
                position: managerMode === 'migrations' ? 'relative' : 'absolute',
                inset: managerMode === 'migrations' ? undefined : 0,
                opacity: managerMode === 'migrations' ? 1 : 0,
                pointerEvents: managerMode === 'migrations' ? 'auto' : 'none',
                transition: 'opacity 0.3s ease',
                flexGrow: managerMode === 'migrations' ? 1 : undefined,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                p: managerMode === 'migrations' ? 0 : 2,
              }}
            >
              <MigrationsContent />
            </Box>
            )}

            {/* Clickhouse Manager View */}
            {canSee('clickhouse') && (
            <Box
              key="clickhouse-view"
              sx={{
                position: managerMode === 'clickhouse' ? 'relative' : 'absolute',
                inset: managerMode === 'clickhouse' ? undefined : 0,
                opacity: managerMode === 'clickhouse' ? 1 : 0,
                pointerEvents: managerMode === 'clickhouse' ? 'auto' : 'none',
                transition: 'opacity 0.3s ease',
                flexGrow: managerMode === 'clickhouse' ? 1 : undefined,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                p: managerMode === 'clickhouse' ? 0 : 2,
              }}
            >
              <Grid container spacing={2} sx={{ flexGrow: 1, overflow: 'hidden' }}>
                <Grid item xs={12} md={showHistory ? 8 : 12} sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <Box sx={{ overflowY: 'auto', flex: 1 }}>
                    <Stack spacing={2} sx={{ p: 1 }}>
                      <ClickhouseToolbar onExecute={handleClickhouseExecute} />
                      <Box sx={{ height: '400px' }}>
                        <SQLEditor />
                      </Box>
                      {clickhouseResult && (
                        <Box ref={clickhouseResultsPanelRef}>
                          <ResultsPanel result={clickhouseResult} />
                        </Box>
                      )}
                    </Stack>
                  </Box>
                </Grid>
                {showHistory && (
                  <Grid item xs={12} md={4} sx={{ height: '100%' }}>
                    <QueryHistory database="clickhouse" />
                  </Grid>
                )}
              </Grid>
            </Box>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  );
};

export default ConsolePage;
