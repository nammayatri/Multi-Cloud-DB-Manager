import React from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Collapse,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import BlurOnIcon from '@mui/icons-material/BlurOn';
import { actionableCount, useConfigReplicateStore } from '../../store/configReplicateStore';
import { ActionableOperation, RowDiff, TableAnalysis, tableKeyOf } from '../../types/configReplicate';
import RowDiffCard from './RowDiffCard';

// Sections stay collapsed by default, but an expanded one can still hold
// thousands of rows (MAX_DIFFS_TOTAL is 20000). Render a slice and let the
// reviewer ask for more rather than mounting every card at once.
const INITIAL_VISIBLE_ROWS = 100;
const VISIBLE_ROW_STEP = 200;

const SECTIONS: Array<{ operation: ActionableOperation | 'NO_CHANGE'; label: string }> = [
  { operation: 'INSERT', label: 'New rows' },
  { operation: 'UPDATE', label: 'Changed rows' },
  { operation: 'DELETE', label: 'Orphaned rows' },
  { operation: 'NO_CHANGE', label: 'Unchanged' },
];

const OpSection = ({
  tableKey,
  label,
  operation,
  diffs,
}: {
  tableKey: string;
  label: string;
  operation: ActionableOperation | 'NO_CHANGE';
  diffs: RowDiff[];
}) => {
  const [open, setOpen] = React.useState(operation !== 'NO_CHANGE');
  const [visible, setVisible] = React.useState(INITIAL_VISIBLE_ROWS);
  // A count, not the Set: re-rendering a section only matters when its own
  // tally changes, and a scalar lets zustand skip the render otherwise.
  const selectedHere = useConfigReplicateStore(s =>
    diffs.reduce((n, d) => n + (s.selectedDiffs.has(d.diffId) ? 1 : 0), 0)
  );
  const selectAllInSection = useConfigReplicateStore(s => s.selectAllInSection);

  if (diffs.length === 0) return null;

  const selectable = operation !== 'NO_CHANGE';
  const allSelected = selectable && selectedHere === diffs.length;
  const someSelected = selectable && selectedHere > 0 && !allSelected;

  return (
    <Box sx={{ mb: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1 }}>
        {selectable ? (
          <Checkbox
            size="small"
            checked={allSelected}
            indeterminate={someSelected}
            onChange={() => selectAllInSection(tableKey, operation as ActionableOperation)}
            sx={{ p: 0.25 }}
          />
        ) : (
          <Box sx={{ width: 28 }} />
        )}
        <IconButton size="small" onClick={() => setOpen(v => !v)} sx={{ p: 0.25 }}>
          {open ? <KeyboardArrowDownIcon fontSize="small" /> : <KeyboardArrowRightIcon fontSize="small" />}
        </IconButton>
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          {label} ({diffs.length})
          {selectable && selectedHere > 0 ? ` — ${selectedHere} selected` : ''}
        </Typography>
      </Box>

      <Collapse in={open} unmountOnExit>
        <Box sx={{ pl: 3, pt: 0.5 }}>
          {diffs.slice(0, visible).map(diff => (
            <RowDiffCard key={diff.diffId} diff={diff} />
          ))}

          {diffs.length > visible && (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 0.5 }}>
              <Button size="small" onClick={() => setVisible(v => v + VISIBLE_ROW_STEP)}>
                Show {Math.min(VISIBLE_ROW_STEP, diffs.length - visible)} more
              </Button>
              <Button size="small" onClick={() => setVisible(diffs.length)}>
                Show all {diffs.length}
              </Button>
              <Typography variant="caption" color="text.secondary">
                showing {visible} of {diffs.length} — the select-all above covers every row,
                shown or not
              </Typography>
            </Stack>
          )}
        </Box>
      </Collapse>
    </Box>
  );
};

