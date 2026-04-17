import React, { useCallback } from 'react';
import { Paper, Stack, Typography, Chip, Button, Box, Menu, MenuItem, ListItemIcon, ListItemText } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckBoxIcon from '@mui/icons-material/CheckBox';
import CheckBoxOutlineBlankIcon from '@mui/icons-material/CheckBoxOutlineBlank';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import AssignmentIcon from '@mui/icons-material/Assignment';
import UndoIcon from '@mui/icons-material/Undo';
import { useMigrationsStore } from '../../store/migrationsStore';
import { useAppStore } from '../../store/appStore';
import type { AnalysisResult, MigrationFileResult, MigrationStatement } from '../../types/migrations';
import toast from 'react-hot-toast';

/** Build a summary string like "3 UPDATE, 2 INSERT" for a file's pending statements */
function buildStatementSummary(statements: MigrationStatement[]): string {
  const pending = statements.filter(s => s.status === 'pending' || s.status === 'manual_check');
  const counts: Record<string, number> = {};
  for (const s of pending) {
    const op = s.operation || 'OTHER';
    counts[op] = (counts[op] || 0) + 1;
  }
  return Object.entries(counts).map(([op, n]) => `${n} ${op}`).join(', ');
}

/** Group files by targetDatabase, then by migrationGroup within each database */
function groupByDatabase(files: MigrationFileResult[]): Array<{ database: string; groups: Array<{ label: string; files: MigrationFileResult[] }> }> {
  const dbMap: Record<string, MigrationFileResult[]> = {};
  for (const f of files) {
    const db = f.targetDatabase || 'Unknown';
    if (!dbMap[db]) dbMap[db] = [];
    dbMap[db].push(f);
  }

  return Object.entries(dbMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([database, dbFiles]) => {
      const groupMap: Record<string, MigrationFileResult[]> = {};
      for (const f of dbFiles) {
        const group = f.migrationGroup || f.folder || 'Other';
        if (!groupMap[group]) groupMap[group] = [];
        groupMap[group].push(f);
      }
      const groups = Object.entries(groupMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, gFiles]) => ({ label, files: gFiles }));
      return { database, groups };
    });
}

