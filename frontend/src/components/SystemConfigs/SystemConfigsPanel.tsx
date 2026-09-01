import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import SaveIcon from '@mui/icons-material/Save';
import SettingsSuggestIcon from '@mui/icons-material/SettingsSuggest';
import toast from 'react-hot-toast';
import { schemaAPI, systemConfigsAPI, toastNonApiError } from '../../services/api';
import { buildDbMap, type DbMap } from '../Selector/databaseTopology';
import type { LeanFlowFeaturesConfig, SystemConfigRow } from '../../types';
import { useAppStore } from '../../store/appStore';

// Fallback only, used if GET /api/system-configs/lean-flow-features fails
// (e.g. offline). The real list lives in backend/config/leanFlowFeatures.json —
// edit that (or its K8s ConfigMap mount) to add/remove features, no frontend
// rebuild needed.
const FALLBACK_LEAN_FLOW_FEATURES: LeanFlowFeaturesConfig = {
  driver: [
    'LEADERBOARD',
    'REFERRAL',
    'RIDE_INTERPOLATION',
    'FLEET_OPERATOR_STATS',
    'GPS_TOLL_BEHAVIOR',
    'RC_STATS_REMINDERS',
    'RIDE_END_NOTIFICATIONS',
    'DRIVER_CITY_MIGRATION',
    'ANALYTICS_KAFKA',
    'SUPPLY_DEMAND',
    'CONGESTION_CHARGE',
    'DRIVER_COINS',
    'DEMAND_HOTSPOTS',
    'NAMMA_TAG_CHAKRA',
    'DYNAMIC_PRICING',
  ],
  rider: ['WALK_AND_SAVE', 'HOTSPOT', 'REWARD_INFLIGHT_RECONCILE', 'FRFS_SEAT_HOLD_REAPER', 'NAMMA_TAG_CHAKRA'],
};

type FeatureListChoice = 'auto' | 'driver' | 'rider';

// Best-effort guess at which app a schema/database belongs to, purely to pick
// which checkbox list to show by default. The admin can override it — this
// never affects what actually gets saved, only which checkboxes are offered.
const guessFeatureListChoice = (label: string): 'driver' | 'rider' => {
  const lower = label.toLowerCase();
  return lower.includes('driver') || lower.includes('bpp') ? 'driver' : 'rider';
};

interface LeanFlowShape {
  enabled: boolean;
  featuresExcluded: string[];
}

const isLeanFlowShape = (value: unknown): value is LeanFlowShape =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as any).enabled === 'boolean' &&
  Array.isArray((value as any).featuresExcluded);

