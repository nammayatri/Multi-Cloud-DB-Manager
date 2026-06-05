import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Box,
  Paper,
  Typography,
  TextField,
  Button,
  Stack,
  Chip,
  Alert,
  LinearProgress,
  Divider,
  FormControlLabel,
  Checkbox,
  Select,
  MenuItem,
  InputLabel,
  FormControl,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  Tooltip,
  IconButton,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import VisibilityIcon from '@mui/icons-material/Visibility';
import DownloadIcon from '@mui/icons-material/Download';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { csvBatchAPI, schemaAPI, toastNonApiError } from '../../services/api';
import { useAppStore } from '../../store/appStore';
import toast from 'react-hot-toast';

// ── CSV parsing (no external dependency) ────────────────────────────────────

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseRow = (line: string): string[] => {
    const result: string[] = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(field);
        field = '';
      } else {
        field += ch;
      }
    }
    result.push(field);
    return result;
  };

  const headers = parseRow(lines[0]).map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const vals = parseRow(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (vals[i] ?? '').trim();
    });
    return row;
  });

  return { headers, rows };
}

// ── Types ────────────────────────────────────────────────────────────────────

interface BatchResult {
  batchIndex: number;
  idsCount: number;
  rowsAffected: number;
  success: boolean;
  error?: string;
  durationMs: number;
}

interface CsvBatchSummary {
  totalIds: number;
  uniqueIds: number;
  totalBatches: number;
  completedBatches: number;
  failedBatches: number;
  totalRowsAffected: number;
  dryRun: boolean;
  dryRunQueries?: string[];
  batchResults?: BatchResult[];
  failedIds?: string[];
  failedIdsTruncated?: boolean;
}

// ── Component ────────────────────────────────────────────────────────────────

