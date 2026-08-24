import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { schemaAPI } from '../../services/api';
import { useConfigReplicateStore } from '../../store/configReplicateStore';
import type { ConfigGroup } from '../../types/configReplicate';
import type { DatabaseConfiguration as DbConfig } from '../../types';
import DiffResultsView from './DiffResultsView';
import GroupWizard from './GroupWizard';
import ReplicateActionBar from './ReplicateActionBar';
import ReplicateSummaryBar from './ReplicateSummaryBar';

const STATUS_COLOR: Record<string, 'success' | 'error' | 'warning' | 'default'> = {
  SUCCEEDED: 'success',
  FAILED: 'error',
  ABORTED: 'warning',
  RUNNING: 'default',
};

const ConfigReplicatePanel = () => {
  const store = useConfigReplicateStore();
  const [config, setConfig] = useState<DbConfig | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ConfigGroup | null>(null);
  const [tab, setTab] = useState(0);

  useEffect(() => {
    void store.loadGroups();
    void store.loadRuns();
    schemaAPI
      .getConfiguration()
      .then(setConfig)
      .catch(() => undefined);
  }, []);

  const databases = useMemo(() => {
    if (!config) return [];
    if (config.databasesByName) return Object.keys(config.databasesByName);
    return config.primary?.databases?.map(d => d.name) || [];
  }, [config]);

  const cloudsFor = useCallback(
    (database: string): Array<{ name: string; role: 'primary' | 'secondary' }> => {
      if (!config || !database) return [];
      const entry = config.databasesByName?.[database];
      if (entry) return entry.clouds.map(c => ({ name: c.cloudType, role: c.role }));

      const result: Array<{ name: string; role: 'primary' | 'secondary' }> = [];
      if (config.primary?.databases?.some(d => d.name === database)) {
        result.push({ name: config.primary.cloudName, role: 'primary' });
      }
      for (const cloud of config.secondary || []) {
        if (cloud.databases.some(d => d.name === database)) {
          result.push({ name: cloud.cloudName, role: 'secondary' });
        }
      }
      return result;
    },
    [config]
  );

  const clouds = useMemo(() => cloudsFor(store.database), [cloudsFor, store.database]);

  const isSecondaryCloud = clouds.find(c => c.name === store.cloud)?.role === 'secondary';
  const dimensionColumns = store.activeGroup?.dimensionColumns ?? [];

  const openWizard = async (groupId?: string) => {
    if (groupId) {
      const group = await store.loadGroup(groupId);
      setEditingGroup(group);
    } else {
      setEditingGroup(null);
    }
    setWizardOpen(true);
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ minHeight: 36, mb: 1 }}>
        <Tab label="Replicate" sx={{ minHeight: 36, py: 0 }} />
        <Tab label="Groups" sx={{ minHeight: 36, py: 0 }} />
        <Tab label="History" sx={{ minHeight: 36, py: 0 }} />
      </Tabs>

      {tab === 0 && (
        <Box sx={{ flex: 1, overflowY: 'auto', pb: 10 }}>
          <Paper elevation={0} sx={{ p: 1.5, mb: 1.5, border: 1, borderColor: 'divider' }}>
            <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
              <FormControl size="small" sx={{ minWidth: 200 }}>
                <InputLabel>Config group</InputLabel>
                <Select
                  label="Config group"
                  value={store.groupId}
                  onChange={e => store.setGroupId(e.target.value)}
                >
                  {store.groups.map(group => (
                    <MenuItem key={group.id} value={group.id}>
                      {group.name} ({group.tableCount} tables · {group.dimensionColumns.length} dim)
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <FormControl size="small" sx={{ minWidth: 140 }}>
                <InputLabel>Database</InputLabel>
                <Select
                  label="Database"
                  value={store.database}
                  onChange={e => {
                    store.setDatabase(e.target.value);
                    store.setCloud('');
                  }}
                >
                  {databases.map(db => (
                    <MenuItem key={db} value={db}>
                      {db}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <FormControl size="small" sx={{ minWidth: 140 }} disabled={!store.database}>
                <InputLabel>Cloud</InputLabel>
                <Select
                  label="Cloud"
                  value={store.cloud}
                  onChange={e => store.setCloud(e.target.value)}
                >
                  {clouds.map(cloud => (
                    <MenuItem key={cloud.name} value={cloud.name}>
                      {cloud.name} ({cloud.role})
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              {dimensionColumns.map((dimension, index) => (
                <Stack key={dimension} direction="row" spacing={0.75} alignItems="center">
                  <TextField
                    size="small"
                    label={`Base ${dimension}`}
                    sx={{ width: 190 }}
                    value={store.baseValues[index] ?? ''}
                    onChange={e => store.setBaseValue(index, e.target.value)}
                  />
                  <ArrowForwardIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                  <TextField
                    size="small"
                    label={`New ${dimension}`}
                    sx={{ width: 190 }}
                    value={store.newValues[index] ?? ''}
                    onChange={e => store.setNewValue(index, e.target.value)}
                  />
                </Stack>
              ))}

              <Button
                variant="contained"
                size="small"
                startIcon={store.isAnalyzing ? <CircularProgress size={14} /> : <PlayArrowIcon />}
                onClick={() => void store.analyze()}
                disabled={store.isAnalyzing}
              >
                {store.isAnalyzing ? 'Analyzing…' : 'Analyze'}
              </Button>
            </Stack>

            {store.activeGroup && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                Dimension: <strong>{dimensionColumns.join(' + ')}</strong> ·{' '}
                {store.activeGroup.tables.length} table(s)
              </Typography>
            )}
          </Paper>

          {store.error && (
            <Alert severity="error" sx={{ mb: 1.5 }}>
              {store.error}
            </Alert>
          )}

          {store.lastRun?.drift?.length ? (
            <Alert severity="warning" sx={{ mb: 1.5 }}>
              The data changed since the last analysis, so nothing was applied. Re-analyzed —
              review the changes again. ({store.lastRun.drift.length} row(s) drifted)
            </Alert>
          ) : null}

          {store.lastRun?.status === 'FAILED' && (
            <Alert severity="error" sx={{ mb: 1.5 }}>
              Apply failed and was rolled back — nothing changed. {store.lastRun.error}
            </Alert>
          )}

          <ReplicateSummaryBar />
          <DiffResultsView />

          {!store.analysis && !store.isAnalyzing && !store.error && (
            <Alert severity="info">
              Pick a group, database, cloud, and the two dimension values, then Analyze. Nothing is
              written until you review the changes and press Apply.
            </Alert>
          )}
        </Box>
      )}

      {tab === 1 && (
        <Box sx={{ flex: 1, overflowY: 'auto' }}>
          <Stack direction="row" sx={{ mb: 1.5 }}>
            <Box sx={{ flexGrow: 1 }} />
            <Button variant="contained" size="small" startIcon={<AddIcon />} onClick={() => openWizard()}>
              New group
            </Button>
          </Stack>

          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Dimension</TableCell>
                <TableCell align="right">Tables</TableCell>
                <TableCell>Created by</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {store.groups.map(group => (
                <TableRow key={group.id} hover>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {group.name}
                    </Typography>
                    {group.description && (
                      <Typography variant="caption" color="text.secondary">
                        {group.description}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                    {group.dimensionColumns.join(' + ')}
                  </TableCell>
                  <TableCell align="right">{group.tableCount}</TableCell>
                  <TableCell>{group.createdByUsername || '—'}</TableCell>
                  <TableCell align="right">
                    <Tooltip title="Edit">
                      <IconButton size="small" onClick={() => void openWizard(group.id)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete">
                      <IconButton size="small" onClick={() => void store.deleteGroup(group.id)}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
              {store.groups.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5}>
                    <Typography variant="caption" color="text.secondary">
                      No config groups yet.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      )}

      {tab === 2 && (
        <Box sx={{ flex: 1, overflowY: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>When</TableCell>
                <TableCell>Group</TableCell>
                <TableCell>Target</TableCell>
                <TableCell>Change</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Rows</TableCell>
                <TableCell>By</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {store.runs.map(run => (
                <TableRow key={run.id} hover>
                  <TableCell sx={{ fontSize: '0.72rem' }}>
                    {new Date(run.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>{run.groupName}</TableCell>
                  <TableCell sx={{ fontSize: '0.72rem' }}>
                    {run.databaseName} / {run.cloudName}
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.72rem' }}>
                    {run.baseValues.join(' | ')} → {run.newValues.join(' | ')}
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={run.status}
                      size="small"
                      color={STATUS_COLOR[run.status]}
                      sx={{ height: 20, fontSize: '0.65rem' }}
                    />
                  </TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.72rem' }}>
                    +{run.rowsInserted} ~{run.rowsUpdated} -{run.rowsDeleted}
                  </TableCell>
                  <TableCell sx={{ fontSize: '0.72rem' }}>{run.appliedByUsername || '—'}</TableCell>
                </TableRow>
              ))}
              {store.runs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7}>
                    <Typography variant="caption" color="text.secondary">
                      No runs yet.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      )}

      {tab === 0 && <ReplicateActionBar isSecondaryCloud={isSecondaryCloud} />}

      <GroupWizard
        open={wizardOpen}
        group={editingGroup}
        database={store.database}
        cloud={store.cloud}
        databases={databases}
        cloudsFor={cloudsFor}
        onClose={() => {
          setWizardOpen(false);
          setEditingGroup(null);
        }}
      />
    </Box>
  );
};

export default ConfigReplicatePanel;
