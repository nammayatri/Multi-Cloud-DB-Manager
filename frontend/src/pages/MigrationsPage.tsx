import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  AppBar,
  Toolbar,
  Typography,
  IconButton,
  Paper,
  Stack,
  Button,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useAppStore } from '../store/appStore';
import { useMigrationsStore } from '../store/migrationsStore';
import { authAPI } from '../services/api';
import MigrationToolbar from '../components/Migrations/MigrationToolbar';
import MigrationSummaryBar from '../components/Migrations/MigrationSummaryBar';
import MigrationFileTree from '../components/Migrations/MigrationFileTree';
import MigrationFileViewer from '../components/Migrations/MigrationFileViewer';
import MigrationActionBar from '../components/Migrations/MigrationActionBar';

const MigrationsPage = () => {
  const navigate = useNavigate();
  const user = useAppStore((s) => s.user);
  const setUser = useAppStore((s) => s.setUser);
  const loadConfig = useMigrationsStore((s) => s.loadConfig);
  const loadRefs = useMigrationsStore((s) => s.loadRefs);
  const refreshRepo = useMigrationsStore((s) => s.refreshRepo);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const currentUser = await authAPI.getCurrentUser();
        setUser(currentUser);
      } catch {
        navigate('/login');
      }
    };
    checkAuth();
  }, []);

  useEffect(() => {
    loadConfig();
    loadRefs();
  }, []);

  if (!user) {
    return <Box>Loading...</Box>;
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
            startIcon={<RefreshIcon />}
            onClick={refreshRepo}
            size="small"
          >
            Refresh Repo
          </Button>
        </Toolbar>
      </AppBar>

      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
        <Stack spacing={1.5} sx={{ flex: 1, overflow: 'hidden' }}>
          <MigrationToolbar />
          <MigrationSummaryBar />

          {/* Split view */}
          <Box sx={{ display: 'flex', flex: 1, gap: 1.5, overflow: 'hidden' }}>
            {/* Left: file tree */}
            <Paper
              elevation={2}
              sx={{ width: 280, minWidth: 280, overflow: 'hidden', flexShrink: 0, display: 'flex', flexDirection: 'column' }}
            >
              <MigrationFileTree />
            </Paper>

            {/* Right: file viewer — scrolls independently */}
            <Paper elevation={2} sx={{ flex: 1, overflow: 'hidden' }}>
              <MigrationFileViewer />
            </Paper>
          </Box>
        </Stack>
      </Box>

      {/* Sticky bottom action bar */}
      <MigrationActionBar />
    </Box>
  );
};

export default MigrationsPage;
