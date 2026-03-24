import React, { useState } from 'react';
import {
  Paper,
  Stack,
  Autocomplete,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Button,
  CircularProgress,
  Tooltip,
  IconButton,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import SyncIcon from '@mui/icons-material/Sync';
import { useMigrationsStore } from '../../store/migrationsStore';

const MigrationToolbar = ({ onRefresh }: { onRefresh?: () => Promise<void> }) => {
  const config = useMigrationsStore((s) => s.config);
  const refs = useMigrationsStore((s) => s.refs);
  const fromRef = useMigrationsStore((s) => s.fromRef);
  const toRef = useMigrationsStore((s) => s.toRef);
  const environment = useMigrationsStore((s) => s.environment);
  const databaseFilter = useMigrationsStore((s) => s.databaseFilter);
  const isAnalyzing = useMigrationsStore((s) => s.isAnalyzing);
  const setFromRef = useMigrationsStore((s) => s.setFromRef);
  const setToRef = useMigrationsStore((s) => s.setToRef);
  const setEnvironment = useMigrationsStore((s) => s.setEnvironment);
  const setDatabaseFilter = useMigrationsStore((s) => s.setDatabaseFilter);
  const analyze = useMigrationsStore((s) => s.analyze);
  const [isSyncing, setIsSyncing] = useState(false);

  const refOptions = [
    ...(refs?.branches || []),
    ...(refs?.tags || []),
  ];

  const envEntries = config?.environments
    ? Object.entries(config.environments)
    : [];

  const databases = environment && config?.environments[environment]
    ? config.environments[environment].databases
    : [];

  const handleSync = async () => {
    if (!onRefresh) return;
    setIsSyncing(true);
    try {
      await onRefresh();
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <Paper elevation={2} sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Autocomplete
            freeSolo
            options={refOptions}
            value={fromRef}
            onInputChange={(_e, value) => setFromRef(value)}
            renderInput={(params) => (
              <TextField {...params} label="From Ref (base)" size="small" placeholder="e.g. main~5, v1.0.0" />
            )}
            sx={{ flex: 1 }}
            disabled={isAnalyzing}
          />
          <Autocomplete
            freeSolo
            options={refOptions}
            value={toRef}
            onInputChange={(_e, value) => setToRef(value)}
            renderInput={(params) => (
              <TextField {...params} label="To Ref (target)" size="small" placeholder="e.g. HEAD, feature-branch" />
            )}
            sx={{ flex: 1 }}
            disabled={isAnalyzing}
          />
          <Tooltip title="Pull latest changes from repository">
            <IconButton
              onClick={handleSync}
              disabled={isSyncing || isAnalyzing}
              sx={{
                bgcolor: 'rgba(255,255,255,0.05)',
                '&:hover': { bgcolor: 'rgba(255,255,255,0.1)' },
              }}
            >
              {isSyncing ? <CircularProgress size={20} /> : <SyncIcon />}
            </IconButton>
          </Tooltip>
        </Stack>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <FormControl size="small" sx={{ flex: 1 }}>
            <InputLabel>Environment</InputLabel>
            <Select
              value={environment}
              label="Environment"
              onChange={(e) => setEnvironment(e.target.value)}
              disabled={isAnalyzing}
            >
              {envEntries.map(([key, env]) => (
                <MenuItem key={key} value={key}>
                  {env.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ flex: 1 }}>
            <InputLabel>Database Filter</InputLabel>
            <Select
              value={databaseFilter}
              label="Database Filter"
              onChange={(e) => setDatabaseFilter(e.target.value)}
              disabled={isAnalyzing}
            >
              <MenuItem value="">All Databases</MenuItem>
              {databases.map((db) => (
                <MenuItem key={db.name} value={db.name}>
                  {db.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Button
            variant="contained"
            color="primary"
            startIcon={isAnalyzing ? <CircularProgress size={18} color="inherit" /> : <PlayArrowIcon />}
            onClick={analyze}
            disabled={isAnalyzing || !fromRef.trim() || !toRef.trim() || !environment}
            sx={{ minWidth: 140, height: 40 }}
          >
            {isAnalyzing ? 'Analyzing...' : 'Analyze'}
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
};

export default React.memo(MigrationToolbar);
