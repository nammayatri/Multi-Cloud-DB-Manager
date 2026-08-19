import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import toast from 'react-hot-toast';
import { queryRequestsAPI, toastNonApiError } from '../../services/api';
import type { QueryRequestRecord } from '../../types';

interface EditRequestDialogProps {
  open: boolean;
  onClose: () => void;
  record: QueryRequestRecord;
  onSubmitted?: () => void;
}

/**
 * Revise one still-pending query.
 *
 * Nothing is overwritten: the backend marks the original SUPERSEDED and adds
 * the revision to the same request, keeping its position. So this is a
 * revision, not an edit — what was first asked for stays on the record.
 *
 * Separate from the composer because the target is fixed (changing it would
 * change what an approver agreed to run against) and a request's shape is set
 * at submission.
 */
const EditRequestDialog = ({ open, onClose, record, onSubmitted }: EditRequestDialogProps) => {
  const [query, setQuery] = useState(record.query);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setQuery(record.query);
    }
  }, [open, record.query]);

  const changed = query.trim() !== record.query.trim();
  const canSubmit = query.trim().length > 0 && changed && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;

    setSubmitting(true);
    try {
      await queryRequestsAPI.update(record.id, {
        query,
        continueOnError: record.continue_on_error,
      });

      toast.success('Revision submitted — the previous version is kept as replaced');
      onSubmitted?.();
      onClose();
    } catch (error) {
      // The axios interceptor already toasts API errors.
      toastNonApiError(error, 'Failed to update request');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={submitting ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle>Revise this query</DialogTitle>

      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Saving adds a revision and marks the current version as replaced — it keeps its
            place in the run order and its expiry, and the original stays visible so approvers
            can see what changed.
            {(record.group_size ?? 1) > 1 &&
              ' The other queries in this request are untouched.'}
          </Typography>

          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Chip size="small" label={`Database: ${record.database_name}`} />
            <Chip size="small" label={`Target: ${record.execution_mode}`} />
            {record.pg_schema && <Chip size="small" label={`Schema: ${record.pg_schema}`} />}
            {record.continue_on_error && (
              <Chip size="small" color="warning" label="Continue on error" />
            )}
          </Stack>

          <TextField
            label="Query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            multiline
            minRows={6}
            maxRows={14}
            fullWidth
            required
            InputProps={{ sx: { fontFamily: 'monospace', fontSize: '0.8rem' } }}
          />

          {/* Read-only here: the reason belongs to the request, not this one
              query, so it's edited from the request itself. */}
          <Box>
            <Typography variant="caption" color="text.secondary">
              Reason (edited from the request)
            </Typography>
            <Typography variant="body2">{record.reason}</Typography>
          </Box>
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          startIcon={<SaveIcon />}
          onClick={handleSubmit}
          disabled={!canSubmit}
        >
          {submitting ? 'Saving…' : 'Save revision'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default EditRequestDialog;
