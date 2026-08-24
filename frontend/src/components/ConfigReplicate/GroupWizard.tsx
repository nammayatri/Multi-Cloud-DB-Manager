import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Step,
  StepLabel,
  Stepper,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import toast from 'react-hot-toast';
import configReplicateAPI from '../../services/configReplicateApi';
import { useConfigReplicateStore } from '../../store/configReplicateStore';
import {
  ColumnClass,
  ConfigGroup,
  GroupTableConfig,
  TableMeta,
  tableKeyOf,
} from '../../types/configReplicate';

const COLUMN_CLASSES: ColumnClass[] = [
  'COPIED',
  'MATCH_KEY',
  'GENERATED',
  'TIMESTAMP',
  'DIMENSION',
  'IGNORED',
];

const CLASS_HELP: Record<ColumnClass, string> = {
  DIMENSION: 'The dimension itself — set to the new value on every copied row',
  MATCH_KEY: 'Identifies the same logical row across dimension values',
  GENERATED: 'Regenerated on insert (new UUID, or left to the database default)',
  TIMESTAMP: 'Stamped with NOW() rather than copied',
  COPIED: 'Copied verbatim from the base row, and compared when detecting changes',
  IGNORED: 'Neither copied nor compared',
};

const STEPS = ['Basics', 'Tables', 'Columns'];

interface Props {
  open: boolean;
  group: ConfigGroup | null;
  database: string;
  cloud: string;
  databases: string[];
  cloudsFor: (database: string) => Array<{ name: string; role: 'primary' | 'secondary' }>;
  onClose: () => void;
}

