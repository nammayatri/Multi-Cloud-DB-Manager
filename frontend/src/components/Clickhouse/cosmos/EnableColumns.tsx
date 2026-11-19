import { useState } from 'react';
import { Box, IconButton, Paper, Popover, Stack, TextField, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import type { CosmosColumnsResponse } from '../../../types/cosmosColumns';

interface EnableColumnsProps {
  data: CosmosColumnsResponse | null;
  batchFull: boolean;
  /** `add` = also put the column into the batch once it is enabled */
  onSetEnabled: (column: string, enabled: boolean, add?: boolean) => void;
}

const listSx = { border: 1, borderColor: 'divider', borderRadius: 1, maxHeight: 360, overflow: 'auto' } as const;
const rowSx = { display: 'flex', alignItems: 'center', gap: 0.5, px: 1.25, py: 0.5, borderBottom: 1, borderColor: 'divider', '&:last-child': { borderBottom: 0 } } as const;
const mono = { fontFamily: 'monospace', overflowWrap: 'anywhere' } as const;

/** The + button: search the not-yet-enabled columns of the selected source, enable them, or enable and add to the batch. */
const EnableColumns = ({ data, batchFull, onSetEnabled }: EnableColumnsProps) => {
  const [query, setQuery] = useState('');
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const disabled = data?.disabled.filter(c => c.name.includes(query.trim().toLowerCase())) ?? [];
  const emptyMessage = () => {
    if (query) return 'No column matches.';
    if (!data?.sourceFound) return `${data?.source.db}.${data?.source.table} has no columns in ClickHouse. Check that the table exists.`;
    return data.enabled.length > 0 ? 'Every column is already enabled.' : 'Every column of this table is already in the config.';
  };

  return (
    <>
      <Tooltip title={data ? `Enable columns of ${data.source.db}.${data.source.table} (${data.disabled.length} not enabled)` : 'Enable columns'}>
        <span>
          <IconButton color="primary" aria-label="Enable columns" disabled={!data} onClick={e => setAnchor(e.currentTarget)} sx={{ border: 1, borderColor: 'divider' }}>
            <AddIcon />
          </IconButton>
        </span>
      </Tooltip>
      {data && (
        <Popover
          open={!!anchor} anchorEl={anchor} onClose={() => setAnchor(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          slotProps={{ paper: { sx: { p: 1.5, width: 400, maxWidth: 'calc(100vw - 32px)' } } }}
        >
          <Stack spacing={1}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="subtitle2">Enable columns · {data.source.db}.{data.source.table}</Typography>
              <Typography variant="caption" color="text.secondary">{data.disabled.length} not enabled · ✓ enable · ⊕ enable &amp; add</Typography>
            </Stack>
            <TextField size="small" autoFocus label="Search columns" value={query} onChange={e => setQuery(e.target.value)} />
            <Paper variant="outlined" sx={listSx}>
              {disabled.length === 0 && <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>{emptyMessage()}</Typography>}
              {disabled.map(c => (
                <Box key={c.name} sx={rowSx}>
                  <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                    <Typography variant="body2" sx={mono}>{c.name}</Typography>
                    <Typography variant="caption" color="text.secondary" sx={mono}>{c.type}</Typography>
                  </Box>
                  {c.locked ? (
                    <Tooltip title={c.hint}><LockOutlinedIcon fontSize="small" color="error" sx={{ mx: 1 }} /></Tooltip>
                  ) : (
                    <>
                      <Tooltip title="Enable">
                        <span><IconButton size="small" color="primary" aria-label={`Enable ${c.name}`} disabled={!data.configTableReady} onClick={() => onSetEnabled(c.name, true)}><CheckCircleOutlineIcon fontSize="small" /></IconButton></span>
                      </Tooltip>
                      <Tooltip title="Enable & add to batch">
                        <span><IconButton size="small" color="primary" aria-label={`Enable and add ${c.name}`} disabled={!data.configTableReady || batchFull} onClick={() => onSetEnabled(c.name, true, true)}><AddCircleOutlineIcon fontSize="small" /></IconButton></span>
                      </Tooltip>
                    </>
                  )}
                </Box>
              ))}
            </Paper>
          </Stack>
        </Popover>
      )}
    </>
  );
};

export default EnableColumns;