const TableSection = ({ table }: { table: TableAnalysis }) => {
  const tableKey = tableKeyOf(table);
  const isOpen = useConfigReplicateStore(s => s.expandedTables.has(tableKey));
  const toggleTable = useConfigReplicateStore(s => s.toggleTable);
  const selectAllInTable = useConfigReplicateStore(s => s.selectAllInTable);
  const deselectAllInTable = useConfigReplicateStore(s => s.deselectAllInTable);
  const opFilter = useConfigReplicateStore(s => s.opFilter);

  const actionable = table.diffs.filter(d => d.operation !== 'NO_CHANGE');
  const selectedHere = useConfigReplicateStore(s =>
    actionable.reduce((n, d) => n + (s.selectedDiffs.has(d.diffId) ? 1 : 0), 0)
  );
  const allSelected = actionable.length > 0 && selectedHere === actionable.length;
  const someSelected = selectedHere > 0 && !allSelected;

  const visible = table.diffs.filter(diff => {
    if (opFilter === 'all') return true;
    if (opFilter === 'AMBIGUOUS') return diff.ambiguous;
    return diff.operation === opFilter;
  });

  return (
    <Paper elevation={0} sx={{ mb: 1.5, border: 1, borderColor: 'divider' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.75 }}>
        <Checkbox
          size="small"
          checked={allSelected}
          indeterminate={someSelected}
          disabled={actionable.length === 0}
          onChange={() => (allSelected ? deselectAllInTable(tableKey) : selectAllInTable(tableKey))}
          sx={{ p: 0.25 }}
        />
        <IconButton size="small" onClick={() => toggleTable(tableKey)} sx={{ p: 0.25 }}>
          {isOpen ? <KeyboardArrowDownIcon fontSize="small" /> : <KeyboardArrowRightIcon fontSize="small" />}
        </IconButton>

        <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 600, flex: 1 }} noWrap>
          {tableKey}
        </Typography>

        {table.matchMethod === 'UNIQUE_KEY' && (
          <Tooltip title={`Matched on unique key: ${table.matchKeyColumns.join(', ') || 'n/a'}`}>
            <Chip
              icon={<VpnKeyIcon sx={{ fontSize: 13 }} />}
              label="Unique key"
              size="small"
              variant="outlined"
              color="success"
              sx={{ height: 20, fontSize: '0.62rem' }}
            />
          </Tooltip>
        )}
        {table.matchMethod === 'SIMILARITY' && (
          <Tooltip title="No unique key contains the dimension column — rows were paired by column similarity, and only on a strict mutual best match.">
            <Chip
              icon={<BlurOnIcon sx={{ fontSize: 13 }} />}
              label="Similarity"
              size="small"
              variant="outlined"
              color="warning"
              sx={{ height: 20, fontSize: '0.62rem' }}
            />
          </Tooltip>
        )}

        <Stack direction="row" spacing={0.5}>
          {table.counts.insert > 0 && (
            <Chip label={`+${table.counts.insert}`} size="small" color="success" sx={{ height: 20, fontSize: '0.65rem' }} />
          )}
          {table.counts.update > 0 && (
            <Chip label={`~${table.counts.update}`} size="small" color="warning" sx={{ height: 20, fontSize: '0.65rem' }} />
          )}
          {table.counts.delete > 0 && (
            <Chip label={`-${table.counts.delete}`} size="small" color="error" sx={{ height: 20, fontSize: '0.65rem' }} />
          )}
          {actionableCount(table) === 0 && !table.error && (
            <Chip label="no changes" size="small" variant="outlined" sx={{ height: 20, fontSize: '0.65rem' }} />
          )}
        </Stack>
      </Box>

      <Collapse in={isOpen} unmountOnExit>
        <Box sx={{ px: 1, pb: 1 }}>
          {table.error && (
            <Alert severity="error" sx={{ mb: 1, fontSize: '0.78rem' }}>
              {table.error}
            </Alert>
          )}

          {table.warnings.map(warning => (
            <Alert key={warning} severity="warning" sx={{ mb: 1, fontSize: '0.78rem' }}>
              {warning}
            </Alert>
          ))}

          {!table.error && (
            <>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5, pl: 1 }}>
                {table.baseRowCount} row(s) at the base value, {table.targetRowCount} at the new value
              </Typography>

              {SECTIONS.map(section => (
                <OpSection
                  key={section.operation}
                  tableKey={tableKey}
                  label={section.label}
                  operation={section.operation}
                  diffs={visible.filter(d => d.operation === section.operation)}
                />
              ))}
            </>
          )}
        </Box>
      </Collapse>
    </Paper>
  );
};

const DiffResultsView = () => {
  const analysis = useConfigReplicateStore(s => s.analysis);

  if (!analysis) return null;

  return (
    <Box>
      {analysis.warnings.map(warning => (
        <Alert key={warning} severity="info" sx={{ mb: 1 }}>
          {warning}
        </Alert>
      ))}

      {analysis.tables.map(table => (
        <TableSection key={tableKeyOf(table)} table={table} />
      ))}
    </Box>
  );
};

export default DiffResultsView;
