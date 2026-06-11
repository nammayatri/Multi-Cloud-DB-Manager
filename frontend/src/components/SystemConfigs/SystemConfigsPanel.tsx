import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { Editor } from '@monaco-editor/react';
import SearchIcon from '@mui/icons-material/Search';
import RefreshIcon from '@mui/icons-material/Refresh';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import RuleIcon from '@mui/icons-material/Rule';
import PublishIcon from '@mui/icons-material/Publish';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SettingsSuggestIcon from '@mui/icons-material/SettingsSuggest';
import toast from 'react-hot-toast';
import { toastNonApiError } from '../../services/api';
import { systemConfigsAPI } from '../../services/systemConfigsApi';
import SystemConfigApplyDialog from './SystemConfigApplyDialog';
import type {
  SystemConfigTarget,
  SystemConfigTargetInfo,
  SystemConfigResponse,
  SystemConfigValidateResponse,
  SystemConfigExecuteResponse,
} from '../../types';

const SEARCH_DEBOUNCE_MS = 300;
const KEY_LIST_LIMIT = 200; // server-side LIMIT on GET /keys

const SystemConfigsPanel = () => {
  // Targets (rider / driver) — loaded once on mount
  const [targets, setTargets] = useState<SystemConfigTargetInfo[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [targetsError, setTargetsError] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<SystemConfigTarget | ''>('');

  // Key list + debounced search
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [keys, setKeys] = useState<string[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(false);

  // Selected config
  const [selectedId, setSelectedId] = useState('');
  const [config, setConfig] = useState<SystemConfigResponse | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(false);

  // Editor state — editedText is the raw text sent VERBATIM to the backend.
  const [editedText, setEditedText] = useState('');
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<SystemConfigValidateResponse | null>(null);

  // Apply dialog + result
  const [dialogOpen, setDialogOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const [lastApply, setLastApply] = useState<SystemConfigExecuteResponse | null>(null);
  const [applyNotFound, setApplyNotFound] = useState(false);

  // Race guards — only the latest request of each kind may update state.
  const keysSeq = useRef(0);
  const configSeq = useRef(0);

  const loadTargets = useCallback(async () => {
    setTargetsError(false);
    setTargets(null);
    try {
      const res = await systemConfigsAPI.getTargets();
      setConfigured(res.configured);
      setTargets(res.targets);
      if (res.configured && res.targets.length > 0) {
        setSelectedTarget((prev) =>
          prev && res.targets.some((t) => t.key === prev) ? prev : res.targets[0].key
        );
      }
    } catch (error) {
      setTargetsError(true);
      setTargets([]);
      toastNonApiError(error, 'Failed to load System Configs targets');
    }
  }, []);

  useEffect(() => {
    loadTargets();
  }, [loadTargets]);

  // Debounce the key search input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // Load keys whenever the target or (debounced) search changes
  useEffect(() => {
    if (!selectedTarget) return;
    const seq = ++keysSeq.current;
    setLoadingKeys(true);
    systemConfigsAPI
      .getKeys(selectedTarget, debouncedSearch)
      .then((res) => {
        if (seq !== keysSeq.current) return;
        setKeys(res.keys);
      })
      .catch((error) => {
        if (seq !== keysSeq.current) return;
        setKeys([]);
        toastNonApiError(error, 'Failed to load config keys');
      })
      .finally(() => {
        if (seq === keysSeq.current) setLoadingKeys(false);
      });
  }, [selectedTarget, debouncedSearch]);

  const loadConfig = useCallback(
    async (id: string) => {
      if (!selectedTarget || !id) return;
      const seq = ++configSeq.current;
      setLoadingConfig(true);
      try {
        const res = await systemConfigsAPI.getConfig(selectedTarget, id);
        if (seq !== configSeq.current) return;
        setConfig(res);
        // Initialize the editable copy to the EXACT stored string — no reformatting.
        setEditedText(res.configValue ?? '');
        setValidation(null);
        setApplyNotFound(false);
      } catch (error) {
        if (seq !== configSeq.current) return;
        setConfig(null);
        toastNonApiError(error, 'Failed to load config value');
      } finally {
        if (seq === configSeq.current) setLoadingConfig(false);
      }
    },
    [selectedTarget]
  );

  const handleSelectKey = (id: string) => {
    setSelectedId(id);
    setLastApply(null);
    loadConfig(id);
  };

  const handleTargetChange = (target: SystemConfigTarget) => {
    if (target === selectedTarget) return;
    setSelectedTarget(target);
    // Reset everything tied to the previous target's schema.
    setSelectedId('');
    setConfig(null);
    setEditedText('');
    setValidation(null);
    setLastApply(null);
    setApplyNotFound(false);
  };

  const targetInfo = useMemo(
    () => targets?.find((t) => t.key === selectedTarget) ?? null,
    [targets, selectedTarget]
  );

  // Live client-side JSON lint of the editable copy
  const parseError = useMemo(() => {
    if (!editedText.trim()) return 'Value is empty — config values must be valid JSON';
    try {
      JSON.parse(editedText);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : 'Invalid JSON';
    }
  }, [editedText]);

  const original = config?.configValue ?? '';
  const isDirty = !!config && editedText !== original;
  const canApply = !!config?.exists && isDirty && !parseError && !applying && !loadingConfig;

  const handleValidate = async () => {
    if (!selectedTarget) return;
    setValidating(true);
    setValidation(null);
    try {
      // Send the exact edited text — server validates against the Tables schema.
      const res = await systemConfigsAPI.validate(selectedTarget, editedText);
      setValidation(res);
    } catch (error) {
      toastNonApiError(error, 'Validation request failed');
    } finally {
      setValidating(false);
    }
  };

  const handleApplyConfirm = async (password: string) => {
    if (!selectedTarget || !config) return;
    setApplying(true);
    setDialogError('');
    try {
      const res = await systemConfigsAPI.execute({
        target: selectedTarget,
        id: config.id,
        configValue: editedText, // exact edited text, verbatim
        password,
      });
      setDialogOpen(false);
      setLastApply(res);
      setApplyNotFound(false);
      toast.success(
        res.verified === 'verified'
          ? `Config "${res.id}" updated & verified (${res.durationMs} ms)`
          : `Config "${res.id}" update accepted — verification pending`
      );
      // Reload the stored value so the panel reflects what's actually in the DB.
      // When verification is pending (replica lag) the reload likely returns the
      // OLD value — keep the just-applied text in the editor so it isn't lost.
      const applied = editedText;
      await loadConfig(config.id);
      if (res.verified === 'pending') setEditedText(applied);
    } catch (error: any) {
      const status: number | undefined = error?.response?.status;
      if (status === 401) {
        // Wrong manager password — surface inside the dialog, keep it open.
        // (The shared interceptor skips redirect/toast for this exact case.)
        setDialogError(error?.response?.data?.error || 'Invalid password');
      } else if (status === 404) {
        // Row vanished between listing and applying — interceptor already
        // toasted the server message; add a persistent inline explanation.
        setDialogOpen(false);
        setApplyNotFound(true);
      } else if (status === 502 || status === 503) {
        // Dashboard call failed / manager unconfigured — crafted backend
        // messages the interceptor deliberately skips for this route. Show
        // inline and keep the dialog open so the operator can retry.
        setDialogError(error?.response?.data?.error || 'Dashboard call failed — please retry');
      } else {
        // Interceptor toasts API errors (e.g. 400 schema failure); only
        // toast here for non-API failures.
        setDialogOpen(false);
        toastNonApiError(error, 'Failed to apply config update');
      }
    } finally {
      setApplying(false);
    }
  };

  // ---- Top-level states ----------------------------------------------------

  if (targets === null) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 8 }}>
        <CircularProgress size={32} />
      </Box>
    );
  }

  if (targetsError) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', py: 8, gap: 2 }}>
        <Typography variant="h6" color="error">Failed to load System Configs</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 420, textAlign: 'center' }}>
          The targets endpoint could not be reached. Check that the backend is up and try again.
        </Typography>
        <Button variant="contained" startIcon={<RefreshIcon />} onClick={loadTargets}>
          Retry
        </Button>
      </Box>
    );
  }

  if (!configured || targets.length === 0) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', py: 8, gap: 2 }}>
        <SettingsSuggestIcon sx={{ fontSize: 48, color: 'text.secondary' }} />
        <Typography variant="h6" color="text.secondary">System Configs not configured</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 460, textAlign: 'center' }}>
          This feature edits <code>system_configs</code> rows through the Namma Yatri ops
          dashboard, but the backend has no dashboard connection configured. Add{' '}
          <code>backend/config/system-configs.json</code> and restart the backend to enable it.
        </Typography>
      </Box>
    );
  }

  // ---- Main layout ----------------------------------------------------------

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, height: '100%' }}>
      {/* Header bar: target selector + permanent audit caption */}
      <Paper elevation={1} sx={{ p: 1.5 }}>
        <Stack direction="row" alignItems="center" spacing={2} flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            System Configs
          </Typography>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={selectedTarget}
            onChange={(_, value: SystemConfigTarget | null) => {
              if (value) handleTargetChange(value);
            }}
          >
            {targets.map((t) => (
              <ToggleButton key={t.key} value={t.key} sx={{ textTransform: 'none', px: 2, py: 0.5 }}>
                <Stack alignItems="flex-start" spacing={0}>
                  <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.2 }}>
                    {t.label}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', lineHeight: 1.2 }}>
                    {t.schema}.system_configs
                  </Typography>
                </Stack>
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Box sx={{ flexGrow: 1 }} />
          <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 420 }}>
            Writes go through the Namma Yatri ops dashboard (runQuery) and are audited.
            UPDATE-only — new rows cannot be created from this tab.
          </Typography>
        </Stack>
      </Paper>

      {/* Main content: key list + editor */}
      <Box sx={{ display: 'flex', gap: 2, flex: 1, overflow: 'hidden', minHeight: 480 }}>
        {/* Left: searchable key list */}
        <Paper elevation={1} sx={{ width: 340, minWidth: 300, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <Box sx={{ p: 1.5, pb: 1 }}>
            <TextField
              size="small"
              fullWidth
              placeholder="Search keys…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              InputProps={{
                startAdornment: <SearchIcon sx={{ fontSize: 18, mr: 0.5, color: 'text.secondary' }} />,
              }}
            />
            <Typography variant="caption" color="text.secondary" sx={{ pt: 1, display: 'block' }}>
              Keys ({keys.length}{keys.length >= KEY_LIST_LIMIT ? `, first ${KEY_LIST_LIMIT} shown — refine the search` : ''})
              {loadingKeys && <CircularProgress size={12} sx={{ ml: 1 }} />}
            </Typography>
          </Box>
          <Divider />
          <Box sx={{ flex: 1, overflow: 'auto', px: 1, py: 0.5 }}>
            {keys.length === 0 && !loadingKeys && (
              <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 2, textAlign: 'center' }}>
                {debouncedSearch ? 'No keys match the search' : 'No config keys found'}
              </Typography>
            )}
            <List dense disablePadding>
              {keys.map((id) => (
                <ListItemButton
                  key={id}
                  selected={selectedId === id}
                  onClick={() => handleSelectKey(id)}
                  sx={{ borderRadius: 1, my: 0.25 }}
                >
                  <ListItemText
                    primary={id}
                    primaryTypographyProps={{
                      variant: 'body2',
                      fontFamily: 'monospace',
                      fontSize: '0.8rem',
                      sx: { wordBreak: 'break-all' },
                    }}
                  />
                </ListItemButton>
              ))}
            </List>
          </Box>
        </Paper>

        {/* Right: current value + editor */}
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, overflow: 'auto', minWidth: 0 }}>
          {!selectedId && (
            <Paper elevation={1} sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 4 }}>
              <Typography variant="body2" color="text.secondary">
                Select a config key from the list to view and edit its value
              </Typography>
            </Paper>
          )}

          {selectedId && loadingConfig && !config && (
            <Paper elevation={1} sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 4 }}>
              <CircularProgress size={28} />
            </Paper>
          )}

          {selectedId && config && (
            <>
              {/* Current stored value — read-only, shown EXACTLY as stored */}
              <Paper elevation={1} sx={{ p: 2 }}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 600, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                    {config.id}
                  </Typography>
                  {lastApply && (
                    <Tooltip
                      title={
                        lastApply.verified === 'verified'
                          ? 'Update applied and read back successfully'
                          : 'Update accepted by the dashboard — the read replica is still catching up'
                      }
                    >
                      <Chip
                        size="small"
                        label={lastApply.verified}
                        color={lastApply.verified === 'verified' ? 'success' : 'warning'}
                        variant="outlined"
                      />
                    </Tooltip>
                  )}
                  <Box sx={{ flexGrow: 1 }} />
                  {loadingConfig && <CircularProgress size={14} />}
                  <Tooltip title="Copy stored value">
                    <span>
                      <IconButton
                        size="small"
                        disabled={config.configValue === null}
                        onClick={() => {
                          navigator.clipboard.writeText(config.configValue ?? '');
                          toast.success('Copied to clipboard');
                        }}
                      >
                        <ContentCopyIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title="Reload stored value">
                    <IconButton size="small" onClick={() => loadConfig(config.id)} disabled={loadingConfig}>
                      <RefreshIcon sx={{ fontSize: 18 }} />
                    </IconButton>
                  </Tooltip>
                </Stack>

                {lastApply?.verified === 'pending' && (
                  <Typography variant="caption" color="warning.main" sx={{ display: 'block', mb: 1 }}>
                    The dashboard accepted the update but the replica hasn't confirmed it yet —
                    use the refresh button to re-check the stored value.
                  </Typography>
                )}

                {!config.exists ? (
                  <Alert severity="warning">
                    Key <strong>{config.id}</strong> does not exist in{' '}
                    <strong>{targetInfo?.schema}.system_configs</strong>. This tab can only
                    UPDATE existing rows — create the row via the DB Manager SQL console first.
                  </Alert>
                ) : config.configValue === null ? (
                  <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                    Stored value is NULL
                  </Typography>
                ) : (
                  <Box
                    component="pre"
                    sx={{
                      m: 0,
                      p: 1.5,
                      maxHeight: 220,
                      overflow: 'auto',
                      bgcolor: 'background.default',
                      borderRadius: 1,
                      fontFamily: 'monospace',
                      fontSize: '0.8rem',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                    }}
                  >
                    {config.configValue}
                  </Box>
                )}
              </Paper>

              {/* Editable copy */}
              {config.exists && (
                <Paper elevation={1} sx={{ p: 2 }}>
                  <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
                    <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                      Edit value
                    </Typography>
                    <Chip
                      size="small"
                      label={isDirty ? 'modified' : 'unchanged'}
                      color={isDirty ? 'info' : 'default'}
                      variant="outlined"
                    />
                    <Box sx={{ flexGrow: 1 }} />
                    <Button
                      size="small"
                      startIcon={<RestartAltIcon />}
                      onClick={() => {
                        setEditedText(original);
                        setValidation(null);
                      }}
                      disabled={!isDirty}
                    >
                      Reset
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={validating ? <CircularProgress size={14} /> : <RuleIcon />}
                      onClick={handleValidate}
                      disabled={validating || !editedText.trim()}
                    >
                      Validate
                    </Button>
                    <Button
                      size="small"
                      variant="contained"
                      color="warning"
                      startIcon={<PublishIcon />}
                      onClick={() => {
                        setDialogError('');
                        setDialogOpen(true);
                      }}
                      disabled={!canApply}
                    >
                      Apply
                    </Button>
                  </Stack>

                  <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
                    <Editor
                      height="280px"
                      defaultLanguage="json"
                      value={editedText}
                      onChange={(value) => setEditedText(value ?? '')}
                      theme="vs-dark"
                      options={{
                        minimap: { enabled: false },
                        fontSize: 13,
                        lineNumbers: 'on',
                        scrollBeyondLastLine: false,
                        automaticLayout: true,
                        tabSize: 2,
                        wordWrap: 'on',
                        // The edited text is sent verbatim — never auto-reformat it.
                        formatOnPaste: false,
                        formatOnType: false,
                        scrollbar: {
                          vertical: 'auto',
                          horizontal: 'auto',
                          handleMouseWheel: true,
                          alwaysConsumeMouseWheel: false,
                        },
                      }}
                    />
                  </Box>

                  <Stack spacing={1} sx={{ mt: 1.5 }}>
                    {parseError && (
                      <Alert severity="error" sx={{ py: 0.5 }}>
                        JSON parse error: {parseError}
                      </Alert>
                    )}

                    {validation && validation.valid && (
                      <Alert severity="success" sx={{ py: 0.5 }}>
                        Server-side schema validation passed
                      </Alert>
                    )}
                    {validation && !validation.valid && (
                      <Alert severity="error" sx={{ py: 0.5 }}>
                        <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
                          Schema validation failed:
                        </Typography>
                        <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                          {validation.errors.map((err, i) => (
                            <li key={i}>
                              <Typography variant="body2">{err}</Typography>
                            </li>
                          ))}
                        </Box>
                      </Alert>
                    )}

                    {applyNotFound && (
                      <Alert severity="warning" onClose={() => setApplyNotFound(false)}>
                        This key no longer exists in{' '}
                        <strong>{targetInfo?.schema}.system_configs</strong> — system_configs
                        rows cannot be INSERTed from this tab. Create the row via the DB
                        Manager SQL console first, then retry.
                      </Alert>
                    )}

                    {!parseError && !isDirty && (
                      <Typography variant="caption" color="text.secondary">
                        Apply is enabled once the value differs from the stored one and parses as JSON.
                      </Typography>
                    )}
                  </Stack>
                </Paper>
              )}
            </>
          )}
        </Box>
      </Box>

      {/* Confirm + password dialog */}
      <SystemConfigApplyDialog
        open={dialogOpen}
        target={targetInfo}
        configId={config?.id ?? ''}
        oldValue={config?.configValue ?? null}
        newValue={editedText}
        applying={applying}
        errorMessage={dialogError}
        onConfirm={handleApplyConfirm}
        onCancel={() => {
          setDialogOpen(false);
          setDialogError('');
        }}
      />
    </Box>
  );
};

export default SystemConfigsPanel;
