import React from 'react';
import {
  Paper, Box, Stack, Typography, Checkbox, IconButton, Collapse, Chip, Tooltip,
  CircularProgress,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import { useLiteRunnerStore, stmtKey, type FileRunState } from '../../../store/liteRunnerStore';
import type { LiteDiffFile, LiteFileKind } from '../../../types/migrations';

const DDL_COLOR = '#58a6ff';
const NON_DDL_COLOR = '#d29922';
const ADDED_BG = 'rgba(46, 160, 67, 0.13)';
const GUTTER = 52;

const KindChip = ({ kind }: { kind: LiteFileKind }) => {
  if (kind === 'MIXED') {
    return (
      <Tooltip title="This file mixes schema changes with data changes — pick statements individually below">
        <Chip size="small" label="MIXED" sx={{ height: 20, fontSize: 11, fontWeight: 700, bgcolor: NON_DDL_COLOR, color: '#1c1c1c' }} />
      </Tooltip>
    );
  }
  const isDdl = kind === 'DDL';
  return (
    <Chip
      size="small"
      variant="outlined"
      label={isDdl ? 'DDL' : 'NON-DDL'}
      sx={{
        height: 20, fontSize: 11, fontWeight: 700,
        color: isDdl ? DDL_COLOR : NON_DDL_COLOR,
        borderColor: isDdl ? DDL_COLOR : NON_DDL_COLOR,
      }}
    />
  );
};

const StatusChip = ({ state }: { state?: FileRunState }) => {
  if (!state || state.status === 'idle') return null;
  if (state.status === 'running') {
    return <Chip size="small" icon={<CircularProgress size={11} />} label="Running" sx={{ height: 20, fontSize: 11 }} />;
  }
  if (state.status === 'success') {
    return (
      <Chip
        size="small" color="success"
        icon={<CheckCircleIcon sx={{ fontSize: 13 }} />}
        label={state.durationMs != null ? `${state.durationMs} ms` : 'Done'}
        sx={{ height: 20, fontSize: 11 }}
      />
    );
  }
  if (state.status === 'skipped') {
    return <Chip size="small" variant="outlined" label="Skipped" sx={{ height: 20, fontSize: 11 }} />;
  }
  return (
    <Tooltip title={state.error || 'Failed'}>
      <Chip size="small" color="error" icon={<ErrorIcon sx={{ fontSize: 13 }} />} label="Failed" sx={{ height: 20, fontSize: 11 }} />
    </Tooltip>
  );
};

/**
 * SQL rendered the way the diff shows it: numbered lines on a green "added"
 * ground. These statements are exactly what the compare range introduced, so
 * every line is an addition.
 */
const SqlLines = ({ sql, startLine }: { sql: string; startLine: number }) => (
  <Box sx={{ fontFamily: 'monospace', fontSize: 12.5, lineHeight: '20px' }}>
    {sql.split('\n').map((line, i) => (
      <Stack key={i} direction="row" sx={{ bgcolor: ADDED_BG }}>
        <Box
          sx={{
            width: GUTTER, flexShrink: 0, textAlign: 'right', pr: 1.5,
            color: 'text.disabled', userSelect: 'none',
            borderRight: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          {startLine + i}
        </Box>
        <Box sx={{ pl: 1.5, pr: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1, color: '#7ee787' }}>
          {line}
        </Box>
      </Stack>
    ))}
  </Box>
);

const FileCard = ({ file }: { file: LiteDiffFile }) => {
  const selectedStatements = useLiteRunnerStore((s) => s.selectedStatements);
  const expandedFiles = useLiteRunnerStore((s) => s.expandedFiles);
  const toggleFile = useLiteRunnerStore((s) => s.toggleFile);
  const toggleStatement = useLiteRunnerStore((s) => s.toggleStatement);
  const toggleFileExpanded = useLiteRunnerStore((s) => s.toggleFileExpanded);
  const runState = useLiteRunnerStore((s) => s.runState);
  const isRunning = useLiteRunnerStore((s) => s.isRunning);

  const expanded = expandedFiles.has(file.path);
  const selectedCount = file.statements.filter((_s, i) => selectedStatements.has(stmtKey(file.path, i))).length;

  // Only a mixed file needs per-statement checkboxes. When every statement in
  // the file is the same kind, the file-level checkbox already says everything
  // there is to say, and repeating it per statement is noise.
  const perStatementSelection = file.kind === 'MIXED';

  let lineCursor = 1;

  return (
    <Paper variant="outlined" sx={{ overflow: 'hidden', borderColor: 'rgba(255,255,255,0.12)' }}>
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{
          px: 1, py: 0.75,
          bgcolor: 'rgba(255,255,255,0.03)',
          cursor: 'pointer',
          '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' },
        }}
        onClick={() => toggleFileExpanded(file.path)}
      >
        <IconButton size="small" sx={{ p: 0.25 }}>
          {expanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
        </IconButton>

        <Checkbox
          size="small"
          sx={{ p: 0.25 }}
          checked={selectedCount === file.statementCount}
          indeterminate={selectedCount > 0 && selectedCount < file.statementCount}
          onClick={(e) => e.stopPropagation()}
          onChange={() => toggleFile(file.path)}
          disabled={isRunning}
        />

        <Typography
          sx={{
            flex: 1, fontFamily: 'monospace', fontSize: 13,
            wordBreak: 'break-all', minWidth: 0,
          }}
        >
          {file.directory}/<Box component="span" sx={{ fontWeight: 700 }}>{file.filename}</Box>
        </Typography>

        <StatusChip state={runState[file.path]} />
        <KindChip kind={file.kind} />
        <Typography variant="caption" sx={{ color: '#3fb950', fontWeight: 700, whiteSpace: 'nowrap' }}>
          {selectedCount}/{file.statementCount}
        </Typography>
      </Stack>

      <Collapse in={expanded} unmountOnExit>
        <Box sx={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          {file.statements.map((stmt, i) => {
            const start = lineCursor;
            lineCursor += stmt.sql.split('\n').length;
            const isSelected = selectedStatements.has(stmtKey(file.path, i));

            return (
              <Box
                key={i}
                sx={{
                  borderBottom: i < file.statements.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none',
                  opacity: perStatementSelection && !isSelected ? 0.45 : 1,
                }}
              >
                {perStatementSelection && (
                  <Stack
                    direction="row"
                    alignItems="center"
                    spacing={1}
                    sx={{ px: 1, py: 0.4, bgcolor: 'rgba(255,255,255,0.02)' }}
                  >
                    <Checkbox
                      size="small"
                      sx={{ p: 0.25 }}
                      checked={isSelected}
                      onChange={() => toggleStatement(file.path, i)}
                      disabled={isRunning}
                    />
                    <Chip
                      size="small"
                      variant="outlined"
                      label={stmt.type === 'DDL' ? 'DDL' : 'NON-DDL'}
                      sx={{
                        height: 18, fontSize: 10, fontWeight: 700,
                        color: stmt.type === 'DDL' ? DDL_COLOR : NON_DDL_COLOR,
                        borderColor: stmt.type === 'DDL' ? DDL_COLOR : NON_DDL_COLOR,
                      }}
                    />
                    <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                      {stmt.operation}
                    </Typography>
                  </Stack>
                )}
                <SqlLines sql={`${stmt.sql};`} startLine={start} />
              </Box>
            );
          })}

          {runState[file.path]?.error && (
            <Box sx={{ px: 2, py: 1, bgcolor: 'rgba(248,81,73,0.12)' }}>
              <Typography variant="caption" color="error" sx={{ fontFamily: 'monospace' }}>
                {runState[file.path].error}
              </Typography>
            </Box>
          )}
        </Box>
      </Collapse>
    </Paper>
  );
};

const LiteFileList = () => {
  const diff = useLiteRunnerStore((s) => s.diff);
  const getVisibleFiles = useLiteRunnerStore((s) => s.getVisibleFiles);
  const search = useLiteRunnerStore((s) => s.search);
  const directoryFilter = useLiteRunnerStore((s) => s.directoryFilter);

  if (!diff) return null;

  if (diff.totalFiles === 0) {
    return (
      <Paper elevation={1} sx={{ p: 4, textAlign: 'center' }}>
        <Typography variant="body2" color="text.secondary">
          No SQL changes in {diff.base}...{diff.head}
        </Typography>
      </Paper>
    );
  }

  const files = getVisibleFiles();

  if (files.length === 0) {
    return (
      <Paper elevation={1} sx={{ p: 4, textAlign: 'center' }}>
        <Typography variant="body2" color="text.secondary">
          No files match {search.trim() ? `"${search.trim()}"` : 'this filter'}
          {directoryFilter !== 'all' ? ` in ${directoryFilter}` : ''}.
        </Typography>
      </Paper>
    );
  }

  return (
    <Stack spacing={1}>
      {files.map((file) => <FileCard key={file.path} file={file} />)}
    </Stack>
  );
};

export default React.memo(LiteFileList);
