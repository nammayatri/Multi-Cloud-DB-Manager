import React, { useState } from 'react';
import {
  Alert,
  Box,
  Checkbox,
  Chip,
  Collapse,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import UndoIcon from '@mui/icons-material/Undo';
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
  editableColumns: string[];
}

const RowDiffCard = ({ diff, editableColumns }: Props) => {
  // Subscribed as booleans, not as the Sets: toggling any row replaces the Set
  // identity, so selecting the whole set here would re-render every mounted card
  // on every click and defeat the memo below.
  const isSelected = useConfigReplicateStore(s => s.selectedDiffs.has(diff.diffId));
  const isExpanded = useConfigReplicateStore(s => s.expandedDiffs.has(diff.diffId));
  const toggleDiff = useConfigReplicateStore(s => s.toggleDiff);
  const toggleDiffExpanded = useConfigReplicateStore(s => s.toggleDiffExpanded);
  const retained = useConfigReplicateStore(s => s.retainedColumns[diff.diffId]);
  const overrides = useConfigReplicateStore(s => s.overrides[diff.diffId]);
  const toggleRetainedColumn = useConfigReplicateStore(s => s.toggleRetainedColumn);
  const setOverride = useConfigReplicateStore(s => s.setOverride);
  const clearOverride = useConfigReplicateStore(s => s.clearOverride);
  const [showAllColumns, setShowAllColumns] = useState(false);

  const editable = new Set(editableColumns);
  const retainedSet = new Set(retained || []);
  const overrideMap = overrides || {};
  const changedCount = (diff.columnDiffs || []).length;
  const allRetained = changedCount > 0 && retainedSet.size === changedCount;
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
          {allRetained && (
            <Alert severity="info" sx={{ mb: 1, py: 0, fontSize: '0.72rem' }}>
              Every changed column is being kept, so this row will not be written.
            </Alert>
          )}
          {diff.operation === 'UPDATE' ? (
            <>
              <Table size="small" sx={{ bgcolor: 'rgba(0,0,0,0.3)', borderRadius: 1 }}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ ...mono, fontWeight: 600, width: 40 }} />
                    <TableCell sx={{ ...mono, fontWeight: 600 }}>Column</TableCell>
                    <TableCell sx={{ ...mono, fontWeight: 600 }}>Current</TableCell>
                    <TableCell sx={{ ...mono, fontWeight: 600 }}>New</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(diff.columnDiffs || []).map(columnDiff => {
                    const isRetained = retainedSet.has(columnDiff.column);
                    const canEdit = editable.has(columnDiff.column);
                    return (
                      <TableRow key={columnDiff.column}>
                        <TableCell sx={{ py: 0 }}>
                          <Tooltip
                            title={
                              canEdit
                                ? isRetained
                                  ? 'Keeping the current value — untick to apply the new one'
                                  : 'Applying the new value — tick to keep the current one'
                                : 'This column identifies the row and is always applied'
                            }
                          >
                            <span>
                              <Checkbox
                                size="small"
                                checked={!isRetained}
                                disabled={!canEdit}
                                onChange={() => toggleRetainedColumn(diff.diffId, columnDiff.column)}
                                sx={{ p: 0.25 }}
                              />
                            </span>
                          </Tooltip>
                        </TableCell>
                        <TableCell sx={mono}>{columnDiff.column}</TableCell>
                        <TableCell
                          sx={{
                            ...mono,
                            color: isRetained ? 'success.main' : 'error.main',
                            textDecoration: isRetained ? 'none' : 'line-through',
                          }}
                        >
                          {renderValue(columnDiff.oldValue)}
                        </TableCell>
                        <TableCell
                          sx={{
                            ...mono,
                            color: isRetained ? 'text.disabled' : 'success.main',
                            textDecoration: isRetained ? 'line-through' : 'none',
                          }}
                        >
                          {renderValue(columnDiff.newValue)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
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
                {visibleEntries.map(([column, value]) => {
                  const canEdit = diff.operation === 'INSERT' && editable.has(column);
                  const isOverridden = Object.prototype.hasOwnProperty.call(overrideMap, column);

                  return (
                    <TableRow key={column}>
                      <TableCell sx={{ ...mono, width: '35%' }}>
                        {column}
                        {isOverridden && (
                          <Chip
                            label="edited"
                            size="small"
                            color="info"
                            sx={{ height: 16, fontSize: '0.58rem', ml: 0.5 }}
                          />
                        )}
                      </TableCell>
                      <TableCell sx={mono}>
                        {canEdit ? (
                          <Stack direction="row" spacing={0.5} alignItems="center">
                            <TextField
                              size="small"
                              variant="standard"
                              fullWidth
                              placeholder={renderValue(value)}
                              value={
                                isOverridden
                                  ? overrideMap[column] === null
                                    ? ''
                                    : String(overrideMap[column])
                                  : ''
                              }
                              onChange={e => setOverride(diff.diffId, column, e.target.value)}
                              InputProps={{ sx: { ...mono } }}
                            />
                            {isOverridden ? (
                              <Tooltip title="Revert to the copied value">
                                <IconButton
                                  size="small"
                                  onClick={() => clearOverride(diff.diffId, column)}
                                  sx={{ p: 0.25 }}
                                >
                                  <UndoIcon sx={{ fontSize: 14 }} />
                                </IconButton>
                              </Tooltip>
                            ) : (
                              <Tooltip title="Set this column to NULL">
                                <IconButton
                                  size="small"
                                  onClick={() => setOverride(diff.diffId, column, null)}
                                  sx={{ p: 0.25, fontSize: '0.6rem' }}
                                >
                                  <Typography variant="caption" sx={{ fontSize: '0.6rem' }}>
                                    NULL
                                  </Typography>
                                </IconButton>
                              </Tooltip>
                            )}
                          </Stack>
                        ) : (
                          <Tooltip
                            title={
                              diff.operation === 'INSERT'
                                ? 'Set by the replication — a dimension, generated id, timestamp, match key, or a remapped reference'
                                : ''
                            }
                          >
                            <span style={{ opacity: diff.operation === 'INSERT' ? 0.7 : 1 }}>
                              {renderValue(value)}
                            </span>
                          </Tooltip>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Box>
      </Collapse>
    </Paper>
  );
};

export default React.memo(RowDiffCard);
