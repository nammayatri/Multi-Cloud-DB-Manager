import { useEffect, useMemo, useRef, useState } from 'react';
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
  InputAdornment,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import SendIcon from '@mui/icons-material/Send';
import toast from 'react-hot-toast';
import { queryRequestsAPI, toastNonApiError } from '../../services/api';
import { copyRequestLink, requestLinkFor } from './requestLink';
import SQLEditor from '../Editor/SQLEditor';
import { splitSqlStatements } from '../Editor/SqlHighlight';
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
  /** Handed the new request's group id, so the caller can go and point at it. */
  onSubmitted?: (groupId: string) => void;
}

let keyCounter = 0;
const nextKey = () => `item-${++keyCounter}`;

/**
 * What a prefilled query becomes: split on `;`, and otherwise left alone.
 *
 * Splitting is the right shape here — each row is approved, run and reported on
 * separately, so an approver can pass two statements and hold the third, and a
 * failure names the statement rather than the whole paste.
 *
 * Reformatting is not. The SQL that arrives is the SQL someone wrote and is
 * asking to have run, and rewriting it on the way in means the request shows
 * something they never typed. The row is an ordinary editor with a Format
 * button, for whoever wants it.
 */
const prepareQueries = (query: string): string[] => {
  const statements = splitSqlStatements(query);
  // One statement (or none) means nothing to split — take it as given,
  // semicolon and all.
  return statements.length > 1 ? statements : [query];
};

