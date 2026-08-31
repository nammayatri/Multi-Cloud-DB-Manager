import React from 'react';
import { Paper, Stack, Typography, Box, Button, Chip, Alert } from '@mui/material';
import ErrorIcon from '@mui/icons-material/Error';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import toast from 'react-hot-toast';
import { useLiteRunnerStore } from '../../../store/liteRunnerStore';

/**
 * Every failure from the last run, always shown.
 *
 * Errors used to be reachable only by expanding the offending file, which meant
 * a "continue on error" run could finish with failures the user never noticed.
 * This panel surfaces them unconditionally — under either error mode — so a
 * partially-applied migration can never look like a clean run.
 */
const LiteRunErrors = () => {
  const runState = useLiteRunnerStore((s) => s.runState);
  const isRunning = useLiteRunnerStore((s) => s.isRunning);
  const continueOnError = useLiteRunnerStore((s) => s.continueOnError);
  const toggleFileExpanded = useLiteRunnerStore((s) => s.toggleFileExpanded);
  const expandedFiles = useLiteRunnerStore((s) => s.expandedFiles);

  const failures = Object.entries(runState).filter(([, s]) => s.status === 'failed');
  const skipped = Object.entries(runState).filter(([, s]) => s.status === 'skipped');

  if (failures.length === 0) return null;

  const copyAll = () => {
    const text = failures
      .map(([path, s]) => {
        const body = s.statementErrors?.length
          ? s.statementErrors.map(e => `${e.statement}\n-- ${e.error}`).join('\n\n')
          : (s.error || 'Unknown error');
        return `${path}\n${body}`;
      })
      .join('\n\n');
    navigator.clipboard.writeText(text);
    toast.success(`Copied ${failures.length} error(s)`);
  };

  return (
    <Paper
      elevation={2}
      sx={{ border: 1, borderColor: 'error.main', bgcolor: 'rgba(248,81,73,0.06)' }}
    >
      <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 2, py: 1 }}>
        <ErrorIcon color="error" fontSize="small" />
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {failures.length} file(s) failed
        </Typography>
        {skipped.length > 0 && (
          <Chip size="small" variant="outlined" label={`${skipped.length} skipped`} sx={{ height: 20, fontSize: 11 }} />
        )}
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          startIcon={<ContentCopyIcon sx={{ fontSize: 14 }} />}
          onClick={copyAll}
          disabled={isRunning}
        >
          Copy Errors
        </Button>
      </Stack>

      {!continueOnError && skipped.length > 0 && (
        <Alert severity="warning" sx={{ mx: 2, mb: 1 }}>
          The run stopped at the first failure, so {skipped.length} selected file(s) were never
          attempted. Earlier files already applied — re-running will re-execute them.
        </Alert>
      )}

      <Stack spacing={0.5} sx={{ px: 2, pb: 1.5 }}>
        {failures.map(([path, state]) => (
          <Box
            key={path}
            sx={{
              p: 1, borderRadius: 1,
              bgcolor: 'rgba(0,0,0,0.35)',
              border: '1px solid rgba(248,81,73,0.3)',
            }}
          >
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography sx={{ fontFamily: 'monospace', fontSize: 12.5, flex: 1, wordBreak: 'break-all' }}>
                {path}
              </Typography>
              <Button
                size="small"
                sx={{ minWidth: 0, whiteSpace: 'nowrap' }}
                onClick={() => { if (!expandedFiles.has(path)) toggleFileExpanded(path); }}
              >
                View SQL
              </Button>
            </Stack>
            {state.statementErrors && state.statementErrors.length > 0 ? (
              <Stack spacing={0.75} sx={{ mt: 0.5 }}>
                {state.statementErrors.map((se, i) => (
                  <Box key={i}>
                    {se.statement && (
                      <Typography
                        variant="caption"
                        sx={{ fontFamily: 'monospace', display: 'block', color: 'text.secondary', whiteSpace: 'pre-wrap' }}
                      >
                        {se.statement.length > 200 ? `${se.statement.slice(0, 200)}…` : se.statement}
                      </Typography>
                    )}
                    <Typography
                      variant="caption"
                      color="error"
                      sx={{ fontFamily: 'monospace', display: 'block', whiteSpace: 'pre-wrap' }}
                    >
                      {se.error}
                    </Typography>
                  </Box>
                ))}
              </Stack>
            ) : (
              <Typography
                variant="caption"
                color="error"
                sx={{ fontFamily: 'monospace', display: 'block', mt: 0.5, whiteSpace: 'pre-wrap' }}
              >
                {state.error || 'Unknown error'}
              </Typography>
            )}
          </Box>
        ))}
      </Stack>
    </Paper>
  );
};

export default React.memo(LiteRunErrors);
