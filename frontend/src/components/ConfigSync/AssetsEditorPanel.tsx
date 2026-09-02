import { useState, useCallback, useEffect } from 'react';
import { Box, Paper, Typography, Button, Stack, LinearProgress, ToggleButtonGroup, ToggleButton } from '@mui/material';
import { Editor } from '@monaco-editor/react';
import SaveIcon from '@mui/icons-material/Save';
import HistoryIcon from '@mui/icons-material/History';
import TuneIcon from '@mui/icons-material/Tune';
import DifferenceIcon from '@mui/icons-material/Difference';
import toast from 'react-hot-toast';
import { configSyncAPI, toastNonApiError } from '../../services/api';
import type { ConfigSyncAsset } from '../../services/api';
import AssetHistoryDialog from './AssetHistoryDialog';

const ASSET_NAMES: ConfigSyncAsset['name'][] = ['config.json', 'patches.json'];
const ASSET_ICONS: Record<ConfigSyncAsset['name'], JSX.Element> = {
  'config.json': <TuneIcon fontSize="small" />,
  'patches.json': <DifferenceIcon fontSize="small" />,
};

/**
 * config.json / patches.json, owned by this app's own Postgres (not static
 * files in the nammayatri repo) — edited here, written to disk right before
 * every Export & Patch run. Its own top-level section/tab rather than
 * crammed under the run form, since editing these is a distinct workflow
 * from kicking off a run.
 */
const AssetsEditorPanel = () => {
  const [assets, setAssets] = useState<Record<string, ConfigSyncAsset>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  // Filter: show one asset at a time — both stacked at once was congested.
  const [selected, setSelected] = useState<ConfigSyncAsset['name']>('config.json');
  const [historyOpen, setHistoryOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { assets } = await configSyncAPI.getAssets();
      const byName: Record<string, ConfigSyncAsset> = {};
      const nextDrafts: Record<string, string> = {};
      for (const asset of assets) {
        byName[asset.name] = asset;
        nextDrafts[asset.name] = JSON.stringify(asset.content, null, 2);
      }
      setAssets(byName);
      setDrafts(nextDrafts);
    } catch (err) {
      toastNonApiError(err, 'Failed to load config.json/patches.json');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (name: ConfigSyncAsset['name']) => {
    let parsed: any;
    try {
      parsed = JSON.parse(drafts[name] ?? '{}');
    } catch {
      toast.error(`${name} is not valid JSON`);
      return;
    }
    setSaving(prev => ({ ...prev, [name]: true }));
    try {
      const { asset } = await configSyncAPI.updateAsset(name, parsed);
      setAssets(prev => ({ ...prev, [name]: asset }));
      toast.success(`${name} saved`);
    } catch (err) {
      toastNonApiError(err, `Failed to save ${name}`);
    } finally {
      setSaving(prev => ({ ...prev, [name]: false }));
    }
  };

  if (loading) {
    return <LinearProgress />;
  }

  const asset = assets[selected];

  return (
    <Stack spacing={2}>
      <ToggleButtonGroup
        value={selected}
        exclusive
        size="small"
        color="primary"
        onChange={(_, v) => v && setSelected(v)}
        sx={{
          alignSelf: 'flex-start',
          '& .MuiToggleButton-root': {
            textTransform: 'none',
            gap: 0.75,
            px: 2,
            py: 0.75,
            fontWeight: 500,
            borderColor: 'divider',
          },
        }}
      >
        {ASSET_NAMES.map(name => (
          <ToggleButton key={name} value={name}>
            {ASSET_ICONS[name]}
            {name}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" mb={1}>
          <Typography variant="subtitle1" fontWeight={600}>{selected}</Typography>
          {asset?.updatedAt && (
            <Typography variant="caption" color="text.secondary">
              last updated {new Date(asset.updatedAt).toLocaleString()}
              {asset.updatedByUsername ? ` by ${asset.updatedByUsername}` : ''}
            </Typography>
          )}
          <Box sx={{ flexGrow: 1 }} />
          <Button
            size="small"
            variant="outlined"
            startIcon={<HistoryIcon />}
            onClick={() => setHistoryOpen(true)}
          >
            History
          </Button>
          <Button
            size="small"
            variant="contained"
            startIcon={<SaveIcon />}
            onClick={() => handleSave(selected)}
            disabled={saving[selected]}
          >
            Save
          </Button>
        </Stack>
        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
          <Editor
            height="600px"
            defaultLanguage="json"
            value={drafts[selected] ?? ''}
            onChange={value => setDrafts(prev => ({ ...prev, [selected]: value ?? '' }))}
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
            }}
          />
        </Box>
      </Paper>

      <AssetHistoryDialog
        name={selected}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onRestored={load}
      />
    </Stack>
  );
};

export default AssetsEditorPanel;