/** Turn what was prefilled into composer rows, split but not rewritten. */
const buildRows = (
  prefill: ComposerPrefillItem[],
  dbMap: ReturnType<typeof useDatabaseTopology>['dbMap'],
  fallbackDb: string
): ComposerItem[] =>
  prefill.flatMap((item) => {
    const base = defaultTargetFor(dbMap, item.database || fallbackDb);
    const target = {
      database: base.database,
      // Keep a prefilled mode/schema only if it's actually valid there.
      mode: item.mode || base.mode,
      pgSchema: item.pgSchema || base.pgSchema,
    };

    return prepareQueries(item.query).map((query) => ({
      key: nextKey(),
      query,
      ...target,
    }));
  });

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
  /** Set by a submit that couldn't go through — what marks the gaps. */
  const [attempted, setAttempted] = useState(false);
  /**
   * The request that was just raised. The dialog stays open on it rather than
   * closing straight away, because a request exists to be looked at by someone
   * else — and the moment you've written one is the moment you want the link
   * to send them.
   */
  const [submitted, setSubmitted] = useState<{ groupId: string; count: number } | null>(null);

  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const prefill: ComposerPrefillItem[] = useMemo(
    () => (initialItems?.length ? initialItems : [{ query: '' }]),
    [initialItems]
  );

  useEffect(() => {
    if (!open) return;
    setReason(initialReason || '');
    setItems([]);
    setAttempted(false);
    setSubmitted(null);
  }, [open, initialReason]);

  // Seed rows once the topology is available, so any prefilled target that
  // isn't valid for its database can fall back to that database's default.
  useEffect(() => {
    if (!open || items.length > 0) return;

    const fallbackDb = firstDatabase(dbMap);
    if (!fallbackDb) return;

    setItems(buildRows(prefill, dbMap, fallbackDb));
  }, [open, dbMap, items.length, prefill]);

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

  /** Fan one row out into a row per statement, keeping its target. */
  const splitItem = (key: string) =>
    setItems((current) => {
      const row = current.find((it) => it.key === key);
      if (!row) return current;

      const statements = splitSqlStatements(row.query);
      if (statements.length < 2) return current;

      if (current.length - 1 + statements.length > MAX_ITEMS) {
        toast.error(`That would be more than ${MAX_ITEMS} queries in one request`);
        return current;
      }

      return current.flatMap((it) =>
        it.key === key
          ? statements.map((query) => ({ ...it, key: nextKey(), query }))
          : [it]
      );
    });

  /**
   * How many statements each row would split into.
   *
   * `splitSqlStatements` lexes the whole string, and this is read while
   * rendering every row — so without memoising, one keystroke in any row
   * re-lexed all of them.
   */
  const splitCounts = useMemo(
    () => items.map((it) => splitSqlStatements(it.query).length),
    [items]
  );

  const multiple = items.length > 1;
  const trimmedReasonLength = reason.trim().length;
  const filledItems = items.filter((it) => it.query.trim().length > 0);
  const everyRowTargeted = items.every((it) => it.database && it.mode);

  const complete =
    trimmedReasonLength > 0 &&
    items.length > 0 &&
    filledItems.length === items.length &&
    everyRowTargeted;

  const reasonMissing = attempted && trimmedReasonLength === 0;

  /** A row is only marked once submitting has been attempted — not while typing. */
  const rowProblem = (item: ComposerItem) =>
    !attempted ? null : !item.query.trim() ? 'write the SQL for this query' : !item.database || !item.mode ? 'pick a database and target for this query' : null;

  const handleSubmit = async () => {
    if (submitting) return;

    // The button stays live when something is missing, and says what: a
    // disabled button with no explanation leaves you hunting for the reason it
    // won't submit, which on a long request is most of the dialog.
    if (!complete) {
      setAttempted(true);

      if (trimmedReasonLength === 0) {
        reasonRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        reasonRef.current?.focus({ preventScroll: true });
        return;
      }

      const firstBad = items.find((it) => !it.query.trim() || !it.database || !it.mode);
      itemRefs.current[firstBad?.key ?? '']?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    setSubmitting(true);
    try {
      const { groupId } = await queryRequestsAPI.create({
        reason: reason.trim(),
        items: items.map((it) => ({
          query: it.query,
          database: it.database,
          mode: it.mode,
          pgSchema: it.pgSchema,
        })),
      });

      // No toast: the dialog stays open on the request it just raised, and
      // says the same thing there with the link attached.
      setSubmitted({ groupId, count: items.length });
      // Fired now rather than on close, so the list behind is already showing
      // the new request by the time this dialog is done with.
      onSubmitted?.(groupId);
    } catch (error) {
      // The interceptor already toasts the API error, which names the offending
      // row ("Query 3: …") when there's more than one.
      toastNonApiError(error, 'Failed to submit request');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyLink = async () => {
    if (!submitted) return;
    if (await copyRequestLink(submitted.groupId)) {
      toast.success('Link copied');
      return;
    }
    // The link is on screen and selectable, so this only has to point at it.
    toast.error("Couldn't reach the clipboard — select the link above and copy it");
  };

  /*
   * What the dialog becomes once the request is raised.
   *
   * The composer doesn't just close: a request is written to be read by someone
   * else, and the moment you finish writing one is the moment you want the link
   * to send them. Generating it here means the DB Manager's "request approval"
   * flow hands it over too, not only the Requests page.
   */
  if (submitted) {
    const link = requestLinkFor(submitted.groupId);

    return (
      <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
        <DialogTitle>Request submitted</DialogTitle>

        <DialogContent>
          {/* Compact on purpose: the request is raised and you are about to be
              looking at it. All this has left to do is hand over the link. */}
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <Alert severity="success" icon={<CheckCircleIcon fontSize="inherit" />} sx={{ py: 0.25 }}>
              {submitted.count > 1
                ? `${submitted.count} queries are waiting for approval, each approved on its own.`
                : 'Your query is waiting for approval.'}
            </Alert>

            <TextField
              value={link}
              fullWidth
              size="small"
              onFocus={(e) => e.target.select()}
              helperText="Opens the request directly, for anyone allowed to see it."
              // No visible label — the dialog title says what this is — so the
              // field carries its own name for anyone not reading the screen.
              inputProps={{ 'aria-label': 'Link to this request' }}
              InputProps={{
                readOnly: true,
                sx: { fontSize: '0.8125rem' },
                // Beside the thing it copies, rather than away in the footer.
                endAdornment: (
                  <InputAdornment position="end">
                    <Tooltip title="Copy link">
                      <IconButton edge="end" size="small" onClick={handleCopyLink}>
                        <ContentCopyIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </InputAdornment>
                ),
              }}
            />
          </Stack>
        </DialogContent>

        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button variant="contained" onClick={onClose}>
            Done
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={submitting ? undefined : onClose} maxWidth="lg" fullWidth>
      <DialogTitle>{multiple ? `New request — ${items.length} queries` : 'New request'}</DialogTitle>

      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {deniedReason && <Alert severity="info">{deniedReason}</Alert>}

          <Typography variant="body2" color="text.secondary">
            Whoever approves this runs it under their own role. You can edit it later, as
            long as it's still pending. SQL brought in from the editor is split at each
            <code>;</code>, since each query below is approved, run and reported on
            separately — edit any of them, and give each its own target database if they
            differ.
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
            inputRef={reasonRef}
            error={reasonMissing}
            helperText={
              reasonMissing
                ? 'Required — an approver decides on this before they read the SQL'
                : multiple
                  ? `Shared by every query in this request · ${trimmedReasonLength}/${MAX_REASON_LENGTH}`
                  : `${trimmedReasonLength}/${MAX_REASON_LENGTH}`
            }
          />

          <Divider />

          {items.map((item, index) => {
            // Offered per row as well as on the prefill, so SQL pasted in after
            // the dialog opened gets the same treatment.
            const statementCount = splitCounts[index] ?? 1;
            const canSplit = statementCount > 1;
            const problem = rowProblem(item);

            return (
              <Paper
                key={item.key}
                variant="outlined"
                ref={(el: HTMLDivElement | null) => {
                  itemRefs.current[item.key] = el;
                }}
                sx={{ p: 2 }}
              >
                <Stack spacing={1.5}>
                  {(multiple || canSplit) && (
                    <Stack direction="row" alignItems="center" spacing={1}>
                      {multiple && <Typography variant="subtitle2">Query {index + 1}</Typography>}
                      <Box sx={{ flexGrow: 1 }} />
                      {canSplit && (
                        <Button
                          size="small"
                          startIcon={<CallSplitIcon fontSize="small" />}
                          onClick={() => splitItem(item.key)}
                        >
                          Split into {statementCount}
                        </Button>
                      )}
                      {multiple && (
                        <Tooltip title="Remove">
                          <IconButton size="small" onClick={() => removeItem(item.key)}>
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                    </Stack>
                  )}

                  <QueryTargetSelects
                    dbMap={dbMap}
                    loading={loadingConfig}
                    value={{ database: item.database, mode: item.mode, pgSchema: item.pgSchema }}
                    onChange={(next) => updateItem(item.key, next)}
                  />

                  {/* The console's own editor — same highlighting, same Format
                      SQL button. A request is read by whoever approves it, so it
                      deserves the same treatment as a query you run yourself. */}
                  <SQLEditor
                    value={item.query}
                    onChange={(query) => updateItem(item.key, { query })}
                    height={multiple ? 220 : 300}
                  />

                  {problem && (
                    <Typography variant="caption" color="error">
                      Required — {problem}
                    </Typography>
                  )}
                </Stack>
              </Paper>
            );
          })}

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
        {/* Live even when something is missing — pressing it takes you to the
            gap and marks it, which a greyed-out button can't do. */}
        <Button
          variant="contained"
          startIcon={<SendIcon />}
          onClick={handleSubmit}
          disabled={submitting}
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
