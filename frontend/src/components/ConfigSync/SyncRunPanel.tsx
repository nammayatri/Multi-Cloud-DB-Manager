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
  IconButton,
  Tooltip,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import toast from 'react-hot-toast';
import { configSyncAPI, toastNonApiError } from '../../services/api';
import type { ConfigSyncResult } from '../../services/api';

type JobStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

const AUDIT_TAGS = ['[URL]', '[ENCRYPT]', '[K8S]', '[IP]'] as const;

// Pure "====...====" divider lines from the python script's own output
// formatting — not a real warning, just visual separation in a terminal.
// Drops out entirely rather than being counted/shown as an "Other" item.
const isSeparatorLine = (line: string) => /^=+$/.test(line.trim());

// [URL]/[ENCRYPT]/[K8S]/[IP] lines are aggregate summaries — e.g. a single
// line reading "99 external HTTPS domains still present:" — so the real
// issue count is the number embedded in the text, not the number of raw
// lines (which would misleadingly show "[URL] 2" for 115 actual URLs).
// "Other" lines are one-per-item (one domain per line) with no embedded
// count, so line count IS the real count there.
function extractCount(line: string): number | null {
  const match = line.match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

interface AuditGroup {
  lines: string[];
  count: number;
}

function groupAuditWarnings(rawLines: string[]): Record<string, AuditGroup> {
  const groups: Record<string, string[]> = {};
  for (const line of rawLines) {
    if (isSeparatorLine(line)) continue;
    const tag = AUDIT_TAGS.find(t => line.startsWith(t)) || 'Other';
    (groups[tag] ||= []).push(line);
  }

  const result: Record<string, AuditGroup> = {};
  for (const [tag, lines] of Object.entries(groups)) {
    if (tag === 'Other') {
      result[tag] = { lines, count: lines.length };
      continue;
    }
    const counts = lines.map(extractCount);
    const allParsed = counts.every((c): c is number => c !== null);
    result[tag] = { lines, count: allParsed ? counts.reduce((a, b) => a + b, 0) : lines.length };
  }
  return result;
}

function extractResultLine(log: string[], prefix: string): string | null {
  const line = [...log].reverse().find(l => l.includes(prefix));
  return line ? line.trim() : null;
}

const SyncRunPanel = () => {
  // Nothing about From/To/parallel/schemas/tables is shown to the user —
  // each deployment is locked to exactly one valid transfer pair via
  // CONFIG_SYNC_ALLOWED_ENVS, resolved entirely server-side (not the
  // client's concern at all — see configTransfer.service.ts's
  // resolveDeploymentTransferPair()). The full run always covers every
  // schema/table (no filtering UI), parallel stays at a fixed default.
  const [versionDescription, setVersionDescription] = useState('');

  // ── Job state ──
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatus>('idle');
  const [result, setResult] = useState<ConfigSyncResult | null>(null);
  const [liveLog, setLiveLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };
  const stopStream = () => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  };

  useEffect(() => {
    return () => {
      stopPolling();
      stopStream();
    };
  }, []);

  // Live console output — additive to the 1s status poll, which stays the
  // authority for the running -> completed/failed/cancelled transition and
  // the final full log/result. If the stream drops or is unavailable
  // (job already finished on connect, etc.) nothing regresses — the poll
  // still delivers the full log once the job completes.
  const startStream = useCallback((execId: string) => {
    const es = new EventSource(configSyncAPI.streamUrl(execId), { withCredentials: true });
    eventSourceRef.current = es;
    es.onmessage = (evt) => {
      try {
        setLiveLog(prev => [...prev, JSON.parse(evt.data)]);
      } catch {
        setLiveLog(prev => [...prev, evt.data]);
      }
    };
    es.addEventListener('unavailable', () => stopStream());
    es.addEventListener('done', () => stopStream());
    es.onerror = () => stopStream();
  }, []);

  const startPolling = useCallback((execId: string) => {
    pollRef.current = setInterval(async () => {
      try {
        const data = await configSyncAPI.getStatus(execId);
        if (data.result?.configSync) {
          setResult(data.result.configSync);
        }
        if (data.status !== 'running') {
          stopPolling();
          stopStream();
          setStatus(data.status);
          if (data.status === 'completed') {
            toast.success('Config Sync job completed');
          } else if (data.status === 'failed') {
            setError(data.error || 'Job failed');
            toast.error('Config Sync job failed');
          } else if (data.status === 'cancelled') {
            toast('Config Sync job cancelled', { icon: '⚠️' });
          }
        }
      } catch {
        // Ignore transient poll errors
      }
    }, 1000);
  }, []);

  const handleRun = async () => {
    setError(null);
    setResult(null);
    setLiveLog([]);
    setStatus('running');
    try {
      const response = await configSyncAPI.startExportAndPatch({
        // No fromEnv/toEnv — resolved entirely server-side. No schema/table
        // filter — always the full run, every schema/table. Every run
        // pushes to S3 — a patch that never gets published is a trap (looks
        // done, but the metadata.json version list never moves and the test
        // dashboard never sees it). No opt-out. There's also no bucket to
        // pick — it always goes to the one real config-sync bucket.
        s3: true,
        versionDescription: versionDescription.trim(),
      });
      setExecutionId(response.executionId);
      startPolling(response.executionId);
      startStream(response.executionId);
    } catch (err: any) {
      setStatus('failed');
      setError(err?.response?.data?.error || err?.message || 'Failed to start Export & Patch');
    }
  };

  const handleCancel = async () => {
    if (!executionId) return;
    try {
      await configSyncAPI.cancel(executionId);
      stopPolling();
      stopStream();
      setStatus('cancelled');
    } catch (err) {
      toastNonApiError(err, 'Failed to cancel');
    }
  };

  const isRunning = status === 'running';

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied');
  };

  // Combined display log: live-streamed lines while running, full log from
  // the final result once it arrives (result.log is a superset once complete).
  const displayLog = status === 'running' ? liveLog : (result?.log ?? liveLog);

  return (
    <Stack spacing={2}>
      {/* Export + Patch — single combined flow. Nothing about From/To env,
          parallelism, or schema/table scope is shown — each deployment is
          locked to exactly one valid transfer via CONFIG_SYNC_ALLOWED_ENVS,
          so there's no real choice to expose, and every run is a full run. */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={600} gutterBottom>
          Export &amp; Patch
        </Typography>
        <Typography variant="body2" color="text.secondary" mb={2}>
          Pulls every config table, rewrites URLs, re-encrypts secrets, and publishes the result — one run.
        </Typography>

        <Stack direction="row" spacing={1.5} alignItems="flex-start">
          <TextField
            label="Version description"
            placeholder="What changed in this version?"
            size="small"
            fullWidth
            required
            value={versionDescription}
            onChange={e => setVersionDescription(e.target.value)}
            disabled={isRunning}
          />
          <Button
            variant="contained"
            startIcon={<PlayArrowIcon />}
            onClick={handleRun}
            disabled={isRunning || !versionDescription.trim()}
            size="small"
            sx={{ flexShrink: 0, height: 40 }}
          >
            Run Export &amp; Patch
          </Button>
          {isRunning && (
            <Button
              variant="outlined"
              color="error"
              startIcon={<StopIcon />}
              onClick={handleCancel}
              size="small"
              sx={{ flexShrink: 0, height: 40 }}
            >
              Cancel
            </Button>
          )}
        </Stack>
      </Paper>

      {/* Progress / results */}
      {status !== 'idle' && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={600} gutterBottom>
            Export &amp; Patch — {status}
          </Typography>

          {isRunning && <LinearProgress sx={{ mb: 2 }} />}

          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

          {/* Audit warnings — first-class treatment, never buried in the log */}
          {result && result.auditWarnings.length > 0 && (() => {
            const groups = groupAuditWarnings(result.auditWarnings);
            const totalCount = Object.values(groups).reduce((sum, g) => sum + g.count, 0);
            return (
              <Box mb={2}>
                <Typography variant="subtitle2" color="warning.main" gutterBottom>
                  Patch audit found {totalCount} issue(s) — review before trusting this output:
                </Typography>
                <Stack spacing={1}>
                  {Object.entries(groups).map(([tag, { lines, count }]) => (
                    <Alert key={tag} severity="warning" icon={false}>
                      <Chip label={`${tag} ${count}`} size="small" color="warning" sx={{ mr: 1 }} />
                      <Box component="span" sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                        {lines.slice(0, 5).map((l, i) => (
                          <Box key={i}>{tag !== 'Other' ? l.slice(tag.length).trim() : l}</Box>
                        ))}
                        {lines.length > 5 && <Box>... and {lines.length - 5} more</Box>}
                      </Box>
                    </Alert>
                  ))}
                </Stack>
              </Box>
            );
          })()}

          {/* Success result — the actual deliverable */}
          {status === 'completed' && result && (
            <Box mb={2}>
              {(() => {
                const localPath = extractResultLine(result.log, 'Patched data written to') ||
                  extractResultLine(result.log, 'EXPORT SUMMARY');
                const s3Url = extractResultLine(result.log, 's3://');
                return (
                  <Stack spacing={1}>
                    {localPath && (
                      <Alert
                        severity="success"
                        action={
                          <Tooltip title="Copy">
                            <IconButton size="small" onClick={() => copyToClipboard(localPath)}>
                              <ContentCopyIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        }
                      >
                        {localPath}
                      </Alert>
                    )}
                    {s3Url && (
                      <Alert
                        severity="success"
                        action={
                          <Tooltip title="Copy">
                            <IconButton size="small" onClick={() => copyToClipboard(s3Url)}>
                              <ContentCopyIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        }
                      >
                        {s3Url}
                      </Alert>
                    )}
                  </Stack>
                );
              })()}
            </Box>
          )}

          {/* Log — streamed live while running, full log once completed */}
          {displayLog.length > 0 && (
            <Box>
              <Divider sx={{ mb: 1 }} />
              <Typography variant="caption" color="text.secondary">
                {isRunning ? 'Console (live)' : 'Log (last 200 lines)'}
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
                  overflowY: 'auto',
                  maxHeight: 400,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  m: 0,
                }}
              >
                {displayLog.slice(-200).join('\n')}
              </Box>
            </Box>
          )}
        </Paper>
      )}
    </Stack>
  );
};

export default SyncRunPanel;
