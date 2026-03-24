import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  AppBar,
  Toolbar,
  Typography,
  IconButton,
  Button,
  LinearProgress,
  CircularProgress,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useAppStore } from '../store/appStore';
import { useMigrationsStore } from '../store/migrationsStore';
import { authAPI } from '../services/api';
import MigrationToolbar from '../components/Migrations/MigrationToolbar';
import MigrationSummaryBar from '../components/Migrations/MigrationSummaryBar';
import MigrationResultsView from '../components/Migrations/MigrationResultsView';
import MigrationActionBar from '../components/Migrations/MigrationActionBar';

const MigrationsPage = () => {
  const navigate = useNavigate();
  const user = useAppStore((s) => s.user);
  const setUser = useAppStore((s) => s.setUser);
  const loadConfig = useMigrationsStore((s) => s.loadConfig);
  const loadRefs = useMigrationsStore((s) => s.loadRefs);
  const refreshRepo = useMigrationsStore((s) => s.refreshRepo);
  const [isInitializing, setIsInitializing] = useState(true);
  const [initStatus, setInitStatus] = useState('Checking authentication...');
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    const init = async () => {
      try {
        setInitStatus('Checking authentication...');
        const currentUser = await authAPI.getCurrentUser();
        setUser(currentUser);

        setInitStatus('Fetching latest branches and tags...');
        await Promise.all([loadConfig(), loadRefs()]);

        setInitStatus('Pulling latest changes from repository...');
        await refreshRepo();

        setIsInitializing(false);
      } catch {
        navigate('/login');
      }
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

  if (!user || isInitializing) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 2 }}>
        <CircularProgress size={40} />
        <Typography variant="body1" color="text.secondary">
          {initStatus}
        </Typography>
        <LinearProgress sx={{ width: 300 }} />
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <AppBar position="static" elevation={2}>
        <Toolbar>
          <IconButton edge="start" color="inherit" onClick={() => navigate('/')} sx={{ mr: 1 }}>
            <ArrowBackIcon />
          </IconButton>
          <Typography variant="h6" component="div" sx={{ flex: 1 }}>
            Migration Verifier
          </Typography>
          <Button
            color="inherit"
            startIcon={isRefreshing ? <CircularProgress size={16} color="inherit" /> : <RefreshIcon />}
            onClick={handleRefresh}
            disabled={isRefreshing}
            size="small"
          >
            {isRefreshing ? 'Pulling...' : 'Refresh Repo'}
          </Button>
        </Toolbar>
      </AppBar>

      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', gap: 1.5 }}>
        <MigrationToolbar />
        <MigrationSummaryBar />
        <MigrationResultsView />
      </Box>

      <MigrationActionBar />
    </Box>
  );
};

export default MigrationsPage;
