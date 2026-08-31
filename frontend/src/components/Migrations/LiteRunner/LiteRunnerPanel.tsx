import React from 'react';
import { Box, Stack } from '@mui/material';
import LiteRunnerToolbar from './LiteRunnerToolbar';
import LiteDiffHeader from './LiteDiffHeader';
import LiteDiffControls from './LiteDiffControls';
import LiteDiffStats from './LiteDiffStats';
import LiteFileList from './LiteFileList';
import LiteRunBar from './LiteRunBar';

const LiteRunnerPanel = () => (
  <Stack spacing={1.5} sx={{ flex: 1, overflow: 'hidden' }}>
    <LiteRunnerToolbar />
    <Box sx={{ flex: 1, overflow: 'auto' }}>
      <Stack spacing={1.5}>
        <LiteDiffHeader />
        <LiteDiffControls />
        <LiteDiffStats />
        <LiteFileList />
      </Stack>
    </Box>
    <LiteRunBar />
  </Stack>
);

export default React.memo(LiteRunnerPanel);
