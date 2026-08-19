import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
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

const MAX_REASON_LENGTH = 1000;

interface EditReasonDialogProps {
  open: boolean;
  onClose: () => void;
  groupId: string;
  currentReason: string;
  /** Number of queries in the request, for the "applies to all" wording. */
  querycount: number;
  onSubmitted?: () => void;
}

/**
 * Change the reason on a request.
 *
 * Separate from revising a query because the scopes differ: the reason belongs
 * to the whole request, a query to itself. Editing it supersedes nothing — it's
 * a straight update, unlike a SQL change which creates a revision.
 */
const EditReasonDialog = ({
  open,
  onClose,
  groupId,
  currentReason,
  querycount,
  onSubmitted,
}: EditReasonDialogProps) => {
  const [reason, setReason] = useState(currentReason);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) setReason(currentReason);
  }, [open, currentReason]);

  const trimmed = reason.trim();
  const canSubmit = trimmed.length > 0 && trimmed !== currentReason.trim() && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;

    setSubmitting(true);
    try {
      const { updated } = await queryRequestsAPI.updateReason(groupId, trimmed);
      toast.success(
        updated === 1 ? 'Reason updated' : `Reason updated on ${updated} pending queries`
      );
      onSubmitted?.();
      onClose();
    } catch (error) {
      // The axios interceptor already toasts API errors.
      toastNonApiError(error, 'Failed to update reason');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={submitting ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Edit reason</DialogTitle>

      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {querycount > 1 && (
            <Alert severity="info" sx={{ py: 0.5 }}>
              Applies to every query in this request that is still pending. Any already
              approved keep the reason they were approved under.
            </Alert>
          )}

          <Typography variant="body2" color="text.secondary">
            This is the first thing an approver reads, so it's worth being specific.
          </Typography>

          <TextField
            label="Why does this need to run?"
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, MAX_REASON_LENGTH))}
            multiline
            minRows={3}
            fullWidth
            required
            autoFocus
            helperText={`${trimmed.length}/${MAX_REASON_LENGTH}`}
          />
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
          {submitting ? 'Saving…' : 'Save reason'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default EditReasonDialog;
