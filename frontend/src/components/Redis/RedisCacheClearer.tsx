import React, { useState, useEffect, useRef } from 'react';
import {
  Box,
  Paper,
  TextField,
  Button,
  Stack,
  Typography,
  LinearProgress,
  Alert,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Chip,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import StopIcon from '@mui/icons-material/Stop';
import { useAppStore } from '../../store/appStore';
import { redisAPI, schemaAPI } from '../../services/api';
import toast from 'react-hot-toast';
import type { RedisScanResponse, RedisScanProgress, DatabaseConfiguration } from '../../types';

const POLL_INTERVAL = 1000;

const statusColor = (status: RedisScanProgress['status']) => {
  switch (status) {
    case 'completed': return 'success' as const;
    case 'error': return 'error' as const;
    case 'cancelled': return 'warning' as const;
    case 'deleting': return 'warning' as const;
    default: return 'info' as const;
  }
};

/**
 * Compute a single 0-100 progress value for a cloud based on its current phase.
 *
 * Preview:  scanning only → 0-100% based on nodes scanned.
 * Delete:   scanning phase maps to 0-50%, deleting phase maps to 50-100%.
 */
const computeProgress = (p: RedisScanProgress, action: 'preview' | 'delete'): number => {
  if (p.status === 'completed' || p.status === 'cancelled') return 100;

  if (action === 'preview') {
    // Preview: progress = nodes scanned / total
    return p.nodesTotal > 0 ? (p.nodesScanned / p.nodesTotal) * 100 : 0;
  }

  // Delete action has two phases: scanning (0-50%), deleting (50-100%)
  if (p.status === 'scanning') {
    const scanPct = p.nodesTotal > 0 ? (p.nodesScanned / p.nodesTotal) * 100 : 0;
    return scanPct * 0.5; // 0-50%
  }

  if (p.status === 'deleting') {
    const deletePct = p.keysFound > 0 ? (p.keysDeleted / p.keysFound) * 100 : 0;
    return 50 + deletePct * 0.5; // 50-100%
  }

  return 0;
};

const phaseLabel = (p: RedisScanProgress, action: 'preview' | 'delete'): string => {
  if (p.status === 'completed') return `Completed — ${p.nodesScanned}/${p.nodesTotal} nodes scanned, ${p.keysFound} keys found`;
  if (p.status === 'cancelled') return `Cancelled — ${p.nodesScanned}/${p.nodesTotal} nodes scanned, ${p.keysFound} keys found`;
  if (p.status === 'error') return 'Error';

  if (p.status === 'scanning') {
    const nodeStr = p.nodesTotal > 0 ? ` (node ${p.nodesScanned}/${p.nodesTotal})` : '';
    return `Scanning${nodeStr} — ${p.keysFound} keys found`;
  }

  if (p.status === 'deleting') {
    return `Deleting — ${p.keysDeleted}/${p.keysFound} keys removed`;
  }

  return p.status;
};

const RedisCacheClearer = () => {
  const user = useAppStore(s => s.user);
  const [pattern, setPattern] = useState('');
  const [scanCount, setScanCount] = useState('100000'); // default 100k, max 200k
  const [selectedCloud, setSelectedCloud] = useState('both');
  const [cloudNames, setCloudNames] = useState<string[]>([]);
  const [scanResult, setScanResult] = useState<RedisScanResponse | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [currentExecutionId, setCurrentExecutionId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isReader = user?.role === 'READER';

  // Fetch cloud names
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const config: DatabaseConfiguration = await schemaAPI.getConfiguration();
        setCloudNames([
          config.primary.cloudName,
          ...config.secondary.map((s) => s.cloudName),
        ]);
      } catch {
        setCloudNames(['aws', 'gcp']);
      }
    };
    fetchConfig();
  }, []);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const pollStatus = async (executionId: string) => {
    try {
      const status: RedisScanResponse = await redisAPI.getScanStatus(executionId);
      setScanResult(status);

      if (status.status === 'completed' || status.status === 'failed' || status.status === 'cancelled') {
        stopPolling();
        setIsScanning(false);
        setCurrentExecutionId(null);

        if (status.status === 'completed') {
          const action = status.action === 'delete' ? 'Delete' : 'Preview';
          toast.success(`${action} completed`);
        } else if (status.status === 'cancelled') {
          toast('Operation cancelled', { icon: '⚠️' });
        } else {
          toast.error('SCAN operation failed');
        }
      }
    } catch (error) {
      stopPolling();
      setIsScanning(false);
      setCurrentExecutionId(null);
      toast.error('Failed to get scan status');
    }
  };

  const handleScan = async (action: 'preview' | 'delete') => {
    if (!pattern.trim()) {
      toast.error('Please enter a pattern');
      return;
    }

    setIsScanning(true);
    setScanResult(null);

    try {
      const count = parseInt(scanCount) || 10000;
      const { executionId } = await redisAPI.startScan({
        pattern: pattern.trim(),
        cloud: selectedCloud,
        action,
        scanCount: Math.min(Math.max(count, 1), 200000),
      });

      setCurrentExecutionId(executionId);

      // Start polling
      stopPolling();
      pollRef.current = setInterval(() => pollStatus(executionId), POLL_INTERVAL);
      pollStatus(executionId);
    } catch (error: any) {
      setIsScanning(false);
      setCurrentExecutionId(null);
      toast.error(error.response?.data?.error || 'Failed to start scan');
    }
  };

  const handleCancel = async () => {
    if (!currentExecutionId) return;

    try {
      await redisAPI.cancelScan(currentExecutionId);
      // Don't stop polling here — wait for the scan to report 'cancelled' status
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to cancel scan');
    }
  };

  const renderCloudProgress = (cloudName: string, progress: RedisScanProgress) => {
    const action = scanResult?.action || 'preview';
    const pct = computeProgress(progress, action);
    const label = phaseLabel(progress, action);

    return (
      <Box key={cloudName} sx={{ mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
            {cloudName.toUpperCase()}
          </Typography>
          <Chip label={progress.status} color={statusColor(progress.status)} size="small" />
        </Stack>
        <LinearProgress
          variant="determinate"
          value={pct}
          color={progress.status === 'deleting' ? 'warning' : 'primary'}
          sx={{ height: 8, borderRadius: 4, mb: 0.5 }}
        />
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
        {progress.error && (
          <Alert severity="error" sx={{ mt: 1 }}>{progress.error}</Alert>
        )}
      </Box>
    );
  };

  // Collect all preview keys across clouds
  const allPreviewKeys = scanResult
    ? Object.values(scanResult.clouds)
        .flatMap((c: any) => (c.keys || []).map((key: string) => ({ cloud: c.cloudName, key })))
    : [];

  const isDone = scanResult && (scanResult.status === 'completed' || scanResult.status === 'failed' || scanResult.status === 'cancelled');

  return (
    <Paper elevation={2} sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom>
        Cache Clearer (SCAN + DEL)
      </Typography>

      <Stack spacing={2}>
        <Stack direction="row" spacing={2} alignItems="center">
          <TextField
            label="Pattern"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="e.g. *user*"
            size="small"
            sx={{ flex: 1 }}
            disabled={isScanning}
          />

          <TextField
            label="Scan Count"
            value={scanCount}
            onChange={(e) => {
              const val = parseInt(e.target.value) || 0;
              if (val > 200000) {
                setScanCount('200000');
              } else {
                setScanCount(e.target.value);
              }
            }}
            size="small"
            type="number"
            sx={{ width: 130 }}
            disabled={isScanning}
            inputProps={{ min: 1, max: 200000 }}
            helperText="Max 200k"
          />

          <FormControl sx={{ minWidth: 180 }} size="small">
            <InputLabel>Cloud</InputLabel>
            <Select
              value={selectedCloud}
              label="Cloud"
              onChange={(e) => setSelectedCloud(e.target.value)}
              disabled={isScanning}
            >
              <MenuItem value="both">All Clouds</MenuItem>
              {cloudNames.map((cloud) => (
                <MenuItem key={cloud} value={cloud}>{cloud.toUpperCase()}</MenuItem>
              ))}
            </Select>
          </FormControl>

          {isScanning ? (
            <Button
              variant="contained"
              color="error"
              startIcon={<StopIcon />}
              onClick={handleCancel}
              sx={{ minWidth: 130 }}
            >
              Cancel
            </Button>
          ) : (
            <>
              <Button
                variant="outlined"
                startIcon={<SearchIcon />}
                onClick={() => handleScan('preview')}
                disabled={!pattern.trim()}
              >
                Preview Keys
              </Button>

              <Button
                variant="contained"
                color="error"
                startIcon={<DeleteSweepIcon />}
                onClick={() => handleScan('delete')}
                disabled={!pattern.trim() || isReader}
              >
                Delete Keys
              </Button>
            </>
          )}
        </Stack>

        {isReader && (
          <Typography variant="caption" color="error">
            READER role cannot delete keys
          </Typography>
        )}

        {/* Progress per cloud */}
        {scanResult && (
          <Box>
            {Object.entries(scanResult.clouds).map(([cloudName, progress]) =>
              renderCloudProgress(cloudName, progress as RedisScanProgress)
            )}
          </Box>
        )}

        {/* Live keys table — shown during scanning and after completion */}
        {scanResult && allPreviewKeys.length > 0 && (
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              {isDone ? 'Found' : 'Finding'} {allPreviewKeys.length} keys{' '}
              {allPreviewKeys.length >= 10000 ? '(capped at 10,000)' : ''}
              {!isDone && '...'}
            </Typography>
            <TableContainer sx={{ maxHeight: 300 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 'bold' }}>Cloud</TableCell>
                    <TableCell sx={{ fontWeight: 'bold' }}>Key</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {allPreviewKeys.map((item, i) => (
                    <TableRow key={i} hover>
                      <TableCell>
                        <Chip label={item.cloud.toUpperCase()} size="small" />
                      </TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                        {item.key}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        )}

        {isDone && allPreviewKeys.length === 0 && scanResult?.status !== 'cancelled' && (
          <Alert severity="info">No keys found matching pattern "{scanResult?.pattern}"</Alert>
        )}

        {/* Delete summary */}
        {isDone && scanResult?.action === 'delete' && scanResult.status === 'completed' && (
          <Alert severity="success">
            Deleted {Object.values(scanResult.clouds).reduce((sum, c: any) => sum + c.keysDeleted, 0)} keys
            matching pattern "{scanResult.pattern}"
          </Alert>
        )}

        {isDone && scanResult?.status === 'cancelled' && (
          <Alert severity="warning">
            Operation was cancelled.
            {scanResult.action === 'delete' && ` ${Object.values(scanResult.clouds).reduce((sum, c: any) => sum + c.keysDeleted, 0)} keys were deleted before cancellation.`}
          </Alert>
        )}
      </Stack>
    </Paper>
  );
};

export default React.memo(RedisCacheClearer);
