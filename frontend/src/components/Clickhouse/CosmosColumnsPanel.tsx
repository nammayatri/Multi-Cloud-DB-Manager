import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Autocomplete, Box, Button, Checkbox, Chip, Divider, FormControl, InputLabel, MenuItem, Paper, Select, Stack, TextField, Typography } from '@mui/material';
import toast from 'react-hot-toast';
import EnableColumns from './cosmos/EnableColumns';
import BatchTable from './cosmos/BatchTable';
import BatchPreview from './cosmos/BatchPreview';
import ApplyProgress, { type ApplyRun } from './cosmos/ApplyProgress';
import { cosmosColumnsAPI } from '../../services/cosmosColumnsApi';
import { toastNonApiError } from '../../services/api';
import type {
  BatchCheck, BatchPreview as Preview, CartItem, CosmosColumnsResponse, CosmosSourcesResponse, EnabledColumn,
} from '../../types/cosmosColumns';

const MAX_BATCH = 30;

/**
 * Cosmos Columns: add columns to cosmos.txn_historic + txn_live from the tables the txn ETL
 * already reads. Pick columns into a batch across tables, set each column's shape, then
 * Apply (checks → ALTER the selected tables → LIVE config rows).
 */
const CosmosColumnsPanel = () => {
  const [sources, setSources] = useState<CosmosSourcesResponse | null>(null);
  const [selected, setSelected] = useState('BPP_RIDE');
  const [columns, setColumns] = useState<CosmosColumnsResponse | null>(null);
  const [loadingColumns, setLoadingColumns] = useState(false);
  const [columnsFailed, setColumnsFailed] = useState(false);
  // Only the newest load for the currently selected table may touch the state above.
  const latestLoad = useRef(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [cart, setCart] = useState<CartItem[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [check, setCheck] = useState<BatchCheck | null>(null);
  const [run, setRun] = useState<ApplyRun | null>(null);
  const [applied, setApplied] = useState<{ batchId: string; preview: Preview } | null>(null);
  const [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState<string[]>([]);

  const loadSources = useCallback(async () => {
    try {
      const s = await cosmosColumnsAPI.sources();
      setSources(s);
      setTargets(prev => (prev.length ? prev : [s.target.table, s.target.liveTable]));
    } catch (e) { toastNonApiError(e, 'Failed to load source tables'); }
  }, []);
  const loadColumns = useCallback(async (etlConfigName: string) => {
    if (etlConfigName !== selectedRef.current) return;
    const load = ++latestLoad.current;
    setLoadingColumns(true);
    setColumnsFailed(false);
    try {
      const fresh = await cosmosColumnsAPI.columns(etlConfigName);
      if (load === latestLoad.current) setColumns(fresh);
    } catch (e) {
      if (load !== latestLoad.current) return;
      setColumnsFailed(true);
      toastNonApiError(e, 'Failed to load columns');
    } finally {
      if (load === latestLoad.current) setLoadingColumns(false);
    }
  }, []);

  useEffect(() => { loadSources(); }, [loadSources]);
  // A table change drops the old table's columns right away, so they can never show under the new table.
  useEffect(() => { setColumns(null); loadColumns(selected); }, [loadColumns, selected]);

  // Every column in the batch goes to the selected target tables.
  const batch = useMemo(() => cart.map(i => ({ ...i, targetTables: targets })), [cart, targets]);
  // Selecting txn_historic brings txn_live along; txn_live can still be dropped on its own. At least one stays selected.
  const changeTargets = (next: string[]) => {
    if (!sources) return;
    const { table, liveTable } = sources.target;
    const picked = next.includes(table) && !targets.includes(table) && !next.includes(liveTable) ? [...next, liveTable] : next;
    if (picked.length) setTargets([table, liveTable].filter(t => picked.includes(t)));
  };

  // Picking a new column replaces the last applied batch's SQL with the new batch's.
  useEffect(() => { if (cart.length > 0) setApplied(null); }, [cart.length]);

  // Re-run preview + checks a moment after the batch changes.
  useEffect(() => {
    if (batch.length === 0) { setPreview(null); setCheck(null); return; }
    const timer = setTimeout(async () => {
      const [p, c] = await Promise.allSettled([cosmosColumnsAPI.preview(batch), cosmosColumnsAPI.check(batch)]);
      setPreview(p.status === 'fulfilled' ? p.value : null);
      setCheck(c.status === 'fulfilled' ? c.value : null);
    }, 500);
    return () => clearTimeout(timer);
  }, [batch]);

  const current = sources?.sources.find(s => s.etlConfigName === selected);
  const sourceDbs = useMemo(() => [...new Set((sources?.sources ?? []).map(s => s.db))], [sources]);
  // Target columns = the enabled columns of the selected source that are in the batch.
  const picked = useMemo(() => {
    const names = new Set(cart.filter(i => i.etlConfigName === selected).map(i => i.sourceColumn));
    return (columns?.enabled ?? []).filter(c => names.has(c.name));
  }, [cart, columns, selected]);
  const changePicked = (next: EnabledColumn[]) => {
    const keep = new Set(next.map(c => c.name));
    setCart(prev => prev.filter(i => i.etlConfigName !== selected || keep.has(i.sourceColumn)));
    next.filter(c => !picked.some(p => p.name === c.name)).forEach(addColumn);
  };

  const addColumn = (c: EnabledColumn) => {
    if (!current) return;
    const first = c.transforms.find(t => t.transform === 'RAW') ?? c.transforms[0];
    setCart(prev => [...prev, {
      etlConfigName: current.etlConfigName, sourceColumn: c.name, sourceColumnType: c.type, sourceLabel: `${current.db}.${current.table}.${c.name}`,
      options: c.transforms, transformType: first.transform, targetColumnName: first.suggestedName, targetColumnType: first.targetTypes[0],
    }]);
  };

  // Enable / disable a column; with `add`, the freshly enabled column also goes into the batch.
  const setEnabled = async (column: string, enabled: boolean, add = false) => {
    try {
      await cosmosColumnsAPI.setEnabled(selected, column, enabled);
      const [fresh] = await Promise.all([cosmosColumnsAPI.columns(selected), loadSources()]);
      if (selected === selectedRef.current) setColumns(fresh);
      const c = add ? fresh.enabled.find(x => x.name === column) : undefined;
      if (c) addColumn(c);
    } catch (e) { toastNonApiError(e, 'Failed to change the column list'); }
  };

  // Apply = checks → ALTER the selected tables → LIVE config rows. On failure the batch stays so it can be fixed and applied again.
  const applyCart = async () => {
    setBusy(true);
    const columns = batch.map(i => ({ name: i.targetColumnName, source: i.sourceLabel, tables: i.targetTables ?? [] }));
    const shown = preview;
    // Not crypto.randomUUID(): it only exists on https / localhost pages.
    const applyId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    setRun({ columns, result: null, progress: null });
    // Ask the server where Apply is until it answers; a failed poll just leaves the bar as it was.
    const poll = setInterval(async () => {
      try {
        const progress = await cosmosColumnsAPI.applyProgress(applyId);
        setRun(prev => (prev && !prev.result && !prev.error ? { ...prev, progress } : prev));
      } catch { /* not started yet, or finished */ }
    }, 400);
    try {
      const r = await cosmosColumnsAPI.saveAndApply(batch, applyId);
      setRun({ columns, result: r });
      if (r.applied) {
        if (shown) setApplied({ batchId: r.batchId, preview: { ...shown, configRows: shown.configRows.split('<batch_id>').join(`'${r.batchId}'`) } });
        toast.success(`${batch.length} column${batch.length === 1 ? '' : 's'} added`);
        setCart([]);
      } else {
        const failed = r.steps.find(s => !s.ok);
        toast.error(`Apply failed at "${failed?.label ?? 'unknown step'}": ${failed?.error ?? 'see the steps below'}`, { duration: 10000 });
      }
      await Promise.all([loadSources(), loadColumns(selected)]);
    } catch (e: any) {
      toastNonApiError(e, 'Apply failed');
      setRun({ columns, result: null, error: e?.response?.data?.error ?? e?.message ?? 'Apply failed' });
    } finally {
      clearInterval(poll);
      setBusy(false);
    }
  };
  const tableReady = sources?.configTableReady !== false;
  const itemErrors = cart.map((_, i) => check?.items[i] ?? []);

  return (
    <Box sx={{ p: 2 }}>
      <Stack spacing={2}>
        {!tableReady && (
          <Alert severity="warning">
            The config table cosmos.etl_column_config does not exist yet. You can browse columns, but enabling, saving and applying need it.
            Create it with control-center etl/ddl/etl_column_config.sql.
          </Alert>
        )}
        {columnsFailed && (
          <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => loadColumns(selected)}>Retry</Button>}>
            Could not load the columns of {current ? `${current.db}.${current.table}` : selected}.
          </Alert>
        )}
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }}>
            <FormControl size="small" sx={{ minWidth: 220 }}>
              <InputLabel id="cosmos-source-db-label">Source DB</InputLabel>
              <Select
                labelId="cosmos-source-db-label" label="Source DB" value={current?.db ?? ''} sx={{ fontFamily: 'monospace', fontSize: 13 }}
                onChange={e => { const first = sources?.sources.find(s => s.db === e.target.value); if (first) setSelected(first.etlConfigName); }}
              >
                {sourceDbs.map(db => <MenuItem key={db} value={db} sx={{ fontFamily: 'monospace', fontSize: 13 }}>{db}</MenuItem>)}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 240 }}>
              <InputLabel id="cosmos-source-label">Source table</InputLabel>
              <Select labelId="cosmos-source-label" label="Source table" value={current ? selected : ''} sx={{ fontFamily: 'monospace', fontSize: 13 }} onChange={e => setSelected(e.target.value)}>
                {sources?.sources.filter(s => s.db === current?.db).map(s => (
                  <MenuItem key={s.etlConfigName} value={s.etlConfigName} sx={{ fontFamily: 'monospace', fontSize: 13 }}>{s.table}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 240 }}>
              <InputLabel id="cosmos-target-label">Target tables</InputLabel>
              <Select
                multiple labelId="cosmos-target-label" label="Target tables"
                value={targets}
                onChange={e => changeTargets(typeof e.target.value === 'string' ? e.target.value.split(',') : e.target.value)}
                renderValue={v => <Stack direction="row" spacing={0.5}>{v.map(t => <Chip key={t} size="small" label={t} sx={{ fontFamily: 'monospace' }} />)}</Stack>}
              >
                {sources && [sources.target.table, sources.target.liveTable].map(t => (
                  <MenuItem key={t} value={t} sx={{ fontFamily: 'monospace', fontSize: 13 }}>
                    <Checkbox size="small" checked={targets.includes(t)} sx={{ p: 0, mr: 1 }} />{t}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Autocomplete
              key={selected} /* a table change clears the search text */
              multiple disableCloseOnSelect size="small" sx={{ width: 380 }} limitTags={2}
              ListboxProps={{ style: { maxHeight: 420 } }}
              slotProps={{ popper: { placement: 'bottom-start', style: { width: 'fit-content', minWidth: 380 } } }}
              options={columns?.enabled ?? []} value={picked} loading={loadingColumns}
              getOptionLabel={c => c.name} isOptionEqualToValue={(a, b) => a.name === b.name}
              getOptionDisabled={c => cart.length >= MAX_BATCH && !picked.some(p => p.name === c.name)}
              onChange={(_, v) => changePicked(v)}
              noOptionsText={columns?.enabled.length ? 'No enabled column matches' : 'No columns of this table are enabled yet. Press + to enable some.'}
              renderOption={(props, c, { selected: on }) => (
                <Box component="li" {...props} key={c.name} title={c.type} sx={{ gap: 1.5, py: '8px !important', px: '16px !important' }}>
                  <Checkbox size="small" checked={on} sx={{ p: 0 }} />
                  <Typography sx={{ fontFamily: 'monospace', fontSize: 14, whiteSpace: 'nowrap' }}>{c.name}</Typography>
                </Box>
              )}
              renderTags={(v, getTagProps) => v.map((c, n) => <Chip {...getTagProps({ index: n })} key={c.name} size="small" label={c.name} sx={{ fontFamily: 'monospace' }} />)}
              renderInput={params => <TextField {...params} label={`Target columns (${columns?.enabled.length ?? 0} enabled)`} placeholder={picked.length ? '' : 'Search enabled columns'} />}
            />
            <Box sx={{ ml: { md: 'auto !important' } }}>
              <EnableColumns key={selected} data={columns} batchFull={cart.length >= MAX_BATCH} onSetEnabled={setEnabled} />
            </Box>
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2 }}>
          <BatchTable
              items={cart} itemErrors={itemErrors} batchErrors={check?.batch ?? []} maxItems={MAX_BATCH} busy={busy}
              canSave={tableReady && cart.length > 0 && check?.ok === true}
              onChange={(i, patch) => setCart(prev => prev.map((it, n) => (n === i ? { ...it, ...patch } : it)))}
              onRemove={i => setCart(prev => prev.filter((_, n) => n !== i))}
              onClear={() => setCart([])}
              onApply={applyCart}
            />
          {run && <ApplyProgress run={run} onClose={busy ? undefined : () => setRun(null)} />}
          <Divider sx={{ my: 2 }} />
          <BatchPreview preview={preview} applied={applied} count={cart.length} tables={targets.length} sources={new Set(cart.map(i => i.etlConfigName)).size} />
        </Paper>
      </Stack>
    </Box>
  );
};

export default CosmosColumnsPanel;
