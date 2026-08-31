import React, { useState } from 'react';
import {
  Paper, Stack, Typography, Button, Switch, FormControlLabel, Box,
  Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, Alert, LinearProgress,
  TextField,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import toast from 'react-hot-toast';
import { useLiteRunnerStore, stmtKey } from '../../../store/liteRunnerStore';
import { useSqlExecution } from '../../../hooks/useSqlExecution';
import { detectDangerousQueries } from '../../../services/queryValidation.service';
import { useAppStore } from '../../../store/appStore';

const LiteRunBar = () => {
  const database = useLiteRunnerStore((s) => s.database);
  const mode = useLiteRunnerStore((s) => s.mode);
  const pgSchema = useLiteRunnerStore((s) => s.pgSchema);
  const continueOnError = useLiteRunnerStore((s) => s.continueOnError);
  const setContinueOnError = useLiteRunnerStore((s) => s.setContinueOnError);
  const isRunning = useLiteRunnerStore((s) => s.isRunning);
  const setIsRunning = useLiteRunnerStore((s) => s.setIsRunning);
  const getSelectedFiles = useLiteRunnerStore((s) => s.getSelectedFiles);
  const setFileRunState = useLiteRunnerStore((s) => s.setFileRunState);
  const resetRunState = useLiteRunnerStore((s) => s.resetRunState);
  const selectedStatements = useLiteRunnerStore((s) => s.selectedStatements);
  const diff = useLiteRunnerStore((s) => s.diff);
  const runState = useLiteRunnerStore((s) => s.runState);

  const user = useAppStore((s) => s.user);

  const { runSql } = useSqlExecution();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);

  if (!diff || diff.totalFiles === 0) return null;

  const selectedCount = selectedStatements.size;
  const selected = getSelectedFiles();
  const fileCount = selected.length;
  const canRun = selectedCount > 0 && !!database && !!mode && !isRunning;

  // Warn before running anything that is not pure schema change.
  let ddlStatements = 0;
  let nonDdlStatements = 0;
  for (const dir of diff.directories) {
    for (const file of dir.files) {
      file.statements.forEach((stmt, i) => {
        if (!selectedStatements.has(stmtKey(file.path, i))) return;
        if (stmt.type === 'DDL') ddlStatements++;
        else nonDdlStatements++;
      });
    }
  }

  // Destructive statements (ALTER DROP, DROP, TRUNCATE, ...) need the user's
  // password re-entered — collect it once here rather than failing per file.
  // Reuses the DB Manager's detector so both prompt on exactly the same rule.
  // Files carrying at least one selected dangerous statement. Named in the
  // password dialog so the user can see exactly what they are authorising.
  const dangerousFiles = selected.filter(f => f.dangerousCount > 0);
  const dangerousStatementCount = dangerousFiles.reduce((sum, f) => sum + f.dangerousCount, 0);
  const requiresPassword = selected.some(
    f => detectDangerousQueries(f.sql, user?.role)?.requiresPassword
  );

  const finished = Object.values(runState).filter(s => s.status === 'success' || s.status === 'failed');
  const succeeded = finished.filter(s => s.status === 'success').length;
  const failed = finished.filter(s => s.status === 'failed').length;

  const doRun = async () => {
    setConfirmOpen(false);
    const runPassword = password;
    setPassword('');
    const files = getSelectedFiles();
    if (files.length === 0) return;

    resetRunState();
    setIsRunning(true);
    setProgress({ current: 0, total: files.length });

    let ok = 0;
    let bad = 0;
    let stopped = false;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      if (stopped) {
        setFileRunState(file.path, { status: 'skipped' });
        continue;
      }

      setProgress({ current: i + 1, total: files.length });
      setFileRunState(file.path, { status: 'running' });

      const outcome = await runSql(file.sql, {
        database, mode, pgSchema, continueOnError,
        password: runPassword || undefined,
      });

      if (outcome.success) {
        ok++;
        setFileRunState(file.path, {
          status: 'success',
          rowsAffected: outcome.rowsAffected,
          durationMs: outcome.durationMs,
        });
      } else {
        bad++;
        setFileRunState(file.path, {
          status: 'failed',
          error: outcome.error,
          statementErrors: outcome.statementErrors,
        });

        // A bad or missing password fails identically for every remaining file
        // — stop rather than grinding through them all with the same error.
        if (outcome.needsPassword) {
          toast.error(outcome.error || 'Password verification failed');
          stopped = true;
          continue;
        }

        if (outcome.roleDenied) {
          toast.error(
            outcome.roleDenied.canRequestApproval
              ? 'Your role cannot run this. Raise it from the DB Manager tab to request approval.'
              : outcome.error || 'Not permitted',
          );
          stopped = true;
          continue;
        }

        // continueOnError governs statements WITHIN a file on the backend; here
        // it also decides whether a failed file stops the remaining files.
        if (!continueOnError) stopped = true;
      }
    }

    setIsRunning(false);
    setProgress(null);

    if (bad === 0) toast.success(`Ran ${ok} file(s) successfully`);
    else if (ok === 0) toast.error(`All ${bad} file(s) failed`);
    else toast(`${ok} succeeded, ${bad} failed`);
  };

  return (
    <>
      <Paper elevation={3} sx={{ p: 1.5 }}>
        <Stack direction="row" spacing={2} alignItems="center">
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {selectedCount} statement{selectedCount === 1 ? '' : 's'} in {fileCount} file{fileCount === 1 ? '' : 's'}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {ddlStatements} DDL{nonDdlStatements > 0 ? ` · ${nonDdlStatements} non-DDL` : ''}
          </Typography>

          {finished.length > 0 && !isRunning && (
            <Typography variant="body2" color="text.secondary">
              {succeeded} succeeded, {failed} failed
            </Typography>
          )}

          <Box sx={{ flex: 1 }}>
            {progress && (
              <Stack spacing={0.5}>
                <Typography variant="caption" color="text.secondary">
                  Running file {progress.current} of {progress.total}
                </Typography>
                <LinearProgress variant="determinate" value={(progress.current / progress.total) * 100} />
              </Stack>
            )}
          </Box>

          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={continueOnError}
                onChange={(e) => setContinueOnError(e.target.checked)}
                disabled={isRunning}
              />
            }
            label={<Typography variant="body2">Continue on error</Typography>}
          />

          <Button
            variant="contained"
            color="success"
            startIcon={<PlayArrowIcon />}
            onClick={() => setConfirmOpen(true)}
            disabled={!canRun}
            sx={{ minWidth: 190, whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            {isRunning ? 'Running...' : `Run Selected (${selectedCount})`}
          </Button>
        </Stack>
      </Paper>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Run migrations?</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            This will execute <strong>{selectedCount} statement(s)</strong> across{' '}
            <strong>{fileCount} file(s)</strong> against{' '}
            <strong>{database}</strong> ({mode}{pgSchema ? `, schema ${pgSchema}` : ''}).
          </DialogContentText>
          <Alert severity="warning" sx={{ mt: 2 }}>
            Files run one at a time, in order.{' '}
            {continueOnError
              ? 'A failure will not stop the remaining files.'
              : 'The run stops at the first failing file.'}
          </Alert>
          {nonDdlStatements > 0 && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {nonDdlStatements} of the selected statement(s) are <strong>not DDL</strong> — they
              modify data or run procedural code, not just schema.
            </Alert>
          )}
          {requiresPassword && (
            <>
              <Alert severity="error" sx={{ mt: 1 }}>
                <Typography variant="body2" sx={{ fontWeight: 600, mb: dangerousFiles.length ? 1 : 0 }}>
                  {dangerousStatementCount} destructive statement(s) in {dangerousFiles.length} file(s)
                  {' '}— DROP, RENAME, column type change or TRUNCATE. Your password is required.
                </Typography>
                <Box component="ul" sx={{ m: 0, pl: 2.5, maxHeight: 160, overflow: 'auto' }}>
                  {dangerousFiles.map(f => (
                    <Box component="li" key={f.path} sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {f.filename}
                      <Box component="span" sx={{ opacity: 0.7 }}>
                        {' '}({f.dangerousCount} of {f.statementCount} selected)
                      </Box>
                    </Box>
                  ))}
                </Box>
              </Alert>
              <TextField
                fullWidth
                type="password"
                size="small"
                label="Your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                sx={{ mt: 2 }}
                autoComplete="current-password"
              />
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setConfirmOpen(false); setPassword(''); }}>Cancel</Button>
          <Button
            variant="contained"
            color="success"
            onClick={doRun}
            disabled={requiresPassword && !password}
          >
            Run
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default React.memo(LiteRunBar);
