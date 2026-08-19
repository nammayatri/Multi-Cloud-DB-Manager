import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import SendIcon from '@mui/icons-material/Send';
import toast from 'react-hot-toast';
import { queryRequestsAPI, toastNonApiError } from '../../services/api';
import {
  useDatabaseTopology,
  defaultTargetFor,
  firstDatabase,
  QueryTargetSelects,
} from './queryTargets';
import type { QueryTarget } from './queryTargets';

const MAX_REASON_LENGTH = 1000;
const MAX_ITEMS = 25;

interface ComposerItem extends QueryTarget {
  /** Local-only key so removing a row doesn't remount the others. */
  key: string;
  query: string;
}

export interface ComposerPrefillItem extends Partial<QueryTarget> {
  query: string;
}

interface RequestComposerDialogProps {
  open: boolean;
  onClose: () => void;
  /** Prefilled queries — from a console rejection, or a request being resubmitted. */
  initialItems?: ComposerPrefillItem[];
  initialReason?: string;
  /** The role-policy message the backend returned, shown as context. */
  deniedReason?: string;
  onSubmitted?: () => void;
}

let keyCounter = 0;
const nextKey = () => `item-${++keyCounter}`;

/**
 * Compose a request: one query, or several.
 *
 * There is a single composer because there is a single backend shape — a
 * request is always a list of queries, of length one in the common case. The
 * only thing extra rows buy you is a per-query target: one query runs against
 * exactly one database and cloud, so "the same fix on bpp and bap" needs two
 * rows no matter how the SQL is written. Queries sharing a target are usually
 * better as one row with `;`-separated statements.
 *
 * Each query is approved separately by whoever's role permits that statement.
 */
const RequestComposerDialog = ({
  open,
  onClose,
  initialItems,
  initialReason,
  deniedReason,
  onSubmitted,
}: RequestComposerDialogProps) => {
  const { dbMap, loading: loadingConfig } = useDatabaseTopology(open);

  const [reason, setReason] = useState('');
  const [items, setItems] = useState<ComposerItem[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setReason(initialReason || '');
    setItems([]);
  }, [open, initialReason]);

  // Seed rows once the topology is available, so any prefilled target that
  // isn't valid for its database can fall back to that database's default.
  useEffect(() => {
    if (!open || items.length > 0) return;

    const fallbackDb = firstDatabase(dbMap);
    if (!fallbackDb) return;

    const seed: ComposerPrefillItem[] = initialItems?.length
      ? initialItems
      : [{ query: '' }];

    setItems(
      seed.map((item) => {
        const base = defaultTargetFor(dbMap, item.database || fallbackDb);
        return {
          key: nextKey(),
          query: item.query,
          database: base.database,
          // Keep a prefilled mode/schema only if it's actually valid there.
          mode: item.mode || base.mode,
          pgSchema: item.pgSchema || base.pgSchema,
        };
      })
    );
  }, [open, dbMap, items.length, initialItems]);

  const updateItem = (key: string, patch: Partial<ComposerItem>) =>
    setItems((current) => current.map((it) => (it.key === key ? { ...it, ...patch } : it)));

  const addItem = () =>
    setItems((current) => {
      // Copy the last row's target — consecutive queries usually hit the same
      // database, and when they don't it's one dropdown to change.
      const last = current[current.length - 1];
      const target = last
        ? { database: last.database, mode: last.mode, pgSchema: last.pgSchema }
        : defaultTargetFor(dbMap, firstDatabase(dbMap));

      return [...current, { key: nextKey(), query: '', ...target }];
    });

  const removeItem = (key: string) =>
    setItems((current) => current.filter((it) => it.key !== key));

  const multiple = items.length > 1;
  const trimmedReasonLength = reason.trim().length;
  const filledItems = items.filter((it) => it.query.trim().length > 0);
  const everyRowTargeted = items.every((it) => it.database && it.mode);

  const canSubmit =
    trimmedReasonLength > 0 &&
    items.length > 0 &&
    filledItems.length === items.length &&
    everyRowTargeted &&
    !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;

    setSubmitting(true);
    try {
      await queryRequestsAPI.create({
        reason: reason.trim(),
        items: items.map((it) => ({
          query: it.query,
          database: it.database,
          mode: it.mode,
          pgSchema: it.pgSchema,
        })),
      });

      toast.success(
        multiple
          ? `Request submitted — ${items.length} queries awaiting approval`
          : 'Request submitted — someone with access can now approve it'
      );
      onSubmitted?.();
      onClose();
    } catch (error) {
      // The interceptor already toasts the API error, which names the offending
      // row ("Query 3: …") when there's more than one.
      toastNonApiError(error, 'Failed to submit request');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={submitting ? undefined : onClose} maxWidth="lg" fullWidth>
      <DialogTitle>{multiple ? `New request — ${items.length} queries` : 'New request'}</DialogTitle>

      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {deniedReason && <Alert severity="info">{deniedReason}</Alert>}

          <Typography variant="body2" color="text.secondary">
            Whoever approves this runs it under their own role. You can edit it later, as
            long as it's still pending. Add more queries if they need{' '}
            <strong>different</strong> target databases — queries sharing a target are
            simpler as one row with <code>;</code>-separated statements.
          </Typography>

          <TextField
            label="Why does this need to run?"
            placeholder="e.g. Clearing 3 stuck ride records for ticket NY-4821 — support escalation"
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, MAX_REASON_LENGTH))}
            multiline
            minRows={2}
            fullWidth
            required
            autoFocus
            helperText={
              multiple
                ? `Shared by every query in this request · ${trimmedReasonLength}/${MAX_REASON_LENGTH}`
                : `${trimmedReasonLength}/${MAX_REASON_LENGTH}`
            }
          />

          <Divider />

          {items.map((item, index) => (
            <Paper key={item.key} variant="outlined" sx={{ p: 2 }}>
              <Stack spacing={1.5}>
                {multiple && (
                  <Stack direction="row" alignItems="center" spacing={1}>
                    <Typography variant="subtitle2">Query {index + 1}</Typography>
                    <Box sx={{ flexGrow: 1 }} />
                    <Tooltip title="Remove">
                      <IconButton size="small" onClick={() => removeItem(item.key)}>
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                )}

                <QueryTargetSelects
                  dbMap={dbMap}
                  loading={loadingConfig}
                  value={{ database: item.database, mode: item.mode, pgSchema: item.pgSchema }}
                  onChange={(next) => updateItem(item.key, next)}
                />

                <TextField
                  placeholder="UPDATE rides SET status = 'CANCELLED' WHERE id = '…';"
                  value={item.query}
                  onChange={(e) => updateItem(item.key, { query: e.target.value })}
                  multiline
                  minRows={multiple ? 3 : 6}
                  maxRows={12}
                  fullWidth
                  InputProps={{ sx: { fontFamily: 'monospace', fontSize: '0.8rem' } }}
                />
              </Stack>
            </Paper>
          ))}

          <Box>
            <Button startIcon={<AddIcon />} onClick={addItem} disabled={items.length >= MAX_ITEMS}>
              Add another query
            </Button>
            {items.length >= MAX_ITEMS && (
              <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                Maximum {MAX_ITEMS} per request
              </Typography>
            )}
          </Box>
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          startIcon={<SendIcon />}
          onClick={handleSubmit}
          disabled={!canSubmit}
        >
          {submitting
            ? 'Submitting…'
            : multiple
              ? `Submit ${items.length} queries`
              : 'Submit request'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default RequestComposerDialog;