const GroupWizard = ({
  open,
  group,
  database: initialDatabase,
  cloud: initialCloud,
  databases,
  cloudsFor,
  onClose,
}: Props) => {
  const saveGroup = useConfigReplicateStore(s => s.saveGroup);

  // The wizard introspects a live database, so it owns that choice rather than
  // inheriting it from the Replicate tab — which is not where you are when you
  // open it, and would leave the table list mysteriously empty.
  const [database, setDatabase] = useState(initialDatabase);
  const [cloud, setCloud] = useState(initialCloud);

  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [dimensionColumns, setDimensionColumns] = useState<string[]>(['']);

  const [candidates, setCandidates] = useState<
    Array<{ schema: string; table: string; dimensionColumns: string[] }>
  >([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [tables, setTables] = useState<GroupTableConfig[]>([]);

  const [metaByTable, setMetaByTable] = useState<Record<string, TableMeta>>({});
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [activeTableKey, setActiveTableKey] = useState<string>('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setName(group?.name || '');
    setDescription(group?.description || '');
    setDimensionColumns(group?.dimensionColumns?.length ? [...group.dimensionColumns] : ['']);
    const db = initialDatabase || (databases.length === 1 ? databases[0] : '');
    const options = cloudsFor(db);
    setDatabase(db);
    setCloud(initialCloud || (options.length === 1 ? options[0].name : ''));
    setListError(null);
    setTables(group?.tables ? group.tables.map(t => ({ ...t })) : []);
    setCandidates([]);
    setMetaByTable({});
    setActiveTableKey('');
  }, [open, group, initialDatabase, initialCloud, databases, cloudsFor]);

  const cleanDimensions = useMemo(
    () => dimensionColumns.map(d => d.trim()).filter(Boolean),
    [dimensionColumns]
  );

  const loadCandidates = async (db = database, cl = cloud) => {
    if (!db || !cl) {
      setCandidates([]);
      setListError('Pick a database and cloud to list its tables.');
      return;
    }
    if (cleanDimensions.length === 0) {
      setListError('Enter at least one dimension column first.');
      return;
    }

    setLoadingTables(true);
    setListError(null);
    try {
      const found = await configReplicateAPI.listTables({
        database: db,
        cloud: cl,
        dimensionColumns: cleanDimensions,
      });
      setCandidates(found);
      if (found.length === 0) {
        setListError(
          cleanDimensions.length > 1
            ? `No table in ${db} carries all of ${cleanDimensions.join(', ')}. ` +
              'A table missing any one of them cannot be sliced by this dimension.'
            : `No table in ${db} has a column named ${cleanDimensions[0]}.`
        );
      }
    } catch {
      setListError(`Could not read the table list from ${db} on ${cl}.`);
    } finally {
      setLoadingTables(false);
    }
  };

  const toggleTable = (candidate: { schema: string; table: string; dimensionColumns: string[] }) => {
    const key = tableKeyOf(candidate);
    setTables(prev => {
      const existing = prev.findIndex(t => tableKeyOf(t) === key);
      if (existing >= 0) return prev.filter((_, i) => i !== existing);
      return [
        ...prev,
        {
          schema: candidate.schema,
          table: candidate.table,
          dimensionColumns: [...candidate.dimensionColumns],
          position: prev.length,
          matchStrategy: 'AUTO',
          matchKeyColumns: [],
          columnConfig: {},
          fkRemap: {},
        },
      ];
    });
  };

  const move = (index: number, delta: number) => {
    setTables(prev => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((t, i) => ({ ...t, position: i }));
    });
  };

  const loadMeta = async () => {
    if (tables.length === 0) return;
    setLoadingMeta(true);
    try {
      const entries = await Promise.all(
        tables.map(async table => {
          const meta = await configReplicateAPI.getTableMeta({
            database,
            cloud,
            schema: table.schema,
            table: table.table,
            dimensionColumns: table.dimensionColumns,
          });
          return [tableKeyOf(table), meta] as const;
        })
      );
      setMetaByTable(Object.fromEntries(entries));
      setActiveTableKey(tableKeyOf(tables[0]));
    } catch {
      toast.error('Failed to introspect one or more tables');
    } finally {
      setLoadingMeta(false);
    }
  };

  const updateTable = (key: string, patch: Partial<GroupTableConfig>) => {
    setTables(prev => prev.map(t => (tableKeyOf(t) === key ? { ...t, ...patch } : t)));
  };

  const handleNext = async () => {
    if (step === 0) {
      if (!name.trim() || cleanDimensions.length === 0) {
        toast.error('A name and at least one dimension column are required');
        return;
      }
      if (new Set(cleanDimensions).size !== cleanDimensions.length) {
        toast.error('Dimension columns must be distinct');
        return;
      }
      setStep(1);
      void loadCandidates();
      return;
    }
    if (step === 1) {
      if (tables.length === 0) {
        toast.error('Select at least one table');
        return;
      }
      setStep(2);
      void loadMeta();
    }
  };

  const handleSave = async () => {
    setSaving(true);
    const saved = await saveGroup(
      {
        name: name.trim(),
        description: description.trim() || undefined,
        dimensionColumns: cleanDimensions,
        tables: tables.map((t, i) => ({ ...t, position: i })),
      },
      group?.id
    );
    setSaving(false);
    if (saved) onClose();
  };

  const activeTable = tables.find(t => tableKeyOf(t) === activeTableKey);
  const activeMeta = metaByTable[activeTableKey];

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>{group ? `Edit "${group.name}"` : 'New config group'}</DialogTitle>
      <DialogContent>
        <Stepper activeStep={step} sx={{ mb: 3 }}>
          {STEPS.map(label => (
            <Step key={label}>
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>

        {step === 0 && (
          <Stack spacing={2}>
            <TextField
              label="Group name"
              size="small"
              value={name}
              onChange={e => setName(e.target.value)}
              fullWidth
              autoFocus
            />
            <TextField
              label="Description"
              size="small"
              value={description}
              onChange={e => setDescription(e.target.value)}
              fullWidth
              multiline
              rows={2}
            />
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                Dimension columns
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
                The columns whose values are being replicated. Use more than one when a
                configuration is scoped by a combination — a merchant <em>and</em> a city, say.
                Only tables carrying all of them can join the group.
              </Typography>

              <Stack spacing={1}>
                {dimensionColumns.map((dimension, index) => (
                  <Stack key={index} direction="row" spacing={1} alignItems="center">
                    <TextField
                      size="small"
                      fullWidth
                      value={dimension}
                      placeholder={index === 0 ? 'merchant_operating_city_id' : 'merchant_id'}
                      onChange={e =>
                        setDimensionColumns(prev =>
                          prev.map((d, i) => (i === index ? e.target.value : d))
                        )
                      }
                    />
                    <IconButton
                      size="small"
                      disabled={dimensionColumns.length === 1}
                      onClick={() =>
                        setDimensionColumns(prev => prev.filter((_, i) => i !== index))
                      }
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                ))}
              </Stack>

              <Button
                size="small"
                startIcon={<AddIcon />}
                sx={{ mt: 1 }}
                onClick={() => setDimensionColumns(prev => [...prev, ''])}
              >
                Add dimension column
              </Button>
            </Box>
          </Stack>
        )}

        {step === 1 && (
          <Box>
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
              <FormControl size="small" sx={{ minWidth: 150 }}>
                <InputLabel>Database</InputLabel>
                <Select
                  label="Database"
                  value={database}
                  onChange={e => {
                    const next = e.target.value;
                    const only = cloudsFor(next);
                    const nextCloud = only.length === 1 ? only[0].name : '';
                    setDatabase(next);
                    setCloud(nextCloud);
                    setCandidates([]);
                    void loadCandidates(next, nextCloud);
                  }}
                >
                  {databases.map(db => (
                    <MenuItem key={db} value={db}>
                      {db}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <FormControl size="small" sx={{ minWidth: 150 }} disabled={!database}>
                <InputLabel>Cloud</InputLabel>
                <Select
                  label="Cloud"
                  value={cloud}
                  onChange={e => {
                    setCloud(e.target.value);
                    void loadCandidates(database, e.target.value);
                  }}
                >
                  {cloudsFor(database).map(c => (
                    <MenuItem key={c.name} value={c.name}>
                      {c.name} ({c.role})
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <Typography variant="caption" color="text.secondary">
                carrying {cleanDimensions.join(' + ')}
              </Typography>

              <Box sx={{ flexGrow: 1 }} />
              <Button size="small" onClick={() => loadCandidates()} disabled={loadingTables}>
                Refresh
              </Button>
            </Stack>

            {listError && (
              <Alert severity="info" sx={{ mb: 1.5 }}>
                {listError}
              </Alert>
            )}

            {loadingTables ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
                <CircularProgress size={24} />
              </Box>
            ) : (
              <Stack direction="row" spacing={2}>
                <Paper variant="outlined" sx={{ flex: 1, maxHeight: 360, overflowY: 'auto', p: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    Available ({candidates.length})
                  </Typography>
                  {candidates.map(candidate => {
                    const key = tableKeyOf(candidate);
                    const selected = tables.some(t => tableKeyOf(t) === key);
                    return (
                      <Box key={key} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <Checkbox
                          size="small"
                          checked={selected}
                          onChange={() => toggleTable(candidate)}
                          sx={{ p: 0.25 }}
                        />
                        <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                          {key}
                        </Typography>
                        <Chip
                          label={candidate.dimensionColumns.join(' + ')}
                          size="small"
                          variant="outlined"
                          sx={{ height: 18, fontSize: '0.6rem', ml: 'auto' }}
                        />
                      </Box>
                    );
                  })}
                  {candidates.length === 0 && !listError && (
                    <Typography variant="caption" color="text.secondary">
                      Nothing to show yet.
                    </Typography>
                  )}
                </Paper>

                <Paper variant="outlined" sx={{ flex: 1, maxHeight: 360, overflowY: 'auto', p: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    In this group, in apply order ({tables.length})
                  </Typography>
                  <Alert severity="info" sx={{ my: 1, fontSize: '0.72rem', py: 0 }}>
                    Order parents before children. Inserts run top-down, deletes bottom-up.
                  </Alert>
                  {tables.map((table, index) => (
                    <Box key={tableKeyOf(table)} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <Typography variant="caption" sx={{ width: 20 }}>
                        {index + 1}.
                      </Typography>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.75rem', flex: 1 }}>
                        {tableKeyOf(table)}
                      </Typography>
                      <IconButton size="small" onClick={() => move(index, -1)} disabled={index === 0}>
                        <ArrowUpwardIcon sx={{ fontSize: 14 }} />
                      </IconButton>
                      <IconButton
                        size="small"
                        onClick={() => move(index, 1)}
                        disabled={index === tables.length - 1}
                      >
                        <ArrowDownwardIcon sx={{ fontSize: 14 }} />
                      </IconButton>
                    </Box>
                  ))}
                </Paper>
              </Stack>
            )}
          </Box>
        )}

        {step === 2 && (
          <Box>
            {loadingMeta ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
                <CircularProgress size={24} />
              </Box>
            ) : (
              <Stack direction="row" spacing={2}>
                <Paper variant="outlined" sx={{ width: 240, maxHeight: 420, overflowY: 'auto', p: 1 }}>
                  {tables.map(table => {
                    const key = tableKeyOf(table);
                    return (
                      <Box
                        key={key}
                        onClick={() => setActiveTableKey(key)}
                        sx={{
                          px: 1,
                          py: 0.5,
                          cursor: 'pointer',
                          borderRadius: 1,
                          bgcolor: key === activeTableKey ? 'action.selected' : undefined,
                        }}
                      >
                        <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.72rem' }}>
                          {key}
                        </Typography>
                      </Box>
                    );
                  })}
                </Paper>

                <Paper variant="outlined" sx={{ flex: 1, maxHeight: 420, overflowY: 'auto', p: 1.5 }}>
                  {!activeTable || !activeMeta ? (
                    <Typography variant="caption" color="text.secondary">
                      Select a table.
                    </Typography>
                  ) : (
                    <Stack spacing={1.5}>
                      {activeMeta.missingDimensionColumns.length > 0 && (
                        <Alert severity="error">
                          Not on this table: {activeMeta.missingDimensionColumns.join(', ')}
                        </Alert>
                      )}

                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          This table&apos;s name for each dimension, in the group&apos;s order
                        </Typography>
                        <Stack direction="row" spacing={1} sx={{ mt: 0.5 }} flexWrap="wrap" useFlexGap>
                          {cleanDimensions.map((groupDimension, index) => (
                            <TextField
                              key={groupDimension}
                              size="small"
                              label={groupDimension}
                              sx={{ width: 220 }}
                              value={activeTable.dimensionColumns[index] ?? ''}
                              onChange={e =>
                                updateTable(activeTableKey, {
                                  dimensionColumns: activeTable.dimensionColumns.map((d, i) =>
                                    i === index ? e.target.value : d
                                  ),
                                })
                              }
                            />
                          ))}
                        </Stack>
                      </Box>

                      <FormControl size="small" fullWidth>
                        <InputLabel>Matching</InputLabel>
                        <Select
                          label="Matching"
                          value={activeTable.matchStrategy}
                          onChange={e =>
                            updateTable(activeTableKey, {
                              matchStrategy: e.target.value as GroupTableConfig['matchStrategy'],
                            })
                          }
                        >
                          <MenuItem value="AUTO">
                            Automatic — unique key if one exists, otherwise similarity
                          </MenuItem>
                          <MenuItem value="UNIQUE_KEY">Unique key only</MenuItem>
                          <MenuItem value="SIMILARITY">Similarity only</MenuItem>
                        </Select>
                      </FormControl>

                      {activeMeta.suggestedMatchKey ? (
                        <Alert severity="success" sx={{ fontSize: '0.75rem', py: 0 }}>
                          Detected key <strong>{activeMeta.suggestedMatchKey.name}</strong> — rows
                          will match on {activeMeta.suggestedMatchKey.columns.join(', ') || '(none)'}
                        </Alert>
                      ) : (
                        <Alert severity="warning" sx={{ fontSize: '0.75rem', py: 0 }}>
                          No unique key contains the dimension column. Rows will be paired by
                          similarity, and only on a strict mutual best match.
                        </Alert>
                      )}

                      <Divider />

                      <Typography variant="caption" color="text.secondary">
                        Column handling — the detected values are shown; change any that are wrong.
                      </Typography>

                      {activeMeta.columns.map(column => {
                        const current =
                          activeTable.columnConfig[column.columnName] ||
                          activeMeta.suggestedClassification[column.columnName] ||
                          'COPIED';
                        const remapTarget = activeTable.fkRemap[column.columnName] || '';

                        return (
                          <Stack
                            key={column.columnName}
                            direction="row"
                            spacing={1}
                            alignItems="center"
                          >
                            <Tooltip title={`${column.dataType}${column.isNullable ? ' (nullable)' : ''}`}>
                              <Typography
                                variant="body2"
                                sx={{ fontFamily: 'monospace', fontSize: '0.72rem', width: 180 }}
                                noWrap
                              >
                                {column.columnName}
                              </Typography>
                            </Tooltip>

                            <FormControl size="small" sx={{ width: 150 }}>
                              <Select
                                value={current}
                                onChange={e =>
                                  updateTable(activeTableKey, {
                                    columnConfig: {
                                      ...activeTable.columnConfig,
                                      [column.columnName]: e.target.value as ColumnClass,
                                    },
                                  })
                                }
                                sx={{ fontSize: '0.72rem' }}
                              >
                                {COLUMN_CLASSES.map(cls => (
                                  <MenuItem key={cls} value={cls} sx={{ fontSize: '0.72rem' }}>
                                    {cls}
                                  </MenuItem>
                                ))}
                              </Select>
                            </FormControl>

                            <FormControl size="small" sx={{ width: 220 }}>
                              <Select
                                displayEmpty
                                value={remapTarget}
                                onChange={e => {
                                  const next = { ...activeTable.fkRemap };
                                  if (e.target.value) next[column.columnName] = e.target.value as string;
                                  else delete next[column.columnName];
                                  updateTable(activeTableKey, { fkRemap: next });
                                }}
                                sx={{ fontSize: '0.72rem' }}
                              >
                                <MenuItem value="" sx={{ fontSize: '0.72rem' }}>
                                  Not a reference
                                </MenuItem>
                                {tables
                                  .filter(t => tableKeyOf(t) !== activeTableKey)
                                  .map(t => (
                                    <MenuItem
                                      key={tableKeyOf(t)}
                                      value={tableKeyOf(t)}
                                      sx={{ fontSize: '0.72rem' }}
                                    >
                                      references {tableKeyOf(t)}
                                    </MenuItem>
                                  ))}
                              </Select>
                            </FormControl>

                            <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }} noWrap>
                              {CLASS_HELP[current]}
                            </Typography>
                          </Stack>
                        );
                      })}
                    </Stack>
                  )}
                </Paper>
              </Stack>
            )}
          </Box>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        {step > 0 && <Button onClick={() => setStep(step - 1)}>Back</Button>}
        {step < 2 ? (
          <Button variant="contained" onClick={handleNext}>
            Next
          </Button>
        ) : (
          <Button variant="contained" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save group'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
};

export default GroupWizard;
