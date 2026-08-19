import { Chip, Paper, Stack, TextField, Typography } from '@mui/material';
import type { QueryRequestRecord } from '../../types';

interface QueryPreviewCardProps {
  record: QueryRequestRecord;
  /** e.g. "Query 2" — shown above the card when a request has several. */
  title?: string;
  minRows?: number;
  maxRows?: number;
}

/**
 * A query shown exactly the way the composer shows it: one outlined card
 * holding the target on top and the SQL beneath.
 *
 * Deliberately mirrors RequestComposerDialog's item layout — an approver should
 * be looking at the same thing the requester filled in, not a differently
 * shaped summary of it. Everything is read-only, because the approved bytes are
 * the executed bytes: the hash pin is verified against this SQL before it runs.
 */
const QueryPreviewCard = ({
  record,
  title,
  minRows = 10,
  maxRows = 20,
}: QueryPreviewCardProps) => (
  <Paper variant="outlined" sx={{ p: 2 }}>
    <Stack spacing={1.5}>
      {(title || record.requires_password || record.continue_on_error) && (
        <Stack direction="row" spacing={1} alignItems="center">
          {title && <Typography variant="subtitle2">{title}</Typography>}
          {record.continue_on_error && (
            <Chip size="small" color="warning" variant="outlined" label="Continue on error" />
          )}
          {record.requires_password && (
            <Chip size="small" color="error" variant="outlined" label="Password required" />
          )}
        </Stack>
      )}

      {/* Same three fields as the composer, in the same order — read-only here
          rather than dropdowns, since the target is settled at submission. */}
      <Stack direction="row" spacing={1.5}>
        <TextField
          label="Database"
          value={record.database_name}
          size="small"
          fullWidth
          InputProps={{ readOnly: true }}
        />
        <TextField
          label="Execution mode"
          value={record.execution_mode}
          size="small"
          fullWidth
          InputProps={{ readOnly: true }}
        />
        <TextField
          label="Schema"
          value={record.pg_schema || 'public'}
          size="small"
          fullWidth
          InputProps={{ readOnly: true }}
        />
      </Stack>

      <TextField
        value={record.query}
        multiline
        minRows={minRows}
        maxRows={maxRows}
        fullWidth
        InputProps={{
          readOnly: true,
          sx: { fontFamily: 'monospace', fontSize: '0.8rem' },
        }}
      />
    </Stack>
  </Paper>
);

export default QueryPreviewCard;
