import { useEffect, useState, useCallback } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import CircleIcon from '@mui/icons-material/Circle';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import { shudhiAPI } from '../../services/api';
import toast from 'react-hot-toast';
import type {
  ShudhiPodInfo,
  ShudhiKeyEntry,
  ShudhiStatusResponse,
  ShudhiRefreshResponse,
} from '../../types';
import { useAppStore } from '../../store/appStore';

type ConnectionStatus = 'checking' | 'connected' | 'not_configured' | 'unreachable';

const statusColor: Record<ConnectionStatus, 'default' | 'success' | 'warning' | 'error'> = {
  checking: 'default',
  connected: 'success',
  not_configured: 'warning',
  unreachable: 'error',
};

const ShudhiPanel = () => {
  const user = useAppStore((s) => s.user);

  // Connection status
  const [connStatus, setConnStatus] = useState<ConnectionStatus>('checking');

  // Data
  const [services, setServices] = useState<string[]>([]);
  const [pods, setPods] = useState<ShudhiPodInfo[]>([]);
  const [keys, setKeys] = useState<ShudhiKeyEntry[]>([]);

  // Selections
  const [selectedService, setSelectedService] = useState('');
  const [selectedPod, setSelectedPod] = useState('');
  const [selectedKey, setSelectedKey] = useState('');

  // Value viewer
  const [cachedValue, setCachedValue] = useState<any>(null);
  const [valueLoading, setValueLoading] = useState(false);

  // Refresh
  const [refreshKeyInfix, setRefreshKeyInfix] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<ShudhiRefreshResponse | null>(null);

  // Loading states
  const [loadingServices, setLoadingServices] = useState(false);
  const [loadingPods, setLoadingPods] = useState(false);
  const [loadingKeys, setLoadingKeys] = useState(false);

  // Check connection on mount
  useEffect(() => {
    shudhiAPI
      .getStatus()
      .then((s: ShudhiStatusResponse) => {
        if (s.shudhi === 'connected' || s.status === 'ok') {
          setConnStatus('connected');
        } else if (s.shudhi === 'disabled' || s.status === 'not_configured') {
          setConnStatus('not_configured');
        } else {
          setConnStatus('unreachable');
        }
      })
      .catch(() => setConnStatus('unreachable'));
  }, []);

  // Load services when connected
  useEffect(() => {
    if (connStatus !== 'connected') return;
    loadServices();
  }, [connStatus]);

  const loadServices = useCallback(async () => {
    setLoadingServices(true);
    try {
      const data = await shudhiAPI.getServices();
      setServices(data);
      if (data.length > 0 && !selectedService) {
        setSelectedService(data[0]);
      }
    } catch {
      toast.error('Failed to load Shudhi services');
    } finally {
      setLoadingServices(false);
    }
  }, [selectedService]);

  // Load pods when service changes
  useEffect(() => {
    if (!selectedService) return;
    setPods([]);
    setSelectedPod('');
    setKeys([]);
    setSelectedKey('');
    setCachedValue(null);
    setRefreshResult(null);

    const loadPods = async () => {
      setLoadingPods(true);
      try {
        const data = await shudhiAPI.getPods(selectedService);
        setPods(data);
      } catch {
        toast.error('Failed to load pods');
      } finally {
        setLoadingPods(false);
      }
    };
    loadPods();
  }, [selectedService]);

  // Load keys when service or pod changes.
  // An empty selectedPod means "All pods" (a valid selection) — pass undefined so
  // the backend returns keys across all pods. The panel is lazy-mounted (only when
  // its tab is opened), so this no longer fires on initial page load.
  useEffect(() => {
    if (!selectedService) return;

    const loadKeys = async () => {
      setLoadingKeys(true);
      try {
        const data = await shudhiAPI.getKeys(selectedService, selectedPod || undefined);
        setKeys(data);
      } catch {
        // Keys might not be registered — that's OK
        setKeys([]);
      } finally {
        setLoadingKeys(false);
      }
    };
    loadKeys();
  }, [selectedService, selectedPod]);

  const handleGetValue = async (keyName?: string) => {
    const targetKey = keyName || selectedKey;
    if (!targetKey || !selectedPod || !selectedService) {
      toast.error('Select a service, pod, and key first');
      return;
    }
    setValueLoading(true);
    setCachedValue(null);
    try {
      const result = await shudhiAPI.getValue({
        serviceName: selectedService,
        podName: selectedPod,
        key: targetKey,
      });
      setCachedValue(result);
    } catch {
      toast.error('Failed to get cached value');
    } finally {
      setValueLoading(false);
    }
  };

  const handleRefresh = async () => {
    if (!selectedService) {
      toast.error('Select a service first');
      return;
    }
    setRefreshing(true);
    setRefreshResult(null);
    try {
      const result = await shudhiAPI.refreshCache({
        serviceName: selectedService,
        keyInfix: refreshKeyInfix || undefined,
      });
      setRefreshResult(result);
      toast.success(`Cache refreshed: ${result.confirmed}/${result.total} pods confirmed`);
    } catch {
      toast.error('Cache refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  const isReader = user?.role === 'READER';

  if (connStatus === 'not_configured') {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', py: 8, gap: 2 }}>
        <Typography variant="h6" color="text.secondary">Shudhi not configured</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 420, textAlign: 'center' }}>
          Add a <code>shudhi.json</code> config file or set the <code>SHUDHI_URL</code> environment variable to connect to a Shudhi sidecar.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, height: '100%' }}>
      {/* Status Bar */}
      <Paper elevation={1} sx={{ p: 1.5 }}>
        <Stack direction="row" alignItems="center" spacing={2}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            Shudhi
          </Typography>
          <Tooltip title={connStatus}>
            <Chip
              size="small"
              color={statusColor[connStatus]}
              icon={<CircleIcon sx={{ fontSize: 10 }} />}
              label={connStatus === 'connected' ? 'connected' : connStatus === 'checking' ? 'checking...' : connStatus}
              variant="outlined"
            />
          </Tooltip>
          <Box sx={{ flexGrow: 1 }} />
          <Button
            size="small"
            startIcon={<RefreshIcon />}
            onClick={loadServices}
            disabled={connStatus !== 'connected' || loadingServices}
          >
            Reload
          </Button>
        </Stack>
      </Paper>

      {/* Main Content */}
      <Box sx={{ display: 'flex', gap: 2, flex: 1, overflow: 'hidden' }}>
        {/* Left Panel: Service / Pod / Key selectors */}
        <Paper elevation={1} sx={{ width: 340, minWidth: 300, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <Stack spacing={2} sx={{ p: 2 }}>
            {/* Service Selector */}
            <FormControl size="small" fullWidth>
              <InputLabel>Service</InputLabel>
              <Select
                value={selectedService}
                label="Service"
                onChange={(e) => setSelectedService(e.target.value)}
                disabled={loadingServices || connStatus !== 'connected'}
              >
                {services.map((name) => (
                  <MenuItem key={name} value={name}>
                    {name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            {/* Pod Selector */}
            <FormControl size="small" fullWidth>
              <InputLabel>Pod</InputLabel>
              <Select
                value={selectedPod}
                label="Pod"
                onChange={(e) => {
                  setSelectedPod(e.target.value);
                  setCachedValue(null);
                }}
                disabled={!selectedService || loadingPods}
              >
                <MenuItem value="">
                  <em>All pods</em>
                </MenuItem>
                {pods.map((p) => (
                  <MenuItem key={p.podName} value={p.podName}>
                    {p.podName}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>

          <Divider />

          {/* Keys list */}
          <Box sx={{ flex: 1, overflow: 'auto', px: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ px: 1, pt: 1, display: 'block' }}>
              Registered Keys ({keys.length}) {loadingKeys && <CircularProgress size={12} sx={{ ml: 1 }} />}
            </Typography>
            {keys.length === 0 && !loadingKeys && (
              <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 2, textAlign: 'center' }}>
                {selectedService ? 'No registered keys' : 'Select a service'}
              </Typography>
            )}
            <List dense disablePadding>
              {keys.map((k, idx) => {
                // "All pods" entries are deduped and carry the full pod list; a
                // single-pod entry just shows its one pod.
                const podLabel = k.pods && k.pods.length
                  ? `${k.pods.length} pod${k.pods.length > 1 ? 's' : ''}: ${k.pods.join(', ')}`
                  : k.podName ? `pod: ${k.podName}` : undefined;
                return (
                  <ListItemButton
                    key={`${k.keyName}-${k.podName}-${idx}`}
                    selected={selectedKey === k.keyName}
                    onClick={() => {
                      setSelectedKey(k.keyName);
                      if (selectedPod) handleGetValue(k.keyName);
                    }}
                    sx={{ borderRadius: 1, my: 0.25 }}
                  >
                    <ListItemText
                      primary={k.keyName}
                      secondary={podLabel}
                      primaryTypographyProps={{ variant: 'body2', fontFamily: 'monospace', fontSize: '0.8rem' }}
                      secondaryTypographyProps={{ variant: 'caption', fontSize: '0.7rem' }}
                    />
                  </ListItemButton>
                );
              })}
            </List>
          </Box>
        </Paper>

        {/* Right Panel: Value viewer + Refresh */}
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' }}>
          {/* Get Value */}
          <Paper elevation={1} sx={{ p: 2 }}>
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
              Get Cached Value
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <TextField
                size="small"
                label="Cache Key"
                value={selectedKey}
                onChange={(e) => setSelectedKey(e.target.value)}
                sx={{ flex: 1 }}
                placeholder="Enter or select a key from the list"
              />
              <Button
                variant="contained"
                startIcon={<SearchIcon />}
                onClick={() => handleGetValue()}
                disabled={!selectedKey || !selectedPod || !selectedService || valueLoading}
              >
                {valueLoading ? 'Loading...' : 'Get'}
              </Button>
            </Stack>
            {!selectedPod && selectedKey && (
              <Typography variant="caption" color="warning.main" sx={{ mt: 0.5, display: 'block' }}>
                Select a specific pod to retrieve its cached value
              </Typography>
            )}
          </Paper>

          {/* Value Display */}
          {cachedValue !== null && (
            <Paper
              elevation={1}
              sx={{
                flex: 1,
                overflow: 'auto',
                p: 2,
                bgcolor: 'grey.900',
                position: 'relative',
              }}
            >
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                <Typography variant="caption" color="grey.400">
                  Response
                </Typography>
                <Tooltip title="Copy to clipboard">
                  <IconButton
                    size="small"
                    onClick={() => {
                      navigator.clipboard.writeText(JSON.stringify(cachedValue, null, 2));
                      toast.success('Copied to clipboard');
                    }}
                  >
                    <ContentCopyIcon sx={{ fontSize: 16, color: 'grey.400' }} />
                  </IconButton>
                </Tooltip>
              </Stack>
              <Box
                component="pre"
                sx={{
                  fontFamily: 'monospace',
                  fontSize: '0.82rem',
                  color: '#e0e0e0',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  m: 0,
                }}
              >
                {typeof cachedValue === 'string' ? cachedValue : JSON.stringify(cachedValue, null, 2)}
              </Box>
            </Paper>
          )}

          {/* Cache Refresh */}
          {!isReader && (
            <Paper elevation={1} sx={{ p: 2 }}>
              <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
                Invalidate Cache
              </Typography>
              <Stack direction="row" spacing={1} alignItems="center">
                <TextField
                  size="small"
                  label="Key infix (blank = all)"
                  value={refreshKeyInfix}
                  onChange={(e) => setRefreshKeyInfix(e.target.value)}
                  sx={{ flex: 1 }}
                  placeholder="e.g. configKey or leave empty to clear all"
                />
                <Button
                  variant="contained"
                  color="warning"
                  startIcon={<DeleteSweepIcon />}
                  onClick={handleRefresh}
                  disabled={!selectedService || refreshing}
                >
                  {refreshing ? 'Refreshing...' : 'Refresh'}
                </Button>
              </Stack>

              {/* Refresh result — per-pod ack breakdown */}
              {refreshResult && (
                <Box sx={{ mt: 1.5 }}>
                  <Typography variant="caption" color="text.secondary">
                    {refreshResult.confirmed}/{refreshResult.total} pods confirmed
                  </Typography>
                  <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                    {refreshResult.pods?.map((p) => (
                      <Stack key={p.podName} direction="row" alignItems="center" spacing={1}>
                        {p.success
                          ? <CheckCircleIcon sx={{ fontSize: 14, color: 'success.main' }} />
                          : <ErrorIcon sx={{ fontSize: 14, color: 'error.main' }} />}
                        <Typography variant="caption" fontFamily="monospace">
                          {p.podName}
                        </Typography>
                        {p.error && (
                          <Typography variant="caption" color="error.main">
                            — {p.error}
                          </Typography>
                        )}
                      </Stack>
                    ))}
                  </Stack>
                </Box>
              )}
            </Paper>
          )}
        </Box>
      </Box>
    </Box>
  );
};

export default ShudhiPanel;
