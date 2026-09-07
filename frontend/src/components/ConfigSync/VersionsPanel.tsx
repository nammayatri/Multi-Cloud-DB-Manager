import { useEffect, useState } from 'react';
import {
  Box, Typography, CircularProgress, Chip, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, Paper, Button, Stack, IconButton, Tooltip,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import RefreshIcon from '@mui/icons-material/Refresh';
import { formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';
import { configSyncAPI, toastNonApiError } from '../../services/api';
import type { ConfigSyncVersion, ConfigSyncVersionStatus } from '../../services/api';

const STATUS_META: Record<ConfigSyncVersionStatus, { label: string; color: 'success' | 'error' | 'default'; icon: JSX.Element }> = {
  stable: { label: 'Stable', color: 'success', icon: <CheckCircleIcon sx={{ fontSize: 14 }} /> },
  not_stable: { label: 'Not stable', color: 'error', icon: <CancelIcon sx={{ fontSize: 14 }} /> },
  not_verified: { label: 'Not verified', color: 'default', icon: <HelpOutlineIcon sx={{ fontSize: 14 }} /> },
};

function relTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

/**
 * Every published version for this deployment's one direction — who
 * uploaded it, when, and whether anyone's actually verified it works.
 * Marking stable/not-stable is a real judgment call (someone actually
 * imported this version and confirmed it), so it's a deliberate action
 * here, not automatic — a version existing doesn't mean it's trustworthy.
 */
const VersionsPanel = () => {
  const [versions, setVersions] = useState<ConfigSyncVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [markingVersion, setMarkingVersion] = useState<number | null>(null);

  const load = () => {
    setLoading(true);
    configSyncAPI.getVersions()
      .then(({ versions }) => setVersions(versions))
      .catch(err => toastNonApiError(err, 'Failed to load versions'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const mark = async (version: number, status: ConfigSyncVersionStatus) => {
    setMarkingVersion(version);
    try {
      const { version: updated } = await configSyncAPI.setVersionStatus(version, status);
      setVersions(prev => prev.map(v => (v.version === version ? updated : v)));
      toast.success(`v${version} marked ${STATUS_META[status].label.toLowerCase()}`);
    } catch (err) {
      toastNonApiError(err, `Failed to mark v${version}`);
    } finally {
      setMarkingVersion(null);
    }
  };

  return (
    <Box sx={{ p: 2 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.5 }}>
        <Typography variant="subtitle1" fontWeight={600}>
          Published versions
        </Typography>
        <Tooltip title="Refresh">
          <IconButton size="small" onClick={load} disabled={loading}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={24} /></Box>
      ) : versions.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No versions published yet — run "Export & Patch" on the Sync tab first.
        </Typography>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Version</TableCell>
                <TableCell>Description</TableCell>
                <TableCell>Uploaded by</TableCell>
                <TableCell>Created</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Verified by</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {versions.map(v => {
                const meta = STATUS_META[v.status];
                const busy = markingVersion === v.version;
                return (
                  <TableRow key={v.id} hover>
                    <TableCell sx={{ fontFamily: 'monospace' }}>v{v.version}</TableCell>
                    <TableCell sx={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {v.description || <em>—</em>}
                    </TableCell>
                    <TableCell>{v.uploadedByUsername || 'unknown'}</TableCell>
                    <TableCell>
                      <Tooltip title={new Date(v.createdAt).toLocaleString()}>
                        <span>{relTime(v.createdAt)}</span>
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      <Chip size="small" color={meta.color} icon={meta.icon} label={meta.label} sx={{ height: 22 }} />
                    </TableCell>
                    <TableCell>
                      {v.verifiedByUsername ? (
                        <Tooltip title={v.verifiedAt ? new Date(v.verifiedAt).toLocaleString() : ''}>
                          <span>{v.verifiedByUsername}</span>
                        </Tooltip>
                      ) : <em>—</em>}
                    </TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                        <Button
                          size="small" variant={v.status === 'stable' ? 'contained' : 'outlined'} color="success"
                          disabled={busy || v.status === 'stable'}
                          onClick={() => mark(v.version, 'stable')}>
                          Stable
                        </Button>
                        <Button
                          size="small" variant={v.status === 'not_stable' ? 'contained' : 'outlined'} color="error"
                          disabled={busy || v.status === 'not_stable'}
                          onClick={() => mark(v.version, 'not_stable')}>
                          Not stable
                        </Button>
                        {v.status !== 'not_verified' && (
                          <Button
                            size="small" variant="text" color="inherit"
                            disabled={busy}
                            onClick={() => mark(v.version, 'not_verified')}>
                            Reset
                          </Button>
                        )}
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
};

export default VersionsPanel;
