import { Alert, Box, Button, IconButton, MenuItem, Select, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import type { CartItem, TransformType } from '../../../types/cosmosColumns';

interface BatchTableProps {
  items: CartItem[];
  itemErrors: string[][];
  batchErrors: string[];
  maxItems: number;
  busy: boolean;
  canSave: boolean;
  onChange: (index: number, patch: Partial<CartItem>) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
  onApply: () => void;
}

const VISIBLE_ROWS = 5;
const ROW_HEIGHT = 58;
const mono = { fontFamily: 'monospace', fontSize: 12 } as const;

/** The batch: one row per column, editable in place; 5 rows visible, the rest scroll. */
const BatchTable = ({ items, itemErrors, batchErrors, maxItems, busy, canSave, onChange, onRemove, onClear, onApply }: BatchTableProps) => {
  const tables = new Set(items.map(i => i.sourceLabel.split('.').slice(0, 2).join('.'))).size;
  const bad = itemErrors.filter(e => e.length > 0).length;

  return (
    <Stack spacing={1.25}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="overline" color="text.secondary">
          Batch · {items.length} column{items.length === 1 ? '' : 's'}{items.length ? ` from ${tables} table${tables === 1 ? '' : 's'}` : ''}
        </Typography>
        {items.length > 0 && <Button size="small" onClick={onClear}>Clear</Button>}
      </Stack>

      {items.length === 0 ? (
        <Box sx={{ border: 1, borderStyle: 'dashed', borderColor: 'divider', borderRadius: 1, p: 3, textAlign: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            Pick columns in "Target columns" above (press + to enable more). Switch the source table and keep picking: the batch keeps everything.
          </Typography>
        </Box>
      ) : (
        <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 1, maxHeight: 40 + VISIBLE_ROWS * ROW_HEIGHT }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>#</TableCell>
                <TableCell>db</TableCell>
                <TableCell>table</TableCell>
                <TableCell>column</TableCell>
                <TableCell>transform_type</TableCell>
                <TableCell>target_column_type</TableCell>
                <TableCell>target_column</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((item, i) => {
                const option = item.options.find(o => o.transform === item.transformType) ?? item.options[0];
                const errors = itemErrors[i] ?? [];
                const [db, table] = item.sourceLabel.split('.');
                return [
                  <TableRow key={`${item.sourceLabel}-row`} sx={errors.length ? { bgcolor: 'error.light', '& td': { borderBottom: 0 } } : undefined}>
                    <TableCell sx={mono}>{i + 1}</TableCell>
                    <TableCell sx={mono}>{db}</TableCell>
                    <TableCell sx={mono}>{table}</TableCell>
                    <TableCell sx={{ minWidth: 140 }}>
                      <Typography sx={{ ...mono, overflowWrap: 'anywhere' }}>{item.sourceColumn}</Typography>
                      <Typography variant="caption" color="text.secondary">{item.sourceColumnType}</Typography>
                    </TableCell>
                    <TableCell>
                      <Select size="small" value={item.transformType} sx={mono} inputProps={{ 'aria-label': `transform_type for ${item.sourceColumn}` }}
                        onChange={e => {
                          const next = item.options.find(o => o.transform === e.target.value) ?? item.options[0];
                          onChange(i, { transformType: e.target.value as TransformType, targetColumnName: next.suggestedName, targetColumnType: next.targetTypes[0] });
                        }}>
                        {item.options.map(o => <MenuItem key={o.transform} value={o.transform} sx={mono}>{o.transform}</MenuItem>)}
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Select size="small" value={item.targetColumnType} sx={mono} inputProps={{ 'aria-label': `target_column_type for ${item.sourceColumn}` }}
                        onChange={e => onChange(i, { targetColumnType: e.target.value })}>
                        {option.targetTypes.map((t, n) => <MenuItem key={t} value={t} sx={mono}>{t}{n === 0 ? ' ★' : ''}</MenuItem>)}
                      </Select>
                    </TableCell>
                    <TableCell sx={{ minWidth: 220 }}>
                      <TextField size="small" fullWidth value={item.targetColumnName} error={errors.length > 0}
                        inputProps={{ 'aria-label': `target_column for ${item.sourceColumn}`, style: mono }}
                        onChange={e => onChange(i, { targetColumnName: e.target.value })} />
                    </TableCell>
                    <TableCell>
                      <IconButton size="small" aria-label={`Remove ${item.sourceColumn} from batch`} onClick={() => onRemove(i)}><CloseIcon fontSize="small" /></IconButton>
                    </TableCell>
                  </TableRow>,
                  errors.length > 0 && (
                    <TableRow key={`${item.sourceLabel}-err`} sx={{ bgcolor: 'error.light' }}>
                      <TableCell />
                      <TableCell colSpan={7} sx={{ color: 'error.contrastText', fontSize: 12, pt: 0 }}>{errors.join(' · ')}</TableCell>
                    </TableRow>
                  ),
                ];
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {items.length > 0 && (
        <>
          <Typography variant="caption" color="text.secondary">
            ★ = recommended type.{items.length > VISIBLE_ROWS ? ` Showing ${VISIBLE_ROWS} at a time, scroll for the other ${items.length - VISIBLE_ROWS}.` : ''}
          </Typography>
          {batchErrors.map(e => <Alert key={e} severity="error">{e}</Alert>)}
          {bad > 0 && <Alert severity="error">{bad} column{bad > 1 ? 's need' : ' needs'} fixing before the batch can be applied.</Alert>}
          <Stack direction="row" spacing={1} alignItems="center">
            <Button variant="contained" disabled={!canSave || busy} onClick={onApply}>Apply</Button>
            <Typography variant="caption" color="text.secondary">max {maxItems} columns per batch</Typography>
          </Stack>
        </>
      )}
    </Stack>
  );
};

export default BatchTable;
