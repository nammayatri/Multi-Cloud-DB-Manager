import { Alert, Box, CircularProgress, LinearProgress, IconButton, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import type { ApplyProgress as Progress, ApplyResult } from '../../../types/cosmosColumns';

/** One Apply: the columns being added and, once it returns, what happened to each. `error` = the request itself was refused. */
export interface ApplyRun {
  columns: Array<{ name: string; source: string; tables: string[] }>;
  result: ApplyResult | null;
  error?: string;
  /** Where the server is while Apply runs; null until the first poll answers. */
  progress?: Progress | null;
}

const mono = { fontFamily: 'monospace', fontSize: 12 } as const;

/** Per-column progress: "Adding…" while Apply runs, then Added or the reason it was not added. */
const ApplyProgress = ({ run, onClose }: { run: ApplyRun; onClose?: () => void }) => {
  const { columns, result, error, progress } = run;
  const pending = !result && !error;
  const failedStep = result?.steps.find(s => !s.ok);
  const addedTo = (name: string) => result?.added?.find(a => a.column === name);
  const columnError = (name: string) => result?.steps.flatMap(s => s.columns ?? []).find(c => c.name === name && !c.ok)?.error;
  const title = pending ? `Adding ${columns.length} column${columns.length === 1 ? '' : 's'}…` : result?.applied ? `Added ${columns.length} column${columns.length === 1 ? '' : 's'}` : 'Nothing was added';

  return (
    <Box sx={{ mt: 2, border: 1, borderColor: pending ? 'divider' : result?.applied ? 'success.main' : 'error.main', borderRadius: 1, p: 1.5 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          {pending && <CircularProgress size={16} />}
          <Typography variant="subtitle2">{title}</Typography>
        </Stack>
        {onClose && <IconButton size="small" aria-label="Close" onClick={onClose}><CloseIcon fontSize="small" /></IconButton>}
      </Stack>
      {pending && (
        <Box sx={{ mb: 1.5 }}>
          <LinearProgress
            variant={progress ? 'determinate' : 'indeterminate'}
            value={progress ? (progress.done / progress.total) * 100 : undefined}
            sx={{ height: 6, borderRadius: 1 }}
          />
          <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.5 }}>
            <Typography variant="caption" color="text.secondary">{progress ? `${progress.label}…` : 'Starting…'}</Typography>
            {progress && <Typography variant="caption" color="text.secondary">Step {Math.min(progress.done + 1, progress.total)} of {progress.total}</Typography>}
          </Stack>
        </Box>
      )}
      <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 1, maxHeight: 320 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell>target column</TableCell>
              <TableCell>db</TableCell>
              <TableCell>table</TableCell>
              <TableCell>source column</TableCell>
              <TableCell>tables</TableCell>
              <TableCell>status</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {columns.map(c => {
              const err = columnError(c.name);
              const [db, table, column] = c.source.split('.');
              return (
                <TableRow key={c.name}>
                  <TableCell sx={mono}>{c.name}</TableCell>
                  <TableCell sx={mono}>{db}</TableCell>
                  <TableCell sx={mono}>{table}</TableCell>
                  <TableCell sx={mono}>{column}</TableCell>
                  <TableCell sx={mono}>{c.tables.join(' + ')}</TableCell>
                  <TableCell sx={{ fontSize: 12 }}>
                    {pending && <Stack direction="row" spacing={1} alignItems="center"><CircularProgress size={12} /><span>Adding…</span></Stack>}
                    {result?.applied && (
                      <Box component="span" sx={{ color: 'success.main', fontWeight: 600 }}>
                        ✓ Added to {(addedTo(c.name)?.tables ?? c.tables).map(t => t.replace(/^cosmos\./, '')).join(' + ')} · LIVE in config
                      </Box>
                    )}
                    {!pending && !result?.applied && <Box component="span" sx={{ color: 'error.main' }}>✗ {err ?? 'Not added'}</Box>}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      {!pending && (
        <Alert severity={result?.applied ? 'success' : 'error'} sx={{ mt: 1 }}>
          {result?.applied
            ? <>
                Added {columns.length} column{columns.length === 1 ? '' : 's'} to{' '}
                <b>{[...new Set(result.added?.flatMap(a => a.tables) ?? columns.flatMap(c => c.tables.map(t => `cosmos.${t}`)))].join(' and ')}</b>,
                and saved {columns.length === 1 ? 'it' : 'them'} as <b>LIVE</b> in <b>{result.added?.[0]?.configTable ?? 'cosmos.etl_column_config'}</b>
                {' '}(batch {result.batchId}). The next ETL run fills {columns.length === 1 ? 'it' : 'them'}.
              </>
            : <>
                {error ?? `${failedStep?.label ?? 'Apply'}: ${failedStep?.error ?? 'failed'}`}
                {result?.undone ? ` ${result.undone}` : ''} Your columns are still above: fix them and press Apply again.
              </>}
        </Alert>
      )}
    </Box>
  );
};

export default ApplyProgress;
