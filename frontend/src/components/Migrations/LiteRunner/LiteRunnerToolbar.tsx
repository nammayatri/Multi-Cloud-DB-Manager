import React from 'react';
import { Paper, Stack, TextField, Button, CircularProgress, Alert, Box } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import { useLiteRunnerStore } from '../../../store/liteRunnerStore';
import LiteDbSelector from './LiteDbSelector';
import MigrationViewToggle from '../MigrationViewToggle';

const LiteRunnerToolbar = () => {
  const compareUrl = useLiteRunnerStore((s) => s.compareUrl);
  const setCompareUrl = useLiteRunnerStore((s) => s.setCompareUrl);
  const fetchDiff = useLiteRunnerStore((s) => s.fetchDiff);
  const isFetching = useLiteRunnerStore((s) => s.isFetching);
  const isRunning = useLiteRunnerStore((s) => s.isRunning);
  const error = useLiteRunnerStore((s) => s.error);

  const busy = isFetching || isRunning;

  return (
    <Paper elevation={2} sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <LiteDbSelector disabled={busy} />
          </Box>
          <MigrationViewToggle disabled={busy} />
        </Stack>

        <Stack direction="row" spacing={1.5} alignItems="center">
          <TextField
            fullWidth
            size="small"
            label="GitHub Compare URL"
            placeholder="https://github.com/owner/repo/compare/base...head"
            value={compareUrl}
            onChange={(e) => setCompareUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy && compareUrl.trim()) fetchDiff();
            }}
            disabled={busy}
          />
          <Button
            variant="contained"
            startIcon={isFetching ? <CircularProgress size={18} color="inherit" /> : <DownloadIcon />}
            onClick={fetchDiff}
            disabled={busy || !compareUrl.trim()}
            sx={{ minWidth: 150, height: 40, whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            {isFetching ? 'Fetching...' : 'Fetch Diffs'}
          </Button>
        </Stack>

        {error && <Alert severity="error">{error}</Alert>}
      </Stack>
    </Paper>
  );
};

export default React.memo(LiteRunnerToolbar);
