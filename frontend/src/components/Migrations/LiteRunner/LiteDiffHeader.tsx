import React from 'react';
import { Paper, Stack, Typography, Box } from '@mui/material';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import { useLiteRunnerStore } from '../../../store/liteRunnerStore';

/** Repo + compared range, mirroring how a GitHub compare view identifies itself. */
const LiteDiffHeader = () => {
  const diff = useLiteRunnerStore((s) => s.diff);
  if (!diff) return null;

  const short = (ref: string) => (/^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref);

  return (
    <Paper elevation={1} sx={{ px: 2, py: 1.5 }}>
      <Stack direction="row" alignItems="center" spacing={1.5} flexWrap="wrap">
        <AccountTreeIcon fontSize="small" color="primary" />
        <Typography variant="subtitle1" color="primary" sx={{ fontWeight: 600 }}>
          {diff.owner}/{diff.repo}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Comparing
        </Typography>
        <Box
          component="code"
          sx={{
            px: 1, py: 0.25, borderRadius: 1,
            bgcolor: 'rgba(255,255,255,0.08)',
            fontFamily: 'monospace', fontSize: 13,
          }}
        >
          {short(diff.base)}...{short(diff.head)}
        </Box>
      </Stack>
    </Paper>
  );
};

export default React.memo(LiteDiffHeader);
