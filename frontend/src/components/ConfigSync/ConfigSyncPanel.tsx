import { useState } from 'react';
import { Box, Tab, Tabs } from '@mui/material';
import SyncRunPanel from './SyncRunPanel';
import AssetsEditorPanel from './AssetsEditorPanel';

/**
 * Shell: two sub-tabs, same pattern as Config Replicate's Replicate/Groups/
 * History tabs. Config Files gets its own tab (rather than living under the
 * run form) since editing config.json/patches.json is a separate workflow
 * from kicking off a run, and cramming both into one scroll made the run
 * form feel congested.
 */
const ConfigSyncPanel = () => {
  const [tab, setTab] = useState(0);

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ minHeight: 36, mb: 1 }}>
        <Tab label="Sync" sx={{ minHeight: 36, py: 0 }} />
        <Tab label="Config Files" sx={{ minHeight: 36, py: 0 }} />
      </Tabs>

      <Box sx={{ flex: 1, overflowY: 'auto', pb: 4 }}>
        {tab === 0 && <SyncRunPanel />}
        {tab === 1 && <AssetsEditorPanel />}
      </Box>
    </Box>
  );
};

export default ConfigSyncPanel;
