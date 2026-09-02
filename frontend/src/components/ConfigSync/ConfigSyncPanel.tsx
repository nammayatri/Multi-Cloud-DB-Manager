import { useState, useEffect } from 'react';
import { Box, Tab, Tabs } from '@mui/material';
import SyncRunPanel from './SyncRunPanel';
import AssetsEditorPanel from './AssetsEditorPanel';
import VersionsPanel from './VersionsPanel';

/**
 * Shell: three sub-tabs, same pattern as Config Replicate's Replicate/Groups/
 * History tabs. Config Files gets its own tab (rather than living under the
 * run form) since editing config.json/patches.json is a separate workflow
 * from kicking off a run, and cramming both into one scroll made the run
 * form feel congested.
 *
 * Tabs are lazy-mounted-once-then-kept-alive (visited tracking + display:none
 * toggling), same convention as the main ConsolePage's top-level views —
 * NOT conditionally rendered ({tab === 0 && <X/>}), since that would fully
 * unmount a tab (and lose all its state — a running/completed job's result,
 * in Sync's case) every time you switched away from it.
 */
const ConfigSyncPanel = () => {
  const [tab, setTab] = useState(0);
  const [visited, setVisited] = useState<Set<number>>(new Set([0]));

  useEffect(() => {
    setVisited(prev => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  }, [tab]);

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ minHeight: 36, mb: 1 }}>
        <Tab label="Sync" sx={{ minHeight: 36, py: 0 }} />
        <Tab label="Config Files" sx={{ minHeight: 36, py: 0 }} />
        <Tab label="Versions" sx={{ minHeight: 36, py: 0 }} />
      </Tabs>

      <Box sx={{ flex: 1, overflowY: 'auto', pb: 4 }}>
        <Box sx={{ display: tab === 0 ? 'block' : 'none' }}>
          {visited.has(0) && <SyncRunPanel />}
        </Box>
        <Box sx={{ display: tab === 1 ? 'block' : 'none' }}>
          {visited.has(1) && <AssetsEditorPanel />}
        </Box>
        <Box sx={{ display: tab === 2 ? 'block' : 'none' }}>
          {visited.has(2) && <VersionsPanel />}
        </Box>
      </Box>
    </Box>
  );
};

export default ConfigSyncPanel;