const CsvBatchPanel = () => {
  const selectedDatabase = useAppStore(s => s.selectedDatabase);
  const selectedPgSchema = useAppStore(s => s.selectedPgSchema);
  const [primaryCloud, setPrimaryCloud] = useState<string>('primary');

  useEffect(() => {
    schemaAPI.getConfiguration().then(config => {
      setPrimaryCloud(config.primary.cloudName);
    }).catch(() => {});
  }, []);

  const [queryTemplate, setQueryTemplate] = useState('');
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<Record<string, string>[]>([]);
  const [selectedColumn, setSelectedColumn] = useState('');
  const [batchSize, setBatchSize] = useState(1000);
  const [sleepMs, setSleepMs] = useState(100);
  const [dryRun, setDryRun] = useState(false);
  const [stopOnError, setStopOnError] = useState(true);

  const [executionId, setExecutionId] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'running' | 'completed' | 'failed' | 'cancelled'>('idle');
  const [progress, setProgress] = useState<{ current: number; total: number }>({ current: 0, total: 0 });
  const [summary, setSummary] = useState<CsvBatchSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Stop polling on unmount
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

  const startPolling = useCallback((execId: string) => {
    pollRef.current = setInterval(async () => {
      try {
        const data = await csvBatchAPI.getStatus(execId);
        const prog = data.progress;
        if (prog) {
          setProgress({ current: prog.currentStatement, total: prog.totalStatements });
        }
        if (data.result?.csvBatch) {
          setSummary(data.result.csvBatch as CsvBatchSummary);
        }
        if (data.status !== 'running') {
          stopPolling();
          setStatus(data.status as any);
          if (data.status === 'completed') {
            toast.success('CSV batch execution completed');
          } else if (data.status === 'failed') {
            setError(data.error || 'Batch execution failed');
            toast.error('CSV batch execution failed');
          } else if (data.status === 'cancelled') {
            toast('CSV batch cancelled', { icon: '⚠️' });
          }
        }
      } catch (err) {
        // Ignore transient poll errors
      }
    }, 1000);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvFile(file);
    setSelectedColumn('');
    setCsvHeaders([]);
    setCsvRows([]);

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      const { headers, rows } = parseCsv(text);
      setCsvHeaders(headers);
      setCsvRows(rows);
      if (headers.length > 0) setSelectedColumn(headers[0]);
    };
    reader.readAsText(file);
  };

  const extractIds = (): string[] => {
    if (!selectedColumn || csvRows.length === 0) return [];
    return csvRows.map(r => r[selectedColumn] ?? '').filter(v => v !== '');
  };

  const handleExecute = async (isDryRun: boolean) => {
    if (!queryTemplate.trim()) {
      toast.error('Query template is required');
      return;
    }
    if (!queryTemplate.includes('{id}')) {
      toast.error('Query template must contain {id} placeholder');
      return;
    }
    const ids = extractIds();
    if (ids.length === 0) {
      toast.error('No IDs found in selected column');
      return;
    }

    setError(null);
    setSummary(null);
    setProgress({ current: 0, total: 0 });
    setStatus('running');

    try {
      const response = await csvBatchAPI.start({
        queryTemplate,
        ids,
        database: selectedDatabase,
        pgSchema: selectedPgSchema,
        batchSize,
        sleepMs,
        dryRun: isDryRun,
        stopOnError,
      });

      setExecutionId(response.executionId);
      setProgress({ current: 0, total: response.totalBatches });

      if (isDryRun) {
        // Dry run completes immediately — fetch final result once
        const finalData = await csvBatchAPI.getStatus(response.executionId);
        if (finalData.result?.csvBatch) {
          setSummary(finalData.result.csvBatch as CsvBatchSummary);
        }
        setStatus('completed');
      } else {
        startPolling(response.executionId);
      }
    } catch (err: any) {
      setStatus('failed');
      setError(err?.response?.data?.error || err?.message || 'Failed to start batch');
    }
  };

  const handleCancel = async () => {
    if (!executionId) return;
    try {
      await csvBatchAPI.cancel(executionId);
      stopPolling();
      setStatus('cancelled');
    } catch (err) {
      toastNonApiError(err, 'Failed to cancel');
    }
  };

  const isRunning = status === 'running';
  const progressPct = progress.total > 0 ? (progress.current / progress.total) * 100 : 0;

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>
        Batch Query
      </Typography>
      <Typography variant="body2" color="text.secondary" mb={2}>
        Write a query template with <code>{'{id}'}</code> placeholder, upload a CSV, select the ID column, and run against <strong>{selectedDatabase}</strong> on <strong>{primaryCloud}</strong> (primary cloud only).
      </Typography>

      <Stack spacing={2}>
        {/* Query Template */}
        <TextField
          label="Query Template"
          multiline
          minRows={4}
          fullWidth
          value={queryTemplate}
          onChange={e => setQueryTemplate(e.target.value)}
          placeholder={`UPDATE atlas_driver_offer_bpp.coin_history\nSET expiration_at = NULL\nWHERE created_at >= '2025-10-08'\n  AND driver_id IN {id};`}
          InputProps={{ sx: { fontFamily: 'monospace', fontSize: 13 } }}
          disabled={isRunning}
        />

        {/* CSV Upload */}
        <Box>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          <Stack direction="row" spacing={1} alignItems="center">
            <Button
              variant="outlined"
              startIcon={<UploadFileIcon />}
              onClick={() => fileInputRef.current?.click()}
              disabled={isRunning}
              size="small"
            >
              Upload CSV
            </Button>
            {csvFile && (
              <Chip
                label={`${csvFile.name} — ${csvRows.length.toLocaleString()} rows`}
                size="small"
                color="success"
                variant="outlined"
              />
            )}
          </Stack>
        </Box>

        {/* Column selector */}
        {csvHeaders.length > 0 && (
          <FormControl size="small" sx={{ minWidth: 220 }}>
            <InputLabel>ID Column</InputLabel>
            <Select
              value={selectedColumn}
              label="ID Column"
              onChange={e => setSelectedColumn(e.target.value)}
              disabled={isRunning}
            >
              {csvHeaders.map(h => (
                <MenuItem key={h} value={h}>
                  {h}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}

        {/* Settings row */}
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
          <TextField
            label="Batch Size"
            type="number"
            size="small"
            value={batchSize}
            onChange={e => setBatchSize(Math.max(1, Math.min(10000, parseInt(e.target.value) || 1000)))}
            inputProps={{ min: 1, max: 10000 }}
            sx={{ width: 130 }}
            disabled={isRunning}
          />
          <TextField
            label="Sleep (ms)"
            type="number"
            size="small"
            value={sleepMs}
            onChange={e => setSleepMs(Math.max(0, parseInt(e.target.value) || 0))}
            inputProps={{ min: 0, max: 60000 }}
            sx={{ width: 120 }}
            disabled={isRunning}
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={dryRun}
                onChange={e => setDryRun(e.target.checked)}
                size="small"
                disabled={isRunning}
              />
            }
            label="Dry Run"
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={stopOnError}
                onChange={e => setStopOnError(e.target.checked)}
                size="small"
                disabled={isRunning}
              />
            }
            label="Stop on Error"
          />
        </Stack>

        {/* Action buttons */}
        <Stack direction="row" spacing={1}>
          <Button
            variant="outlined"
            startIcon={<VisibilityIcon />}
            onClick={() => handleExecute(true)}
            disabled={isRunning || csvRows.length === 0 || !queryTemplate.trim()}
            size="small"
          >
            Dry Run
          </Button>
          <Button
            variant="contained"
            startIcon={<PlayArrowIcon />}
            onClick={() => handleExecute(false)}
            disabled={isRunning || csvRows.length === 0 || !queryTemplate.trim()}
            size="small"
          >
            Execute
          </Button>
          {isRunning && (
            <Button
              variant="outlined"
              color="error"
              startIcon={<StopIcon />}
              onClick={handleCancel}
              size="small"
            >
              Cancel
            </Button>
          )}
        </Stack>

        {/* Progress */}
        {(isRunning || status !== 'idle') && progress.total > 0 && (
          <Box>
            <Stack direction="row" justifyContent="space-between" mb={0.5}>
              <Typography variant="caption" color="text.secondary">
                Batch {progress.current} / {progress.total}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {progressPct.toFixed(0)}%
              </Typography>
            </Stack>
            <LinearProgress
              variant="determinate"
              value={progressPct}
              color={status === 'failed' ? 'error' : status === 'cancelled' ? 'warning' : 'primary'}
            />
          </Box>
        )}

        {error && <Alert severity="error">{error}</Alert>}

        {/* Results */}
        {summary && <BatchSummaryView summary={summary} />}
      </Stack>
    </Paper>
  );
};

// ── Summary sub-component ────────────────────────────────────────────────────

const downloadCsv = (ids: string[], filename: string) => {
  const content = 'id\n' + ids.join('\n');
  const blob = new Blob([content], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

const BatchSummaryView = ({ summary }: { summary: CsvBatchSummary }) => {
  return (
    <Box>
      <Divider sx={{ my: 1 }} />
      <Typography variant="subtitle2" gutterBottom>
        {summary.dryRun ? 'Dry Run Preview' : 'Execution Summary'}
      </Typography>

      <Stack direction="row" spacing={1} flexWrap="wrap" mb={1}>
        <Chip label={`${summary.uniqueIds.toLocaleString()} unique IDs`} size="small" />
        <Chip label={`${summary.totalBatches} batches`} size="small" />
        {!summary.dryRun && (
          <>
            <Chip
              label={`${summary.completedBatches} completed`}
              size="small"
              color="success"
              icon={<CheckCircleOutlineIcon />}
            />
            {summary.failedBatches > 0 && (
              <Chip
                label={`${summary.failedBatches} failed`}
                size="small"
                color="error"
                icon={<ErrorOutlineIcon />}
              />
            )}
            <Chip
              label={`${summary.totalRowsAffected.toLocaleString()} rows affected`}
              size="small"
              color="primary"
              variant="outlined"
            />
          </>
        )}
      </Stack>

      {/* Failed IDs download */}
      {!summary.dryRun && summary.failedIds && summary.failedIds.length > 0 && (
        <Box>
          {summary.failedIdsTruncated && (
            <Alert severity="warning" sx={{ mb: 1 }}>
              Failed IDs exceeded 50,000 — only the first 50,000 are available for download.
            </Alert>
          )}
          <Button
            variant="outlined"
            color="error"
            size="small"
            startIcon={<DownloadIcon />}
            onClick={() => downloadCsv(summary.failedIds!, `failed_ids_${Date.now()}.csv`)}
          >
            Download Failed IDs ({summary.failedIds.length.toLocaleString()})
          </Button>
        </Box>
      )}

      {/* Dry run query preview */}
      {summary.dryRun && summary.dryRunQueries && summary.dryRunQueries.length > 0 && (
        <Accordion disableGutters>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="body2">
              Preview (first {summary.dryRunQueries.length} batch{summary.dryRunQueries.length > 1 ? 'es' : ''})
            </Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Stack spacing={1}>
              {summary.dryRunQueries.map((q, i) => (
                <Box key={i}>
                  <Typography variant="caption" color="text.secondary">
                    Batch {i + 1}
                  </Typography>
                  <Box
                    component="pre"
                    sx={{
                      fontFamily: 'monospace',
                      fontSize: 12,
                      bgcolor: 'grey.900',
                      color: 'grey.100',
                      p: 1.5,
                      borderRadius: 1,
                      overflowX: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      m: 0,
                    }}
                  >
                    {q}
                  </Box>
                </Box>
              ))}
            </Stack>
          </AccordionDetails>
        </Accordion>
      )}

      {/* Batch results table */}
      {!summary.dryRun && summary.batchResults && summary.batchResults.length > 0 && (
        <Accordion disableGutters>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="body2">
              Batch Results (last {summary.batchResults.length})
            </Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ p: 0 }}>
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Batch #</TableCell>
                    <TableCell>IDs</TableCell>
                    <TableCell>Rows Affected</TableCell>
                    <TableCell>Duration</TableCell>
                    <TableCell>Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {summary.batchResults.map(r => (
                    <TableRow key={r.batchIndex} hover>
                      <TableCell>{r.batchIndex + 1}</TableCell>
                      <TableCell>{r.idsCount}</TableCell>
                      <TableCell>{r.rowsAffected}</TableCell>
                      <TableCell>{r.durationMs}ms</TableCell>
                      <TableCell>
                        {r.success ? (
                          <Chip label="OK" size="small" color="success" />
                        ) : (
                          <Tooltip title={r.error || 'Unknown error'}>
                            <Chip label="Error" size="small" color="error" />
                          </Tooltip>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          </AccordionDetails>
        </Accordion>
      )}
    </Box>
  );
};

export default CsvBatchPanel;
