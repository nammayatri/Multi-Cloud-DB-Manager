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
import { authAPI, schemaAPI } from '../services/api';
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
import CsvBatchPanel from '../components/CsvBatch/CsvBatchPanel';
import MigrationToolbar from '../components/Migrations/MigrationToolbar';
import MigrationSummaryBar from '../components/Migrations/MigrationSummaryBar';
import MigrationResultsView from '../components/Migrations/MigrationResultsView';
import MigrationActionBar from '../components/Migrations/MigrationActionBar';
import { useMigrationsStore } from '../store/migrationsStore';
import type { QueryResponse, RedisCommandResponse } from '../types';

import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';

type ManagerMode = 'db' | 'redis' | 'batch' | 'migrations';

const TAB_CONFIG: Array<{ mode: ManagerMode; label: string; icon: React.ReactNode }> = [
  { mode: 'db', label: 'DB Manager', icon: <StorageIcon sx={{ fontSize: 18 }} /> },
  { mode: 'redis', label: 'Redis Manager', icon: <MemoryIcon sx={{ fontSize: 18 }} /> },
  { mode: 'batch', label: 'Batch Query', icon: <TableRowsIcon sx={{ fontSize: 18 }} /> },
  { mode: 'migrations', label: 'Migrations', icon: <CompareArrowsIcon sx={{ fontSize: 18 }} /> },
];

const PillToggle = ({ managerMode, setManagerMode }: { managerMode: ManagerMode; setManagerMode: (m: ManagerMode) => void }) => {
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [indicator, setIndicator] = useState({ left: 3, width: 0 });

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
      {TAB_CONFIG.map((tab) => (
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

const MigrationsContent = () => {
  const loadConfig = useMigrationsStore((s) => s.loadConfig);
  const loadRefs = useMigrationsStore((s) => s.loadRefs);
  const refreshRepo = useMigrationsStore((s) => s.refreshRepo);
  const config = useMigrationsStore((s) => s.config);
  const [isInit, setIsInit] = useState(false);
  const [initStatus, setInitStatus] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    const init = async () => {
      setInitStatus('Loading configuration...');
      await loadConfig();
      setInitStatus('Fetching latest branches and tags...');
      await loadRefs();
      setInitStatus('Pulling latest changes from repository...');
      await refreshRepo();
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
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', py: 8, gap: 2 }}>
        <CircularProgress size={36} />
        <Typography variant="body1" color="text.secondary">{initStatus}</Typography>
        <LinearProgress sx={{ width: 300 }} />
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', p: 1, gap: 1.5 }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Box sx={{ flex: 1 }}><MigrationToolbar /></Box>
        <Button
          variant="outlined"
          size="small"
          startIcon={isRefreshing ? <CircularProgress size={14} /> : <RefreshIcon />}
          onClick={handleRefresh}
          disabled={isRefreshing}
          sx={{ height: 40, whiteSpace: 'nowrap' }}
        >
          {isRefreshing ? 'Pulling...' : 'Refresh Repo'}
        </Button>
      </Stack>
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
  const [refreshingConfig, setRefreshingConfig] = useState(false);
  const resultsPanelRef = useRef<HTMLDivElement>(null);
  const redisResultsPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Check authentication
    const checkAuth = async () => {
      try {
        const currentUser = await authAPI.getCurrentUser();
        setUser(currentUser);
      } catch (error) {
        navigate('/login');
      }
    };

    checkAuth();
  }, []);

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

  if (!user) {
    return <Box>Loading...</Box>;
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Top Bar */}
      <AppBar position="static" elevation={2}>
        <Toolbar>
          <Typography variant="h6" component="div" noWrap>
            {managerMode === 'db' ? 'Multi-Cloud DB Manager' : managerMode === 'redis' ? 'Redis Manager' : managerMode === 'batch' ? 'Batch Query Manager' : 'DB Migration Verifier'}
          </Typography>

          <Box sx={{ flexGrow: 1 }} />

          {/* Smooth pill toggle — auto-width based on content */}
          <PillToggle managerMode={managerMode} setManagerMode={setManagerMode} />

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

            {/* Redis Manager View */}
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

            {/* Batch Query Manager View */}
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

            {/* DB Migrations View */}
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
          </Box>
        </Box>
      </Box>
    </Box>
  );
};

export default ConsolePage;
