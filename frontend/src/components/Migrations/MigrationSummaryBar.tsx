import React from 'react';
import { Paper, Stack, Typography, Chip, Button, Box } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckBoxIcon from '@mui/icons-material/CheckBox';
import CheckBoxOutlineBlankIcon from '@mui/icons-material/CheckBoxOutlineBlank';
import { useMigrationsStore } from '../../store/migrationsStore';
import toast from 'react-hot-toast';

const MigrationSummaryBar = () => {
  const analysisResult = useMigrationsStore((s) => s.analysisResult);
  const statusFilter = useMigrationsStore((s) => s.statusFilter);
  const setStatusFilter = useMigrationsStore((s) => s.setStatusFilter);
  const selectAllPending = useMigrationsStore((s) => s.selectAllPending);
  const deselectAll = useMigrationsStore((s) => s.deselectAll);
  const selectedStatements = useMigrationsStore((s) => s.selectedStatements);
  const getSelectedSQL = useMigrationsStore((s) => s.getSelectedSQL);

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

  const chips: Array<{ label: string; count: number; color: 'success' | 'warning' | 'info' | 'error' | 'default'; filter: 'applied' | 'pending' | 'manual_check' | 'error' }> = [
    { label: 'Applied', count: summary.applied, color: 'success', filter: 'applied' },
    { label: 'Pending', count: summary.pending, color: 'warning', filter: 'pending' },
    { label: 'Manual Check', count: summary.manualCheck, color: 'info', filter: 'manual_check' },
    { label: 'Errors', count: summary.errors, color: 'error', filter: 'error' },
  ];

  return (
    <Paper elevation={1} sx={{ p: 1.5, px: 2 }}>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
        {/* Prominent pending count */}
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75 }}>
          <Typography variant="h5" color="warning.main" sx={{ fontWeight: 700, lineHeight: 1 }}>
            {summary.pending}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {summary.pending === 1 ? 'query' : 'queries'} pending across {summary.totalFiles} files
          </Typography>
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
        )}
      </Stack>

      {/* Status filter chips */}
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
      </Stack>
    </Paper>
  );
};

export default React.memo(MigrationSummaryBar);