function generateMarkdownChecklist(result: AnalysisResult): string {
  const lines: string[] = [];
  lines.push('## Release Migration Checklist');
  lines.push(`**From:** ${result.fromRef} → **To:** ${result.toRef}`);
  lines.push(`**Date:** ${new Date().toISOString().split('T')[0]}`);
  lines.push('');

  const grouped = groupByDatabase(result.files);
  let totalQueries = 0;
  let totalFiles = 0;

  for (const { database, groups } of grouped) {
    const dbFiles = groups.flatMap(g => g.files);
    const dbPendingCount = dbFiles.reduce((sum, f) => sum + f.statements.filter(s => s.status === 'pending' || s.status === 'manual_check').length, 0);
    if (dbPendingCount === 0) continue;

    totalFiles += dbFiles.length;
    totalQueries += dbPendingCount;

    lines.push(`### ${database} (${dbFiles.length} file${dbFiles.length !== 1 ? 's' : ''}, ${dbPendingCount} quer${dbPendingCount !== 1 ? 'ies' : 'y'})`);
    lines.push('');

    for (const { label, files } of groups) {
      if (groups.length > 1) {
        lines.push(`#### ${label}`);
      }
      for (const file of files) {
        const summary = buildStatementSummary(file.statements);
        lines.push(`- [ ] ${file.filename}${summary ? ` (${summary})` : ''}`);
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push(`Total: ${totalQueries} quer${totalQueries !== 1 ? 'ies' : 'y'} across ${totalFiles} file${totalFiles !== 1 ? 's' : ''}`);
  return lines.join('\n');
}

function generateSlackChecklist(result: AnalysisResult): string {
  const lines: string[] = [];
  lines.push('*Release Migration Checklist*');
  lines.push(`\`${result.fromRef}\` → \`${result.toRef}\``);
  lines.push('');

  const grouped = groupByDatabase(result.files);
  let totalQueries = 0;
  let totalFiles = 0;

  for (const { database, groups } of grouped) {
    const dbFiles = groups.flatMap(g => g.files);
    const dbPendingCount = dbFiles.reduce((sum, f) => sum + f.statements.filter(s => s.status === 'pending' || s.status === 'manual_check').length, 0);
    if (dbPendingCount === 0) continue;

    totalFiles += dbFiles.length;
    totalQueries += dbPendingCount;

    lines.push(`*${database}* — ${dbFiles.length} file${dbFiles.length !== 1 ? 's' : ''}, ${dbPendingCount} quer${dbPendingCount !== 1 ? 'ies' : 'y'}`);

    for (const { files } of groups) {
      for (const file of files) {
        const summary = buildStatementSummary(file.statements);
        lines.push(`☐ ${file.filename}${summary ? ` (${summary})` : ''}`);
      }
    }
    lines.push('');
  }

  lines.push(`Total: ${totalQueries} quer${totalQueries !== 1 ? 'ies' : 'y'} across ${totalFiles} file${totalFiles !== 1 ? 's' : ''}`);
  return lines.join('\n');
}

const MigrationSummaryBar = () => {
  const analysisResult = useMigrationsStore((s) => s.analysisResult);
  const statusFilter = useMigrationsStore((s) => s.statusFilter);
  const setStatusFilter = useMigrationsStore((s) => s.setStatusFilter);
  const selectAllPending = useMigrationsStore((s) => s.selectAllPending);
  const deselectAll = useMigrationsStore((s) => s.deselectAll);
  const selectedStatements = useMigrationsStore((s) => s.selectedStatements);
  const getSelectedSQL = useMigrationsStore((s) => s.getSelectedSQL);

  const [checklistAnchor, setChecklistAnchor] = React.useState<null | HTMLElement>(null);

  if (!analysisResult) return null;

  const { summary } = analysisResult;
  const selectedCount = selectedStatements.size;

  const handleCopySelected = () => {
    const sql = getSelectedSQL();
    if (sql) {
      navigator.clipboard.writeText(sql);
      toast.success(`Copied ${selectedCount} selected statement(s)`);
    } else {
      toast('No statements selected');
    }
  };

  const handleCopyAllPending = () => {
    const sql = analysisResult.files
      .flatMap(f => f.statements)
      .filter(s => s.status === 'pending')
      .map(s => s.sql)
      .filter(Boolean)
      .join(';\n\n');
    if (sql) {
      navigator.clipboard.writeText(sql);
      toast.success(`Copied all ${summary.pending} pending statement(s)`);
    } else {
      toast('No pending statements');
    }
  };

  const handleRunAllPendingOnDbManager = () => {
    const sql = analysisResult.files
      .flatMap(f => f.statements)
      .filter(s => s.status === 'pending')
      .map(s => s.sql)
      .filter(Boolean)
      .join(';\n\n');
    if (sql) {
      useAppStore.getState().setCurrentQuery(sql);
      useAppStore.getState().setManagerMode('db');
      toast.success(`${summary.pending} pending statement(s) loaded into DB Manager`);
    } else {
      toast('No pending statements');
    }
  };

  const handleExportMarkdown = () => {
    const md = generateMarkdownChecklist(analysisResult);
    navigator.clipboard.writeText(md);
    toast.success('Markdown checklist copied to clipboard');
    setChecklistAnchor(null);
  };

  const handleExportSlack = () => {
    const slack = generateSlackChecklist(analysisResult);
    navigator.clipboard.writeText(slack);
    toast.success('Slack checklist copied to clipboard');
    setChecklistAnchor(null);
  };

  const handleCopyAllRollback = () => {
    // Collect rollback SQL in reverse order
    const rollbackStatements = analysisResult.files
      .flatMap(f => f.statements)
      .filter(s => (s.status === 'pending' || s.status === 'manual_check') && s.rollbackSql)
      .map(s => s.rollbackSql!)
      .reverse();
    if (rollbackStatements.length > 0) {
      navigator.clipboard.writeText(rollbackStatements.join('\n\n'));
      toast.success(`Copied ${rollbackStatements.length} rollback statement(s) in reverse order`);
    } else {
      toast('No rollback scripts available');
    }
  };

  const chips: Array<{ label: string; count: number; color: 'success' | 'warning' | 'info' | 'error' | 'default'; filter: 'applied' | 'pending' | 'manual_check' | 'error' }> = [
    { label: 'Applied', count: summary.applied, color: 'success', filter: 'applied' },
    { label: 'Pending', count: summary.pending, color: 'warning', filter: 'pending' },
    { label: 'Manual Check', count: summary.manualCheck, color: 'info', filter: 'manual_check' },
    { label: 'Errors', count: summary.errors, color: 'error', filter: 'error' },
  ];

  return (
    <Paper elevation={1} sx={{ p: 1.5, px: 2 }}>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
        {/* Prominent actionable count */}
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, flexWrap: 'wrap' }}>
          <Typography variant="h5" color="warning.main" sx={{ fontWeight: 700, lineHeight: 1 }}>
            {summary.pending + summary.manualCheck + summary.errors}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {summary.pending + summary.manualCheck + summary.errors === 1 ? 'query' : 'queries'} to review
            ({summary.pending} pending, {summary.manualCheck} manual check)
            across {analysisResult.files.length} files
          </Typography>
          {summary.totalFilesInDiff !== undefined && summary.fullyAppliedFiles !== undefined && summary.fullyAppliedFiles > 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
              · {summary.totalFilesInDiff} files in diff, {summary.fullyAppliedFiles} fully applied (hidden)
            </Typography>
          )}
        </Box>

        <Box sx={{ flex: 1 }} />

        {/* Action buttons */}
        <Button
          size="small"
          variant="outlined"
          startIcon={<CheckBoxIcon sx={{ fontSize: 14 }} />}
          onClick={selectAllPending}
          sx={{ fontSize: '0.75rem' }}
        >
          Select All Pending
        </Button>

        {selectedCount > 0 && (
          <>
            <Button
              size="small"
              variant="contained"
              color="warning"
              startIcon={<ContentCopyIcon sx={{ fontSize: 14 }} />}
              onClick={handleCopySelected}
              sx={{ fontSize: '0.75rem' }}
            >
              Copy Selected ({selectedCount})
            </Button>
            <Button
              size="small"
              variant="outlined"
              startIcon={<CheckBoxOutlineBlankIcon sx={{ fontSize: 14 }} />}
              onClick={deselectAll}
              sx={{ fontSize: '0.75rem' }}
            >
              Clear
            </Button>
          </>
        )}

        {summary.pending > 0 && (
          <>
            <Button
              size="small"
              variant="contained"
              color="primary"
              startIcon={<ContentCopyIcon sx={{ fontSize: 14 }} />}
              onClick={handleCopyAllPending}
              sx={{ fontSize: '0.75rem' }}
            >
              Copy All Pending
            </Button>
            <Button
              size="small"
              variant="contained"
              color="success"
              startIcon={<PlayArrowIcon sx={{ fontSize: 14 }} />}
              onClick={handleRunAllPendingOnDbManager}
              sx={{ fontSize: '0.75rem' }}
            >
              Run All Pending on DB Manager
            </Button>
          </>
        )}
      </Stack>

      {/* Second row: status filter chips + export/rollback buttons */}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
        <Typography variant="caption" color="text.secondary">
          {summary.totalStatements} total statements
          {summary.skipped > 0 && ` (${summary.skipped} skipped)`}
        </Typography>
        <Chip
          label="All"
          size="small"
          variant={statusFilter === 'all' ? 'filled' : 'outlined'}
          onClick={() => setStatusFilter('all')}
          sx={{ cursor: 'pointer' }}
        />
        {chips.map((chip) => (
          <Chip
            key={chip.filter}
            label={`${chip.label}: ${chip.count}`}
            size="small"
            color={chip.color}
            variant={statusFilter === chip.filter ? 'filled' : 'outlined'}
            onClick={() => setStatusFilter(chip.filter)}
            sx={{ cursor: 'pointer' }}
          />
        ))}

        <Box sx={{ flex: 1 }} />

        {/* Export Checklist */}
        <Button
          size="small"
          variant="outlined"
          startIcon={<AssignmentIcon sx={{ fontSize: 14 }} />}
          onClick={(e) => setChecklistAnchor(e.currentTarget)}
          sx={{ fontSize: '0.72rem', textTransform: 'none' }}
        >
          Export Checklist
        </Button>
        <Menu
          anchorEl={checklistAnchor}
          open={Boolean(checklistAnchor)}
          onClose={() => setChecklistAnchor(null)}
        >
          <MenuItem onClick={handleExportMarkdown}>
            <ListItemIcon><ContentCopyIcon fontSize="small" /></ListItemIcon>
            <ListItemText>Copy as Markdown</ListItemText>
          </MenuItem>
          <MenuItem onClick={handleExportSlack}>
            <ListItemIcon><ContentCopyIcon fontSize="small" /></ListItemIcon>
            <ListItemText>Copy as Slack</ListItemText>
          </MenuItem>
        </Menu>

      </Stack>
    </Paper>
  );
};

export default React.memo(MigrationSummaryBar);
