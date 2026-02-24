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
  ToggleButtonGroup,
  ToggleButton,
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

          <ToggleButtonGroup
            value={managerMode}
            exclusive
            onChange={(_, value) => value && setManagerMode(value)}
            size="small"
            sx={{
              bgcolor: 'rgba(255,255,255,0.1)',
              '& .MuiToggleButton-root': {
                color: 'rgba(255,255,255,0.7)',
                borderColor: 'rgba(255,255,255,0.3)',
                '&.Mui-selected': {
                  color: '#fff',
                  bgcolor: 'rgba(255,255,255,0.2)',
                },
              },
            }}
          >
            <ToggleButton value="db">
              <StorageIcon sx={{ mr: 0.5, fontSize: 18 }} />
              DB Manager
            </ToggleButton>
            <ToggleButton value="redis">
              <MemoryIcon sx={{ mr: 0.5, fontSize: 18 }} />
              Redis Manager
            </ToggleButton>
          </ToggleButtonGroup>

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
          <Box sx={{ p: 2, height: '100%', display: 'flex', flexDirection: 'column' }}>
            {managerMode === 'db' ? (
              /* DB Manager View */
              <Grid container spacing={2} sx={{ flexGrow: 1, overflow: 'hidden' }}>
                {/* Left Column - Editor */}
                <Grid item xs={12} md={showHistory ? 8 : 12} sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <Box sx={{ overflowY: 'auto', flex: 1 }}>
                    <Stack spacing={2} sx={{ p: 1 }}>
                      {/* Database Selector */}
                      <DatabaseSelector onExecute={handleQueryExecute} />

                      {/* SQL Editor */}
                      <Box sx={{ height: '400px' }}>
                        <SQLEditor />
                      </Box>

                      {/* Results - Only show after first execution */}
                      {currentResult && (
                        <Box ref={resultsPanelRef}>
                          <ResultsPanel result={currentResult} />
                        </Box>
                      )}
                    </Stack>
                  </Box>
                </Grid>

                {/* Right Column - History (conditional) */}
                {showHistory && (
                  <Grid item xs={12} md={4} sx={{ height: '100%' }}>
                    <QueryHistory />
                  </Grid>
                )}
              </Grid>
            ) : (
              /* Redis Manager View */
              <Grid container spacing={2} sx={{ flexGrow: 1, overflow: 'hidden' }}>
                <Grid item xs={12} md={showHistory ? 8 : 12} sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <Box sx={{ overflowY: 'auto', flex: 1 }}>
                    <Stack spacing={2} sx={{ p: 1 }}>
                      {/* Redis Command Form */}
                      <RedisCommandForm onResult={handleRedisResult} />

                      {/* Redis Results */}
                      {redisResult && (
                        <Box ref={redisResultsPanelRef}>
                          <RedisResultsPanel result={redisResult} />
                        </Box>
                      )}

                      {/* Cache Clearer */}
                      <RedisCacheClearer />
                    </Stack>
                  </Box>
                </Grid>

                {/* Right Column - Redis History (conditional) */}
                {showHistory && (
                  <Grid item xs={12} md={4} sx={{ height: '100%' }}>
                    <RedisHistory />
                  </Grid>
                )}
              </Grid>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  );
};

export default ConsolePage;
