import React, { useState } from 'react';
import {
  Box,
  Checkbox,
  Chip,
  Collapse,
  IconButton,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { useConfigReplicateStore } from '../../store/configReplicateStore';
import type { RowDiff } from '../../types/configReplicate';

const OP_COLOR: Record<string, 'success' | 'warning' | 'error' | 'default'> = {
  INSERT: 'success',
  UPDATE: 'warning',
  DELETE: 'error',
  NO_CHANGE: 'default',
};

const renderValue = (value: unknown): string => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') {
    const maybeTruncated = value as { __truncated?: boolean; value?: unknown };
    if (maybeTruncated.__truncated) return `${String(maybeTruncated.value)}…`;
    return JSON.stringify(value);
  }
  return String(value);
};

const mono = {
  fontFamily: 'monospace',
  fontSize: '0.75rem',
  wordBreak: 'break-all' as const,
};

const identityLabel = (diff: RowDiff): string => {
  const preview = diff.rowPreview || {};
  const keys = Object.keys(preview).slice(0, 3);
  return keys.map(k => `${k}=${renderValue(preview[k])}`).join('  ');
};

interface Props {
  diff: RowDiff;
}

const RowDiffCard = ({ diff }: Props) => {
  // Subscribed as booleans, not as the Sets: toggling any row replaces the Set
  // identity, so selecting the whole set here would re-render every mounted card
  // on every click and defeat the memo below.
  const isSelected = useConfigReplicateStore(s => s.selectedDiffs.has(diff.diffId));
  const isExpanded = useConfigReplicateStore(s => s.expandedDiffs.has(diff.diffId));
  const toggleDiff = useConfigReplicateStore(s => s.toggleDiff);
  const toggleDiffExpanded = useConfigReplicateStore(s => s.toggleDiffExpanded);
  const [showAllColumns, setShowAllColumns] = useState(false);
  const selectable = diff.operation !== 'NO_CHANGE';

  const changedColumns = new Set((diff.columnDiffs || []).map(c => c.column));
  const previewEntries = Object.entries(diff.rowPreview || {});
  const visibleEntries =
    diff.operation === 'UPDATE' && !showAllColumns
      ? previewEntries.filter(([column]) => changedColumns.has(column))
      : previewEntries;

  return (
    <Paper
      elevation={0}
      sx={{
        mb: 0.75,
        border: 1,
        borderColor: isSelected ? 'warning.main' : diff.ambiguous ? 'warning.dark' : 'divider',
        bgcolor: selectable ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.01)',
        opacity: selectable ? 1 : 0.6,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.5 }}>
        {selectable ? (
          <Checkbox
            size="small"
            checked={isSelected}
            onChange={() => toggleDiff(diff.diffId)}
            sx={{ p: 0.25 }}
          />
        ) : (
          <Box sx={{ width: 28 }} />
        )}

        <Chip
          label={diff.operation.replace('_', ' ')}
          size="small"
          color={OP_COLOR[diff.operation]}
          sx={{ height: 22, fontSize: '0.7rem', fontWeight: 600, minWidth: 76 }}
        />

        {diff.multiplicity > 1 && (
          <Tooltip title="Identical rows collapsed into one entry; all of them will be applied">
            <Chip
              label={`x${diff.multiplicity}`}
              size="small"
              variant="outlined"
              sx={{ height: 20, fontSize: '0.65rem' }}
            />
          </Tooltip>
        )}

        {diff.ambiguous && (
          <Tooltip title={diff.ambiguityReason || 'This row was not confidently matched'}>
            <Chip
              icon={<WarningAmberIcon sx={{ fontSize: 14 }} />}
              label="No confident match"
              size="small"
              color="warning"
              variant="outlined"
              sx={{ height: 20, fontSize: '0.65rem' }}
            />
          </Tooltip>
        )}

        <Typography variant="body2" sx={{ ...mono, flex: 1 }} noWrap>
          {identityLabel(diff)}
        </Typography>

        <IconButton size="small" onClick={() => toggleDiffExpanded(diff.diffId)} sx={{ p: 0.25 }}>
          {isExpanded ? (
            <KeyboardArrowUpIcon fontSize="small" />
          ) : (
            <KeyboardArrowDownIcon fontSize="small" />
          )}
        </IconButton>
      </Box>

      <Collapse in={isExpanded} unmountOnExit>
        <Box sx={{ px: 1.5, pb: 1 }}>
          {diff.operation === 'UPDATE' ? (
            <>
              <Table size="small" sx={{ bgcolor: 'rgba(0,0,0,0.3)', borderRadius: 1 }}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ ...mono, fontWeight: 600 }}>Column</TableCell>
                    <TableCell sx={{ ...mono, fontWeight: 600 }}>Current</TableCell>
                    <TableCell sx={{ ...mono, fontWeight: 600 }}>New</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(diff.columnDiffs || []).map(columnDiff => (
                    <TableRow key={columnDiff.column}>
                      <TableCell sx={mono}>{columnDiff.column}</TableCell>
                      <TableCell
                        sx={{ ...mono, color: 'error.main', textDecoration: 'line-through' }}
                      >
                        {renderValue(columnDiff.oldValue)}
                      </TableCell>
                      <TableCell sx={{ ...mono, color: 'success.main' }}>
                        {renderValue(columnDiff.newValue)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Typography
                variant="caption"
                onClick={() => setShowAllColumns(v => !v)}
                sx={{ cursor: 'pointer', color: 'primary.main', mt: 0.5, display: 'inline-block' }}
              >
                {showAllColumns
                  ? 'Show only changed columns'
                  : `Show all ${previewEntries.length} columns`}
              </Typography>
              {showAllColumns && (
                <Table size="small" sx={{ mt: 0.5, bgcolor: 'rgba(0,0,0,0.2)', borderRadius: 1 }}>
                  <TableBody>
                    {previewEntries.map(([column, value]) => (
                      <TableRow key={column}>
                        <TableCell sx={{ ...mono, width: '35%' }}>{column}</TableCell>
                        <TableCell sx={mono}>{renderValue(value)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </>
          ) : (
            <Table size="small" sx={{ bgcolor: 'rgba(0,0,0,0.3)', borderRadius: 1 }}>
              <TableBody>
                {visibleEntries.map(([column, value]) => (
                  <TableRow key={column}>
                    <TableCell sx={{ ...mono, width: '35%' }}>{column}</TableCell>
                    <TableCell sx={mono}>{renderValue(value)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Box>
      </Collapse>
    </Paper>
  );
};

export default React.memo(RowDiffCard);
