import { useEffect, useState, useRef } from 'react';
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
import type { QueryResponse, RedisCommandResponse } from '../types';

const ConsolePage = () => {
  const navigate = useNavigate();
  const { user, setUser, showHistory, setShowHistory, setCurrentQuery, managerMode, setManagerMode } = useAppStore();
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

  const handleQueryExecute = (result: QueryResponse) => {
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
  };

  const handleRedisResult = (result: RedisCommandResponse) => {
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
  };

  if (!user) {
    return <Box>Loading...</Box>;
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Top Bar */}
      <AppBar position="static" elevation={2}>
        <Toolbar>
          <Typography variant="h6" component="div" noWrap>
            {managerMode === 'db' ? 'Dual DB Manager' : 'Redis Manager'}
          </Typography>

          <Box sx={{ flexGrow: 1 }} />

          {/* Smooth pill toggle */}
          <Box
            sx={{
              display: 'flex',
              bgcolor: 'rgba(255,255,255,0.08)',
              borderRadius: '20px',
              p: '3px',
              position: 'relative',
            }}
          >
            {/* Sliding indicator */}
            <Box
              sx={{
                position: 'absolute',
                top: 3,
                left: managerMode === 'db' ? 3 : 'calc(50% + 0px)',
                width: 'calc(50% - 3px)',
                height: 'calc(100% - 6px)',
                borderRadius: '17px',
                bgcolor: 'primary.main',
                opacity: 0.25,
                border: '1px solid',
                borderColor: 'primary.main',
                transition: 'left 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
              }}
            />
            {(['db', 'redis'] as const).map((mode) => (
              <Box
                key={mode}
                onClick={() => setManagerMode(mode)}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  px: 2,
                  py: 0.75,
                  borderRadius: '17px',
                  cursor: 'pointer',
                  position: 'relative',
                  zIndex: 1,
                  color: managerMode === mode ? '#fff' : 'rgba(255,255,255,0.5)',
                  transition: 'color 0.25s ease',
                  fontSize: '0.85rem',
                  fontWeight: 500,
                  userSelect: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                {mode === 'db' ? <StorageIcon sx={{ fontSize: 18 }} /> : <MemoryIcon sx={{ fontSize: 18 }} />}
                {mode === 'db' ? 'DB Manager' : 'Redis Manager'}
              </Box>
            ))}
          </Box>

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
          </Box>
        </Box>
      </Box>
    </Box>
  );
};

export default ConsolePage;