const prettyPrint = (raw: string | null): string => {
  if (!raw) return '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};

const SystemConfigsPanel = () => {
  const user = useAppStore((s) => s.user);
  const canWrite = user?.role === 'MASTER' || user?.role === 'ADMIN';

  const [dbMap, setDbMap] = useState<DbMap>({});
  const [loadingTopology, setLoadingTopology] = useState(true);

  const [database, setDatabase] = useState('');
  const [cloud, setCloud] = useState('');
  const [pgSchema, setPgSchema] = useState('');

  const [configs, setConfigs] = useState<SystemConfigRow[]>([]);
  const [loadingConfigs, setLoadingConfigs] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [jsonText, setJsonText] = useState('');
  const [saving, setSaving] = useState(false);
  const [featureListChoice, setFeatureListChoice] = useState<FeatureListChoice>('auto');
  const [leanFlowFeatures, setLeanFlowFeatures] = useState<LeanFlowFeaturesConfig>(FALLBACK_LEAN_FLOW_FEATURES);

  // Load database/cloud/schema topology once on mount.
  useEffect(() => {
    schemaAPI
      .getConfiguration()
      .then((config) => setDbMap(buildDbMap(config)))
      .catch((error) => toastNonApiError(error, 'Failed to load database configuration'))
      .finally(() => setLoadingTopology(false));
  }, []);

  // Load the known lean_flow feature names from the backend config
  // (backend/config/leanFlowFeatures.json) once on mount. Falls back to the
  // baked-in list above if this fails, so the panel still works offline.
  useEffect(() => {
    systemConfigsAPI
      .getLeanFlowFeatures()
      .then(setLeanFlowFeatures)
      .catch((error) => toastNonApiError(error, 'Failed to load lean_flow feature list, using built-in defaults'));
  }, []);

  const databaseNames = Object.keys(dbMap);
  const selectedDbMeta = database ? dbMap[database] : undefined;
  const availableClouds = selectedDbMeta?.clouds.map((c) => c.cloudType) ?? [];
  const availableSchemas = selectedDbMeta?.schemas ?? [];

  // Default to the first database once topology arrives.
  useEffect(() => {
    if (loadingTopology || database || databaseNames.length === 0) return;
    setDatabase(databaseNames[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingTopology, databaseNames.length]);

  // Keep cloud/schema in sync with whichever database is selected.
  useEffect(() => {
    if (!selectedDbMeta) return;
    setCloud((prev) => (availableClouds.includes(prev) ? prev : selectedDbMeta.clouds[0]?.cloudType || ''));
    setPgSchema((prev) =>
      availableSchemas.includes(prev) ? prev : selectedDbMeta.defaultSchema || availableSchemas[0] || ''
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [database, selectedDbMeta]);

  const loadConfigs = useCallback(async () => {
    if (!database || !cloud || !pgSchema) return;
    setLoadingConfigs(true);
    setSelectedId(null);
    setJsonText('');
    try {
      const rows = await systemConfigsAPI.list(database, cloud, pgSchema);
      setConfigs(rows);
    } catch (error) {
      toastNonApiError(error, 'Failed to load system_configs');
      setConfigs([]);
    } finally {
      setLoadingConfigs(false);
    }
  }, [database, cloud, pgSchema]);

  useEffect(() => {
    loadConfigs();
  }, [loadConfigs]);

  const selectedRow = configs.find((c) => c.id === selectedId) || null;

  const handleSelectRow = (row: SystemConfigRow) => {
    setSelectedId(row.id);
    setJsonText(prettyPrint(row.configValue));
    setFeatureListChoice('auto');
  };

  const parsedJson = useMemo(() => {
    if (jsonText.trim() === '') return undefined;
    try {
      return JSON.parse(jsonText);
    } catch {
      return null;
    }
  }, [jsonText]);

  const jsonIsValid = parsedJson !== null && parsedJson !== undefined;
  const leanFlowShape = isLeanFlowShape(parsedJson) ? parsedJson : null;

  const effectiveFeatureList =
    featureListChoice === 'driver'
      ? leanFlowFeatures.driver
      : featureListChoice === 'rider'
        ? leanFlowFeatures.rider
        : guessFeatureListChoice(pgSchema || database) === 'driver'
          ? leanFlowFeatures.driver
          : leanFlowFeatures.rider;

  const updateLeanFlowJson = (next: LeanFlowShape) => {
    setJsonText(JSON.stringify(next, null, 2));
  };

  const toggleEnabled = () => {
    if (!leanFlowShape) return;
    updateLeanFlowJson({ ...leanFlowShape, enabled: !leanFlowShape.enabled });
  };

  const toggleFeature = (feature: string) => {
    if (!leanFlowShape) return;
    const isExcluded = leanFlowShape.featuresExcluded.includes(feature);
    const nextExcluded = isExcluded
      ? leanFlowShape.featuresExcluded.filter((f) => f !== feature)
      : [...leanFlowShape.featuresExcluded, feature];
    updateLeanFlowJson({ ...leanFlowShape, featuresExcluded: nextExcluded });
  };

  const handleSave = async () => {
    if (!selectedRow || !jsonIsValid) return;
    setSaving(true);
    try {
      const updated = await systemConfigsAPI.update({
        database,
        cloud,
        pgSchema,
        id: selectedRow.id,
        configValue: JSON.stringify(parsedJson),
      });
      setConfigs((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      toast.success(`Saved '${updated.id}'`);
    } catch (error) {
      toastNonApiError(error, 'Failed to save system config');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, height: '100%' }}>
      {/* Selector bar */}
      <Paper elevation={1} sx={{ p: 1.5 }}>
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            System Configs
          </Typography>

          <FormControl size="small" sx={{ minWidth: 160 }}>
            <InputLabel>Database</InputLabel>
            <Select
              value={database}
              label="Database"
              onChange={(e) => setDatabase(e.target.value)}
              disabled={loadingTopology}
            >
              {databaseNames.map((name) => (
                <MenuItem key={name} value={name}>
                  {dbMap[name].label || name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl size="small" sx={{ minWidth: 140 }}>
            <InputLabel>Cloud</InputLabel>
            <Select value={cloud} label="Cloud" onChange={(e) => setCloud(e.target.value)} disabled={!database}>
              {availableClouds.map((c) => (
                <MenuItem key={c} value={c}>
                  {c}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl size="small" sx={{ minWidth: 160 }}>
            <InputLabel>Schema</InputLabel>
            <Select value={pgSchema} label="Schema" onChange={(e) => setPgSchema(e.target.value)} disabled={!database}>
              {availableSchemas.map((s) => (
                <MenuItem key={s} value={s}>
                  {s}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Box sx={{ flexGrow: 1 }} />

          <Button size="small" startIcon={<RefreshIcon />} onClick={loadConfigs} disabled={loadingConfigs}>
            Reload
          </Button>
        </Stack>
      </Paper>

      {/* Main content */}
      <Box sx={{ display: 'flex', gap: 2, flex: 1, overflow: 'hidden' }}>
        {/* Left: config row list */}
        <Paper elevation={1} sx={{ width: 280, minWidth: 240, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <Typography variant="caption" color="text.secondary" sx={{ px: 1.5, pt: 1.5, display: 'block' }}>
            Rows ({configs.length}) {loadingConfigs && <CircularProgress size={12} sx={{ ml: 1 }} />}
          </Typography>
          <Divider sx={{ mt: 1 }} />
          <Box sx={{ flex: 1, overflow: 'auto' }}>
            {configs.length === 0 && !loadingConfigs && (
              <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, py: 2, textAlign: 'center' }}>
                No system_configs rows in this schema
              </Typography>
            )}
            <List dense disablePadding>
              {configs.map((row) => (
                <ListItemButton
                  key={row.id}
                  selected={selectedId === row.id}
                  onClick={() => handleSelectRow(row)}
                  sx={{ borderRadius: 1, my: 0.25, mx: 0.5 }}
                >
                  <ListItemText
                    primary={row.id}
                    primaryTypographyProps={{ variant: 'body2', fontFamily: 'monospace', fontSize: '0.82rem' }}
                  />
                </ListItemButton>
              ))}
            </List>
          </Box>
        </Paper>

        {/* Right: editor */}
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, overflow: 'auto' }}>
          {!selectedRow && (
            <Paper elevation={1} sx={{ p: 4, textAlign: 'center' }}>
              <Typography variant="body2" color="text.secondary">
                Select a row to view or edit it
              </Typography>
            </Paper>
          )}

          {selectedRow && (
            <>
              {/* Friendly lean_flow editor — only shown when the current JSON actually
                  matches the {enabled, featuresExcluded} shape. Every edit here just
                  rewrites the JSON text below, which stays the single source of truth
                  for what gets saved. */}
              {leanFlowShape && (
                <Paper elevation={1} sx={{ p: 2 }}>
                  <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
                    <SettingsSuggestIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
                    <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                      lean_flow
                    </Typography>
                    <Chip
                      size="small"
                      label={leanFlowShape.enabled ? 'enabled' : 'disabled'}
                      color={leanFlowShape.enabled ? 'success' : 'default'}
                      variant="outlined"
                    />
                    <Box sx={{ flexGrow: 1 }} />
                    <ToggleButtonGroup
                      size="small"
                      exclusive
                      value={featureListChoice}
                      onChange={(_, v) => v && setFeatureListChoice(v)}
                    >
                      <ToggleButton value="auto" sx={{ fontSize: '0.7rem', py: 0.25 }}>
                        auto
                      </ToggleButton>
                      <ToggleButton value="driver" sx={{ fontSize: '0.7rem', py: 0.25 }}>
                        driver
                      </ToggleButton>
                      <ToggleButton value="rider" sx={{ fontSize: '0.7rem', py: 0.25 }}>
                        rider
                      </ToggleButton>
                    </ToggleButtonGroup>
                  </Stack>

                  <FormControlLabel
                    control={<Switch checked={leanFlowShape.enabled} onChange={toggleEnabled} disabled={!canWrite} />}
                    label="Enabled — when off, all features below run normally regardless of the checkboxes"
                    sx={{ mb: 1 }}
                  />

                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                    Excluded (disabled) features — checked = forced off
                  </Typography>
                  <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
                    {effectiveFeatureList.map((feature) => (
                      <FormControlLabel
                        key={feature}
                        control={
                          <Checkbox
                            size="small"
                            checked={leanFlowShape.featuresExcluded.includes(feature)}
                            onChange={() => toggleFeature(feature)}
                            disabled={!canWrite}
                          />
                        }
                        label={<Typography variant="body2" fontFamily="monospace" fontSize="0.78rem">{feature}</Typography>}
                      />
                    ))}
                  </Box>

                  {leanFlowShape.featuresExcluded.some((f) => !effectiveFeatureList.includes(f)) && (
                    <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 1 }}>
                      This row already excludes feature(s) not in the {featureListChoice === 'auto' ? 'guessed' : featureListChoice}{' '}
                      list — switch the toggle above if this is actually the other app's schema. Nothing is lost; the raw JSON below
                      still has them.
                    </Typography>
                  )}
                </Paper>
              )}

              {/* Raw JSON — always the actual value that gets saved */}
              <Paper elevation={1} sx={{ p: 2, flex: 1, display: 'flex', flexDirection: 'column' }}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                    {selectedRow.id} — config_value
                  </Typography>
                  {!jsonIsValid && (
                    <Chip size="small" label="invalid JSON" color="error" variant="outlined" />
                  )}
                  <Box sx={{ flexGrow: 1 }} />
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={<SaveIcon />}
                    onClick={handleSave}
                    disabled={!canWrite || !jsonIsValid || saving}
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </Button>
                </Stack>
                {!canWrite && (
                  <Typography variant="caption" color="text.secondary" sx={{ mb: 1 }}>
                    Your role can view but not save system_configs changes.
                  </Typography>
                )}
                <TextField
                  multiline
                  fullWidth
                  minRows={12}
                  maxRows={24}
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  disabled={!canWrite}
                  InputProps={{ sx: { fontFamily: 'monospace', fontSize: '0.82rem' } }}
                  sx={{ flex: 1 }}
                />
              </Paper>
            </>
          )}
        </Box>
      </Box>
    </Box>
  );
};

export default SystemConfigsPanel;
