import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, List, ListItemButton,
  ListItemAvatar, ListItemText, Avatar, Box, Typography, CircularProgress, Chip,
  IconButton, Divider, Tooltip,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import { Editor } from '@monaco-editor/react';
import RestoreIcon from '@mui/icons-material/Restore';
import HistoryIcon from '@mui/icons-material/History';
import CloseIcon from '@mui/icons-material/Close';
import { formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';
import { configSyncAPI, toastNonApiError } from '../../services/api';
import type { ConfigSyncAsset, ConfigSyncAssetHistoryEntry } from '../../services/api';

function initials(name: string | null): string {
  if (!name) return '?';
  return name.trim().slice(0, 2).toUpperCase();
}

/**
 * Every save of config.json/patches.json (including the initial disk seed)
 * is kept as an append-only row — this lists them and lets you preview or
 * restore an older version. Restoring is itself just another save, so it
 * shows up in this same list afterward rather than deleting anything.
 */
const AssetHistoryDialog = ({
  name, open, onClose, onRestored,
}: {
  name: ConfigSyncAsset['name'];
  open: boolean;
  onClose: () => void;
  onRestored: () => void;
}) => {
  const [entries, setEntries] = useState<ConfigSyncAssetHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string>('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setSelectedId(null);
    setPreviewContent('');
    configSyncAPI.getAssetHistory(name)
      .then(({ history }) => {
        setEntries(history);
        if (history[0]) void selectEntry(history[0].id);
      })
      .catch(err => toastNonApiError(err, `Failed to load history for ${name}`))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, name]);

  const selectEntry = async (id: string) => {
    setSelectedId(id);
    setPreviewLoading(true);
    try {
      const { entry } = await configSyncAPI.getAssetHistoryEntry(id);
      setPreviewContent(JSON.stringify(entry.content, null, 2));
    } catch (err) {
      toastNonApiError(err, 'Failed to load version');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleRestore = async () => {
    if (!selectedId) return;
    setRestoring(true);
    try {
      await configSyncAPI.restoreAssetVersion(selectedId);
      toast.success(`${name} restored`);
      onRestored();
      onClose();
    } catch (err) {
      toastNonApiError(err, 'Failed to restore version');
    } finally {
      setRestoring(false);
    }
  };

  const isLatest = entries.length > 0 && selectedId === entries[0].id;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{ sx: { height: 620, bgcolor: '#1e1e1e', backgroundImage: 'none' } }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1.25, py: 2 }}>
        <HistoryIcon color="primary" />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6" component="span" sx={{ fontWeight: 600, fontSize: '1.05rem' }}>
            {name}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {entries.length} saved version{entries.length === 1 ? '' : 's'}
          </Typography>
        </Box>
        <IconButton onClick={onClose} size="small">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <Divider />

      <DialogContent sx={{ display: 'flex', gap: 0, p: 0, overflow: 'hidden' }}>
        <Box sx={{ width: 280, flexShrink: 0, overflowY: 'auto', borderRight: 1, borderColor: 'divider', bgcolor: '#191919' }}>
          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}><CircularProgress size={22} /></Box>
          ) : (
            <List disablePadding>
              {entries.map((entry, index) => {
                const isSelected = entry.id === selectedId;
                return (
                  <ListItemButton
                    key={entry.id}
                    selected={isSelected}
                    onClick={() => selectEntry(entry.id)}
                    sx={{
                      alignItems: 'flex-start',
                      py: 1.25,
                      px: 1.5,
                      borderLeft: 3,
                      borderLeftColor: isSelected ? 'primary.main' : 'transparent',
                      '&.Mui-selected': {
                        bgcolor: theme => alpha(theme.palette.primary.main, 0.16),
                      },
                      '&.Mui-selected:hover': {
                        bgcolor: theme => alpha(theme.palette.primary.main, 0.22),
                      },
                      '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
                    }}
                  >
                    <ListItemAvatar sx={{ minWidth: 40 }}>
                      <Avatar sx={{ width: 30, height: 30, fontSize: 12, bgcolor: isSelected ? 'primary.main' : '#26262a' }}>
                        {initials(entry.updatedByUsername)}
                      </Avatar>
                    </ListItemAvatar>
                    <ListItemText
                      primary={
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                          <Typography variant="body2" fontWeight={isSelected ? 600 : 500}>
                            {entry.updatedByUsername || 'unknown'}
                          </Typography>
                          {index === 0 && (
                            <Chip label="current" size="small" color="primary" variant="outlined" sx={{ height: 18, fontSize: 10 }} />
                          )}
                        </Box>
                      }
                      secondary={
                        <Tooltip title={new Date(entry.updatedAt).toLocaleString()} placement="right">
                          <Typography variant="caption" color="text.secondary">
                            {formatDistanceToNow(new Date(entry.updatedAt), { addSuffix: true })}
                          </Typography>
                        </Tooltip>
                      }
                    />
                  </ListItemButton>
                );
              })}
              {entries.length === 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>No history yet.</Typography>
              )}
            </List>
          )}
        </Box>

        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {previewLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
              <CircularProgress size={24} />
            </Box>
          ) : (
            <Editor
              height="100%"
              defaultLanguage="json"
              value={previewContent}
              theme="vs-dark"
              options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false }}
            />
          )}
        </Box>
      </DialogContent>

      <Divider />

      <DialogActions sx={{ px: 3, py: 1.5 }}>
        {isLatest && selectedId && (
          <Typography variant="caption" color="text.secondary" sx={{ mr: 'auto' }}>
            This is the current version.
          </Typography>
        )}
        <Button onClick={onClose} color="inherit">Close</Button>
        <Button
          variant="contained"
          startIcon={<RestoreIcon />}
          onClick={handleRestore}
          disabled={!selectedId || isLatest || restoring}
        >
          Restore this version
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default AssetHistoryDialog;
