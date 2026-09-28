import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  Tooltip,
  ToggleButton,
  ToggleButtonGroup,
  TextField,
  Typography,
  createFilterOptions,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import BlockIcon from '@mui/icons-material/Block';
import RefreshIcon from '@mui/icons-material/Refresh';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import ReplayIcon from '@mui/icons-material/Replay';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import LayersIcon from '@mui/icons-material/Layers';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import HistoryIcon from '@mui/icons-material/History';
import LinkIcon from '@mui/icons-material/Link';
import NotesIcon from '@mui/icons-material/Notes';
import PlaylistAddCheckIcon from '@mui/icons-material/PlaylistAddCheck';
import FormatQuoteIcon from '@mui/icons-material/FormatQuote';
import PersonOutlineIcon from '@mui/icons-material/PersonOutline';
import { formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';
import { queryRequestsAPI, toastNonApiError } from '../../services/api';
import { useAppStore, type ManagerMode } from '../../store/appStore';
import { isSuperRole, type Role } from '../../constants/roles';
import { canSeeMode } from '../Navigation/consoleSections';
import {
  detectDangerousQueries,
  type ValidationWarning,
} from '../../services/queryValidation.service';
import ResultsPanel from '../Results/ResultsPanel';
import RequestComposerDialog from './RequestComposerDialog';
import EditRequestDialog from './EditRequestDialog';
import EditReasonDialog from './EditReasonDialog';
import { copyRequestLink, requestLinkFor } from './requestLink';
import { SqlBlock } from '../Editor/SqlHighlight';
import type { QueryRequestRecord, QueryRequestStatus, QueryResponse, User } from '../../types';

/** Refresh cadence while anything is still pending or in flight. */
const POLL_INTERVAL_MS = 15000;

/**
 * One id for every "a query of yours settled" notice, so the newest replaces
 * the last rather than stacking beside it.
 */
const SETTLED_TOAST_ID = 'query-request-settled';

/** Terminal states — nothing more will happen, so offer a resubmit instead. */
const SETTLED_STATUSES: QueryRequestStatus[] = ['FAILED', 'REJECTED', 'EXPIRED', 'CANCELLED'];

/** Approved and handed to an executor, but not finished. */
const IN_FLIGHT_STATUSES: QueryRequestStatus[] = ['APPROVED', 'RUNNING'];

/**
 * Tighter than the list poll — this one is watching a query actually run,
 * under the eye of someone who just approved it. Most approved queries finish
 * in well under a second, so a slower cadence here is the difference between a
 * result landing as it happens and one that looks stuck.
 */
const RESULT_POLL_MS = 600;

const STATUS_COLOR: Record<
  QueryRequestStatus,
  'default' | 'warning' | 'info' | 'success' | 'error'
> = {
  PENDING: 'warning',
  APPROVED: 'info',
  RUNNING: 'info',
  SUCCEEDED: 'success',
  FAILED: 'error',
  REJECTED: 'error',
  CANCELLED: 'default',
  EXPIRED: 'default',
  SUPERSEDED: 'default',
};

/**
 * A row action reduced to its icon.
 *
 * The query is what a request row is for; a line of labelled buttons under
 * every one competed with it for attention. Approve and reject keep their
 * words — those are decisions, and a decision should be read before it's
 * clicked — but withdrawing, revising, resubmitting and opening a result are
 * self-service and can be recognised from the glyph plus a tooltip.
 */
const IconAction = ({
  title,
  icon,
  onClick,
}: {
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
}) => (
  <Tooltip title={title}>
    <IconButton size="small" onClick={onClick} aria-label={title}>
      {icon}
    </IconButton>
  </Tooltip>
);

const timeAgo = (iso: string) => {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
};

/** Plain monospace block — for the stored JSON summary, which isn't SQL. */
const CodeBlock = ({ children, maxHeight = 200 }: { children: string; maxHeight?: number }) => (
  <Box
    sx={{
      maxHeight,
      overflow: 'auto',
      bgcolor: 'rgba(255,255,255,0.04)',
      border: '1px solid',
      borderColor: 'divider',
      borderRadius: 1,
      p: 1.5,
    }}
  >
    <Typography
      component="pre"
      sx={{
        m: 0,
        fontFamily: 'monospace',
        fontSize: '0.78rem',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {children}
    </Typography>
  </Box>
);

/**
 * The colour a status paints with, as a theme path.
 *
 * `default` covers the statuses with nothing to report — cancelled, expired,
 * replaced — which get the same grey as the frame around them.
 */
const statusAccent = (status: QueryRequestStatus) => {
  const colour = STATUS_COLOR[status];
  return colour === 'default' ? 'divider' : `${colour}.main`;
};

/**
 * Ordered marker for a query inside a request.
 *
 * Carries the identity on its own now that the action buttons no longer repeat
 * the number, so it needs to read as a list marker rather than a stray digit.
 */
const PositionBadge = ({ position, status }: { position: number; status: QueryRequestStatus }) => (
  <Box
    sx={{
      width: 22,
      height: 22,
      flexShrink: 0,
      borderRadius: '50%',
      bgcolor: statusAccent(status),
      color: STATUS_COLOR[status] === 'default' ? 'text.secondary' : 'common.black',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '0.7rem',
      fontWeight: 700,
      lineHeight: 1,
    }}
  >
    {position}
  </Box>
);

interface PersonOption {
  id: string;
  username: string;
  name: string;
}

/**
 * Who raised this — said, not implied.
 *
 * A bare name at the top of a card doesn't say which of the two people on it
 * you're looking at: a reviewed request names its reviewer too, and the footer
 * has always spelled that one out as "Approved by …". So this spells its own
 * out the same way. The handle is the identity that's actually unique, so it
 * stays even when it repeats the display name; the role is left out, since what
 * governs an approval is the approver's role — the query runs as them.
 */
const Requester = ({ record }: { record: QueryRequestRecord }) => (
  <Stack direction="row" spacing={0.75} alignItems="baseline" sx={{ minWidth: 0 }}>
    <Typography sx={{ fontSize: '0.72rem', color: 'text.secondary', flexShrink: 0 }}>
      Requested by
    </Typography>
    <Typography noWrap sx={{ fontSize: '0.95rem', fontWeight: 700, lineHeight: 1.4 }}>
      {record.requester_name || record.requester_username}
    </Typography>
    {record.requester_username && (
      <Typography noWrap sx={{ fontSize: '0.72rem', color: 'text.disabled' }}>
        @{record.requester_username}
      </Typography>
    )}
  </Stack>
);

/**
 * Why this needs to run — the one thing an approver reads before the SQL, so
 * it gets the weight of a heading rather than of a note.
 */
const Reason = ({ children }: { children: string }) => (
  <Box
    sx={{
      borderLeft: '3px solid',
      borderColor: 'primary.main',
      borderRadius: '0 6px 6px 0',
      bgcolor: 'rgba(33,150,243,0.08)',
      px: 1.75,
      py: 1.25,
    }}
  >
    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.5 }}>
      <FormatQuoteIcon sx={{ fontSize: 16, color: 'primary.light' }} />
      <Typography
        sx={{
          fontSize: '0.7rem',
          fontWeight: 700,
          letterSpacing: '.1em',
          lineHeight: 1,
          color: 'primary.light',
        }}
      >
        REASON
      </Typography>
    </Stack>
    <Typography sx={{ fontSize: '1rem', fontWeight: 500, lineHeight: 1.5 }}>{children}</Typography>
  </Box>
);

/**
 * Everyone who appears in a list, in the role given.
 *
 * Read off the records rather than fetched: the user directory
 * (/api/auth/users) is ADMIN-only, while these lists are open to every role
 * that can raise or approve a request. It loses nothing — someone with no
 * request in the list is an option that would filter to nothing anyway.
 */
const peopleIn = (
  records: QueryRequestRecord[],
  as: 'requester' | 'reviewer'
): PersonOption[] => {
  const byId = new Map<string, PersonOption>();

  for (const record of records) {
    const id = as === 'requester' ? record.requester_id : record.reviewer_id;
    if (!id || byId.has(id)) continue;

    const username =
      (as === 'requester' ? record.requester_username : record.reviewer_username) || '';
    const name = (as === 'requester' ? record.requester_name : record.reviewer_name) || username;
    byId.set(id, { id, username, name });
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * Narrow a list to the people picked, keeping whole requests.
 *
 * A request matches if any of its queries does, and then all of its queries
 * are kept: dropping the siblings would strip the context that makes a
 * multi-query request readable, and would hide that a query was reviewed by
 * someone else.
 */
const filterByPeople = (
  records: QueryRequestRecord[],
  requesterId?: string,
  reviewerId?: string
): QueryRequestRecord[] => {
  if (!requesterId && !reviewerId) return records;

  const groups = new Set(
    records
      .filter(
        (r) =>
          (!requesterId || r.requester_id === requesterId) &&
          (!reviewerId || r.reviewer_id === reviewerId)
      )
      .map((r) => r.group_id)
  );

  return records.filter((r) => groups.has(r.group_id));
};

const matchPerson = createFilterOptions<PersonOption>({
  stringify: (option) => `${option.name} ${option.username}`,
});

/** Pick one person out of a list. Typing filters on both name and username. */
const PersonFilter = ({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: PersonOption[];
  value: PersonOption | null;
  onChange: (value: PersonOption | null) => void;
}) => (
  <Autocomplete
    size="small"
    sx={{ width: 168, '& .MuiInputBase-root': { fontSize: '0.8rem' } }}
    // A selection made on another tab may not appear in this one's list; keep
    // it selectable so the filter can be seen and cleared rather than silently
    // matching nothing.
    options={value && !options.some((o) => o.id === value.id) ? [value, ...options] : options}
    value={value}
    onChange={(_e, next) => onChange(next)}
    getOptionLabel={(option) => option.name || option.username}
    isOptionEqualToValue={(option, selected) => option.id === selected.id}
    filterOptions={matchPerson}
    renderInput={(params) => (
      <TextField
        {...params}
        label={label}
        placeholder="Anyone"
        InputProps={{
          ...params.InputProps,
          startAdornment: (
            <>
              <PersonOutlineIcon sx={{ fontSize: 18, color: 'text.disabled', ml: 0.5, mr: 0.25 }} />
              {params.InputProps.startAdornment}
            </>
          ),
        }}
      />
    )}
    renderOption={(props, option) => (
      <li {...props} key={option.id}>
        <Stack>
          <Typography variant="body2">{option.name || option.username}</Typography>
          {option.username && (
            <Typography variant="caption" color="text.secondary">
              @{option.username}
            </Typography>
          )}
        </Stack>
      </li>
    )}
    noOptionsText="Nobody in this list matches"
  />
);

/**
 * Earlier versions of a query, tucked under the current one.
 *
 * Revisions are history, not work: rendering them as sibling rows made a
 * revised query take twice the space of a live one and gave no clue the two
 * were related. Collapsed by default, with the count visible so you know a
 * query was revised without opening anything.
 */
const RevisionHistory = ({ history }: { history: QueryRequestRecord[] }) => {
  const [open, setOpen] = useState(false);

  if (history.length === 0) return null;

  return (
    <Box sx={{ pt: 0.5 }}>
      <Button
        size="small"
        startIcon={<HistoryIcon fontSize="small" />}
        onClick={() => setOpen((v) => !v)}
        sx={{ textTransform: 'none', color: 'text.secondary', py: 0 }}
      >
        {open ? 'Hide' : 'Show'} {history.length} earlier version
        {history.length === 1 ? '' : 's'}
      </Button>

      <Collapse in={open} unmountOnExit>
        <Stack spacing={1} sx={{ mt: 1 }}>
          {history.map((previous) => (
            <Box
              key={previous.id}
              sx={{ opacity: 0.7, borderLeft: '2px solid', borderColor: 'divider', pl: 1.5 }}
            >
              <Typography variant="caption" color="text.secondary">
                Replaced {timeAgo(previous.updated_at || previous.created_at)}
              </Typography>
              <SqlBlock sql={previous.query} maxHeight={200} />
            </Box>
          ))}
        </Stack>
      </Collapse>
    </Box>
  );
};

/**
 * The result, folding open and shut like the request above it.
 *
 * Collapse needs its child mounted for the whole of the closing animation, but
 * the panel drops the result the instant it is hidden — only one is ever held —
 * so the last one seen is kept here until the fold has finished. Without it the
 * open animates and the close snaps.
 */
const ResultFold = ({ open, children }: { open: boolean; children: React.ReactNode }) => {
  const lastShown = useRef<React.ReactNode>(null);
  if (children) lastShown.current = children;

  return (
    <Collapse in={open} unmountOnExit>
      {children ?? lastShown.current}
    </Collapse>
  );
};

/**
 * What a query is actually doing, taking the live execution over the stored row.
 *
 * The request row only settles when the backend watcher next writes to it, so
 * for a second or two after a query has visibly finished the row still says
 * RUNNING. Polling narrows that window but can't close it — the two are
 * different facts arriving at different times.
 *
 * So everything showing a status derives it here instead, from the execution we
 * are already watching. The card header and the result underneath it are then
 * the same answer rather than two answers that agree eventually.
 */
const statusFromLive = (
  record: QueryRequestRecord,
  live: QueryResponse | null,
  liveStatus: 'running' | 'completed' | 'failed' | 'cancelled' | null
): QueryRequestStatus => {
  /*
   * Per-cloud outcomes, which are what actually say whether the query worked.
   *
   * `success` on the response as a whole is only set at the very end, so a
   * partial write carries the cloud's rows with no overall verdict — reading
   * that field too early would call a finished query failed.
   */
  const cloudResults = live
    ? Object.entries(live)
        .filter(([key]) => key !== 'id' && key !== 'success')
        .map(([, value]) => value as { success?: boolean } | undefined)
    : [];

  /*
   * A request runs on one cloud unless its database spans several and the
   * requester chose Multi-Cloud, and the executor saves a cloud's rows only
   * once that cloud has finished every statement. So on a single-cloud request
   * the arrival of the result IS the outcome — the execution's own 'completed'
   * flag is bookkeeping that lands a moment later.
   */
  const isFinal = record.execution_mode !== 'both' && cloudResults.length > 0;
  const running =
    !isFinal && (liveStatus ? liveStatus === 'running' : IN_FLIGHT_STATUSES.includes(record.status));
  if (running) return 'RUNNING';

  const outcome: QueryRequestStatus | null =
    cloudResults.length > 0
      ? cloudResults.every((r) => r?.success !== false)
        ? 'SUCCEEDED'
        : 'FAILED'
      : liveStatus === 'completed'
        ? 'SUCCEEDED'
        : liveStatus === 'failed'
          ? 'FAILED'
          : null;

  // Nothing live to go on — the stored row is all there is, and is right for
  // every query that isn't the one currently being watched.
  return outcome ?? record.status;
};

interface QueryResultViewProps {
  /** The freshly fetched row — its status, error and stored summary. */
  record: QueryRequestRecord;
  /** Rows from the live execution, filling in per cloud as each finishes. */
  live: QueryResponse | null;
  liveStatus: 'running' | 'completed' | 'failed' | 'cancelled' | null;
  progress: {
    currentStatement: number;
    totalStatements: number;
    currentStatementText?: string;
  } | null;
  loading: boolean;
  onClose: () => void;
}

/**
 * What a query did, shown under the query itself.
 *
 * This used to be a dialog. A result belongs to one query, and that query is
 * already on screen inside the request it was approved from — so a modal put
 * the answer somewhere other than the question, covered the rest of the request
 * while an ordered run was still working through it, and had to be dismissed to
 * get back to what you were doing. Rendered in place, the request stays whole:
 * each query carries its own outcome, in run order, wherever the request is
 * being shown — the queue, or the dialog a link opened.
 */
const QueryResultView = ({
  record,
  live,
  liveStatus,
  progress,
  loading,
  onClose,
}: QueryResultViewProps) => {
  // The same derivation the card header uses, so the two can never disagree.
  const displayStatus = statusFromLive(record, live, liveStatus);
  const running = displayStatus === 'RUNNING';

  return (
    <Paper variant="outlined" sx={{ mt: 1, p: 1.5, bgcolor: 'action.hover' }}>
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Chip size="small" color={STATUS_COLOR[displayStatus]} label={displayStatus} />
          <Typography variant="caption" color="text.secondary">
            {record.database_name} · {record.execution_mode}
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          <Button size="small" color="inherit" onClick={onClose}>
            {running ? 'Hide (keeps running)' : 'Hide result'}
          </Button>
        </Stack>

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={22} />
          </Box>
        ) : (
          <>
            {/* Succeeding used to be the one outcome that said nothing: running
                showed progress and failing showed the error, while success just
                left the rows on screen. */}
            {!running && displayStatus === 'SUCCEEDED' && (
              <Alert severity="success" sx={{ py: 0 }}>
                Ran successfully
                {record.reviewer_name || record.reviewer_username
                  ? ` under ${record.reviewer_name || record.reviewer_username}`
                  : ''}
                {record.reviewed_at ? ` · ${timeAgo(record.reviewed_at)}` : ''}.
              </Alert>
            )}

            {/* A result you opened before its query has run. */}
            {displayStatus === 'PENDING' && (
              <Alert severity="info" sx={{ py: 0 }}>
                Not run yet — this query is still waiting for an approver.
              </Alert>
            )}

            {/* The bar is for waiting on a result, so it goes the moment there
                is one. An execution stays 'running' until every cloud has
                reported and its bookkeeping is written, so a fast single-cloud
                query shows its rows well before it is marked done — and a full
                progress bar over a readable result just looks stuck. */}
            {running && !live && (
              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                  {progress
                    ? `Statement ${progress.currentStatement} of ${progress.totalStatements}`
                    : 'Executing…'}
                </Typography>
                <LinearProgress
                  variant={progress?.totalStatements ? 'determinate' : 'indeterminate'}
                  value={
                    progress?.totalStatements
                      ? (progress.currentStatement / progress.totalStatements) * 100
                      : undefined
                  }
                />
                {progress?.currentStatementText && (
                  <SqlBlock sql={progress.currentStatementText} maxHeight={80} />
                )}
              </Box>
            )}

            {/* Only a multi-cloud run gets here: one cloud has reported and
                another hasn't. A single-cloud request is already final. */}
            {running && live && (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size={14} />
                <Typography variant="caption" color="text.secondary">
                  Still running on the other cloud — results so far below
                </Typography>
              </Stack>
            )}

            {!running && record.error && <Alert severity="error">{record.error}</Alert>}

            {/* Partial per-cloud results appear here while the query is still in
                flight — each cloud lands as it finishes. */}
            {live ? (
              <ResultsPanel result={live} />
            ) : record.result_summary ? (
              <>
                <Alert severity="info" sx={{ py: 0 }}>
                  Full result rows have expired. This is the stored summary.
                </Alert>
                <CodeBlock maxHeight={280}>
                  {JSON.stringify(record.result_summary, null, 2)}
                </CodeBlock>
              </>
            ) : (
              !running && (
                <Typography variant="body2" color="text.secondary">
                  No result recorded.
                </Typography>
              )
            )}
          </>
        )}
      </Stack>
    </Paper>
  );
};

/**
 * How a query ended: who decided it, and what happened when it ran.
 *
 * Shared by the row and the single-query card, which were rendering the same
 * three things with slightly different padding.
 */
const QueryOutcome = ({ record }: { record: QueryRequestRecord }) => {
  if (!record.reviewer_username && !record.error && record.status !== 'SUCCEEDED') return null;

  return (
    <>
      {record.reviewer_username && (
        <Typography variant="caption" color="text.secondary">
          {record.status === 'REJECTED' ? 'Rejected' : 'Approved'} by{' '}
          <Box component="span" sx={{ fontWeight: 700, color: 'text.primary' }}>
            {record.reviewer_name || record.reviewer_username}
          </Box>
          {record.review_note ? ` — \u201c${record.review_note}\u201d` : ''}
        </Typography>
      )}
      {/* Said out loud: succeeding used to be the one outcome that only
          changed a chip's colour. */}
      {record.status === 'SUCCEEDED' && (
        <Alert severity="success" sx={{ py: 0, mt: 0.5 }}>
          Ran successfully
          {record.reviewed_at ? ` · ${timeAgo(record.reviewed_at)}` : ''}
        </Alert>
      )}
      {record.error && (
        <Alert severity="error" sx={{ py: 0, mt: 0.5 }}>
          {record.error}
        </Alert>
      )}
    </>
  );
};

interface QueryRowProps {
  record: QueryRequestRecord;
  /** 1-based, as shown to the user. */
  position: number;
  actions?: React.ReactNode;
  /** This query's result, when it's open. Rendered under the query itself. */
  result?: React.ReactNode;
  /**
   * Show or hide this query's result. Lives on the row rather than among the
   * actions, because it decides nothing — and a query that has already run is
   * dimmed and stripped of actions, which is exactly when its result is worth
   * reading.
   */
  onToggleResult?: () => void;
  resultOpen?: boolean;
  /** What approving this query would warn about, when it still can be approved. */
  warning?: ValidationWarning | null;
  /**
   * The status to show, when the live execution knows better than the stored
   * row does — see statusFromLive. Falls back to the row's own.
   */
  liveStatus?: QueryRequestStatus;
  /** Superseded versions of this same query, newest first. */
  history?: QueryRequestRecord[];
}

/**
 * The password an ALTER/DROP-class query needs, asked for where it's approved.
 *
 * The last thing the approve dialog was still there for. A whole modal to
 * collect one field, over a query you had already read on the row behind it,
 * was a lot of ceremony for a text box — so the text box sits with the button
 * it belongs to, and the button stays dead until it has something in it.
 */
const PasswordPrompt = ({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) => (
  <TextField
    type="password"
    size="small"
    label="Your password"
    value={value}
    onChange={(e) => onChange(e.target.value)}
    disabled={disabled}
    required
    autoComplete="current-password"
    sx={{ width: 200 }}
  />
);

/**
 * What approving this query will stop to ask about, said before it's clicked.
 *
 * The same warning the editor puts on Execute, in the same words — so the one
 * query in a request that will interrupt you says so up front, rather than
 * surprising you with a dialog after you'd learned to expect none.
 */
const ApprovalWarning = ({ warning }: { warning: ValidationWarning }) => (
  <Alert severity={warning.type === 'danger' ? 'warning' : 'info'} sx={{ py: 0, mt: 1 }}>
    <strong>{warning.title}</strong> — {warning.message}
  </Alert>
);

/**
 * One query inside a multi-query request.
 *
 * Deliberately not a RequestCard: nesting bordered cards inside a bordered
 * group read as boxes-in-boxes, and repeating the full chrome and SQL block per
 * query turned a request of four into a wall. A numbered row with the SQL
 * collapsed keeps the whole request scannable, and the SQL is on screen before
 * the Approve button is — which is the whole of the guard now.
 */
const QueryRow = ({
  record,
  position,
  actions,
  result,
  onToggleResult,
  resultOpen = false,
  warning = null,
  liveStatus,
  history = [],
}: QueryRowProps) => {
  const status = liveStatus ?? record.status;

  return (
    /*
     * A rail down the left in the status colour.
     *
     * A request of several is read by working out which query is where, and
     * dimming the settled ones answered that by making them harder to read —
     * which is the wrong end of the problem, since a failure is the thing you
     * most want to find. Colour says the same thing at a glance, at full
     * legibility, and says it for all three states rather than just "not this
     * one".
     */
    <Box
      sx={{
        borderTop: '1px solid',
        borderColor: 'divider',
        borderLeft: '3px solid',
        borderLeftColor: statusAccent(status),
        borderTopLeftRadius: 4,
        pt: 1.25,
        pl: 1.25,
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center">
        {/* The request's own chevron, one level down: it opens this query's
            result the way that one opens the request. A query with nothing to
            show keeps the space, so the numbers stay in a column. */}
        {onToggleResult ? (
          <Tooltip title={resultOpen ? 'Hide the result' : 'Show the result'}>
            <IconButton
              size="small"
              sx={{ p: 0.25 }}
              onClick={onToggleResult}
              aria-label={resultOpen ? 'Hide the result' : 'Show the result'}
            >
              {resultOpen ? (
                <ExpandLessIcon fontSize="small" />
              ) : (
                <ExpandMoreIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
        ) : (
          <Box sx={{ width: 24, flexShrink: 0 }} />
        )}

        <PositionBadge position={position} status={status} />

        <Chip
          size="small"
          color={STATUS_COLOR[status]}
          label={status === 'SUPERSEDED' ? 'REPLACED' : status}
        />
        <Chip size="small" variant="outlined" label={`${record.database_name} · ${record.execution_mode}`} />
        {record.requires_password && (
          <Chip size="small" color="error" variant="outlined" label="Password" />
        )}
        {/* On the header line, so a request of several says at a glance which
            of its queries is the one that will interrupt. */}
        {warning && (
          <Chip
            size="small"
            color="warning"
            variant="outlined"
            icon={<WarningAmberIcon />}
            label={warning.title}
          />
        )}
        {history.length > 0 && (
          <Chip size="small" variant="outlined" color="info" label="Revised" />
        )}

        <Box sx={{ flexGrow: 1 }} />
      </Stack>

      <Box sx={{ pl: 3.5, pt: 1 }}>
        <SqlBlock sql={record.query} maxHeight={280} />
        {warning && <ApprovalWarning warning={warning} />}
      </Box>

      <Box sx={{ pl: 3.5 }}>
        <RevisionHistory history={history} />
      </Box>

      <Box sx={{ pl: 3.5, pt: 1 }}>
        <QueryOutcome record={record} />
      </Box>

      {/* `result` itself is the child, so the fold can tell "nothing to show"
          from "showing nothing" and keep the last one through the close. */}
      <ResultFold open={resultOpen}>
        {result && <Box sx={{ pl: 3.5 }}>{result}</Box>}
      </ResultFold>

      {actions && (
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="flex-end" sx={{ pt: 1 }}>
          {actions}
        </Stack>
      )}
    </Box>
  );
};

/**
 * Collapse a flat list into one section per request.
 *
 * Every row carries a group_id — a request is always a group, of one query in
 * the common case — so this always groups, and the single-query case falls out
 * as a section of one that renders as an ordinary card.
 *
 * Keyed on group_id rather than adjacency: members are inserted in one
 * transaction so they normally sort together, but relying on that would break
 * the display the moment an ordering changes.
 */
interface ListSection {
  groupId: string;
  records: QueryRequestRecord[];
}

const timeOf = (iso: string | null | undefined): number => {
  const at = new Date(iso ?? '').getTime();
  return Number.isFinite(at) ? at : 0;
};

/**
 * The latest of some timestamp across a request's queries.
 *
 * A working list orders by `raised`, fixed for a request's whole life. Ordering
 * by last activity meant the very act of approving a query changed the key the
 * list was ordered by, so the request you had just acted on jumped to the top,
 * out from under the cursor, taking the result that had opened inside it.
 *
 * `reviewed` is for the Reviewed log alone, where the point is what was decided
 * most recently — nothing there is waiting to be acted on, so nothing moves
 * under anyone.
 */
const sectionTime = (section: ListSection, by: 'raised' | 'reviewed'): number =>
  section.records.reduce(
    (latest, r) =>
      Math.max(latest, by === 'raised' ? timeOf(r.created_at) : timeOf(r.reviewed_at) || timeOf(r.created_at)),
    0
  );

/**
 * What the editor would warn about in this query, remembered per query.
 *
 * `detectDangerousQueries` strips comments, splits, upper-cases and runs a
 * dozen regexes. It is asked once per rendered row, and while a result is
 * polling the panel re-renders roughly twice a second — so on a queue of
 * twenty that was the bulk of the render. The answer can't change while the
 * SQL doesn't, and `query_hash` is exactly "this SQL, this version".
 */
const dangerCache = new Map<string, ValidationWarning | null>();

const dangerOf = (record: QueryRequestRecord, role: Role | undefined): ValidationWarning | null => {
  const key = `${role ?? ''}:${record.query_hash}`;
  if (!dangerCache.has(key)) {
    dangerCache.set(key, detectDangerousQueries(record.query, role));
  }
  return dangerCache.get(key) ?? null;
};

/** Where a link scrolls to. One per request, on whichever list renders it. */
const groupDomId = (groupId: string) => `request-group-${groupId}`;

const NO_SUCH_REQUEST =
  'There is no request with this id. The link may point at a different environment, or have lost characters on its way here.';

/**
 * Why a link wouldn't open, said in the dialog the link opened.
 *
 * The two that actually happen are worth spelling out, because a bare "403"
 * reads as a bug when it is in fact the rule working: who may see a request
 * follows the query, so a link is not a grant of access.
 */
const linkFailureMessage = (error: unknown): string => {
  const response = (error as { response?: { status?: number; data?: { error?: string; message?: string } } })
    .response;

  if (response?.status === 403) {
    return 'This request isn’t yours to see. A request is visible to whoever raised it, whoever reviewed it, and the roles that could approve it — a link doesn’t change that.';
  }
  if (response?.status === 404) return NO_SUCH_REQUEST;

  return (
    response?.data?.error ||
    response?.data?.message ||
    'Could not open the request from that link.'
  );
};

/**
 * Which of the three pages a linked request belongs on.
 *
 * Your own request is on My requests whatever state it's in — that's where you
 * would go looking for it. Someone else's is on Pending approvals while it
 * still wants a decision you're able to give, and in the log once it doesn't.
 */
/** The three pages a request can actually be listed on. */
type RequestList = Extract<ManagerMode, 'requests' | 'requestsMine' | 'requestsReviewed'>;

const tabForLinkedRequest = (records: QueryRequestRecord[], user: User): RequestList => {
  const live = records.find((r) => r.status !== 'SUPERSEDED') ?? records[0];
  if (live.requester_id === user.id) return 'requestsMine';
  if (records.some((r) => r.status === 'PENDING') && canSeeMode(user.role, 'requests')) {
    return 'requests';
  }
  return 'requestsReviewed';
};

const toSections = (records: QueryRequestRecord[]): ListSection[] => {
  const sections: ListSection[] = [];
  const byGroup = new Map<string, ListSection>();

  for (const record of records) {
    let section = byGroup.get(record.group_id);
    if (!section) {
      section = { groupId: record.group_id, records: [] };
      byGroup.set(record.group_id, section);
      sections.push(section);
    }
    section.records.push(record);
  }

  for (const section of sections) {
    section.records.sort((a, b) => (a.group_position ?? 0) - (b.group_position ?? 0));
  }

  return sections;
};

/** A single-query request. Grouped ones render as QueryRow instead. */
interface RequestCardProps {
  record: QueryRequestRecord;
  /** Rendered on the header line — approve/reject, or cancel on your own request. */
  actions?: React.ReactNode;
  showRequester?: boolean;
  /** Superseded versions of this query, newest first. */
  history?: QueryRequestRecord[];
  /** The SQL and its target fold away; who, why and what state never do. */
  open?: boolean;
  onToggle?: () => void;
  /** Copy a link straight to this request. */
  onCopyLink?: () => void;
  /** This query's result, when it's open. Rendered under the query itself. */
  result?: React.ReactNode;
  /** Show or hide that result. See QueryRow for why it isn't an action. */
  onToggleResult?: () => void;
  resultOpen?: boolean;
  /** What approving this query would warn about, when it still can be approved. */
  warning?: ValidationWarning | null;
  /** See QueryRow: the live execution's verdict, when there is one. */
  liveStatus?: QueryRequestStatus;
}

const RequestCard = ({
  record,
  actions,
  showRequester = true,
  history = [],
  open = false,
  onToggle,
  onCopyLink,
  result,
  onToggleResult,
  resultOpen = false,
  warning = null,
  liveStatus,
}: RequestCardProps) => (
  <Paper variant="outlined" sx={{ p: 2 }}>
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <IconButton
          size="small"
          sx={{ p: 0.25 }}
          onClick={onToggle}
          aria-label={open ? 'Hide the query' : 'Show the query'}
        >
          {open ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>
        {showRequester && <Requester record={record} />}
        <Chip
          size="small"
          color={STATUS_COLOR[liveStatus ?? record.status]}
          label={liveStatus ?? record.status}
        />
        {/* Said on the closed card too — the point is to know before opening. */}
        {warning && (
          <Chip
            size="small"
            color="warning"
            variant="outlined"
            icon={<WarningAmberIcon />}
            label={warning.title}
          />
        )}
        <Box sx={{ flexGrow: 1 }} />
        {/* An amended request is visibly not the one an approver may have
            skimmed earlier. */}
        {record.updated_at && (
          <Chip size="small" variant="outlined" label={`edited ${timeAgo(record.updated_at)}`} />
        )}
        {onCopyLink && (
          <IconAction
            title="Copy a link to this request"
            icon={<LinkIcon fontSize="small" />}
            onClick={onCopyLink}
          />
        )}
        <Typography variant="caption" color="text.secondary">
          {timeAgo(record.created_at)}
        </Typography>
      </Stack>

      {/* Stays out of the fold: the reason is why anyone opens a request at
          all, so a closed one still says what it is for. */}
      <Reason>{record.reason}</Reason>

      <Collapse in={open} unmountOnExit>
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Chip size="small" variant="outlined" label={`DB: ${record.database_name}`} />
            <Chip size="small" variant="outlined" label={`Target: ${record.execution_mode}`} />
            {record.pg_schema && (
              <Chip size="small" variant="outlined" label={`Schema: ${record.pg_schema}`} />
            )}
            {record.continue_on_error && (
              <Chip size="small" color="warning" variant="outlined" label="Continue on error" />
            )}
            {record.requires_password && (
              <Chip size="small" color="error" variant="outlined" label="Password required" />
            )}
          </Stack>

          <SqlBlock sql={record.query} />

          {warning && <ApprovalWarning warning={warning} />}

          <RevisionHistory history={history} />

          <QueryOutcome record={record} />

          {/* The card's own chevron already opened this far, so the result
              gets its own, named — two bare chevrons in one header would say
              nothing about which opened what. */}
          {onToggleResult && (
            <Stack direction="row" spacing={0.5} alignItems="center">
              <IconButton
                size="small"
                sx={{ p: 0.25 }}
                onClick={onToggleResult}
                aria-label={resultOpen ? 'Hide the result' : 'Show the result'}
              >
                {resultOpen ? (
                  <ExpandLessIcon fontSize="small" />
                ) : (
                  <ExpandMoreIcon fontSize="small" />
                )}
              </IconButton>
              <Typography
                variant="caption"
                color="text.secondary"
                onClick={onToggleResult}
                sx={{ cursor: 'pointer', userSelect: 'none' }}
              >
                Result
              </Typography>
            </Stack>
          )}

          <ResultFold open={resultOpen}>{result}</ResultFold>

          {/* Inside the fold, at the foot — the same place a query inside a
              request keeps its actions. Approving is a decision about SQL, so
              the SQL has to be on screen before the button is. */}
          {actions && (
            <Stack direction="row" spacing={1} alignItems="center" justifyContent="flex-end">
              {actions}
            </Stack>
          )}
        </Stack>
      </Collapse>
    </Stack>
  </Paper>
);

const QueryRequestsPanel = ({ onReviewed, active = true }: { onReviewed?: () => void; active?: boolean }) => {
  const user = useAppStore((s) => s.user);

  // The tabs are console pages (see consoleSections), so the header owns which
  // one is open — this panel serves them all and reads the active one. 'linked'
  // is the page a shared link opens, and only exists while one is being
  // followed.
  const managerMode = useAppStore((s) => s.managerMode);
  const setManagerMode = useAppStore((s) => s.setManagerMode);
  const tab: 'pending' | 'mine' | 'reviewed' | 'linked' =
    managerMode === 'requestsMine'
      ? 'mine'
      : managerMode === 'requestsReviewed'
        ? 'reviewed'
        : managerMode === 'requestsLinked'
          ? 'linked'
          : 'pending';

  // Set by ConsolePage from a `?request=` link. Cleared when its page is
  // closed, which is what takes that page out of the header again.
  const linkedRequestGroupId = useAppStore((s) => s.linkedRequestGroupId);
  const setLinkedRequestGroupId = useAppStore((s) => s.setLinkedRequestGroupId);

  /** Which multi-query requests are open. Unlisted ones use the default below. */
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  /**
   * The one request being pointed at — outlined, opened and scrolled to. Set by
   * a link, and by submitting a request, so the thing you just did is the thing
   * you're looking at rather than a row you have to find.
   */
  const [focusedGroupId, setFocusedGroupId] = useState<string | null>(null);
  /**
   * The request a link opened, shown in a dialog of its own.
   *
   * Fetched rather than found in a list, because no list is guaranteed to hold
   * it: `mine` is capped, the queue only carries what you can approve, the log
   * is scoped, and a filter may be hiding it. A dialog sidesteps all of that —
   * you followed a link about one request, so one request is what you get.
   */
  const [linkedSection, setLinkedSection] = useState<ListSection | null>(null);
  const [linkedLoading, setLinkedLoading] = useState(false);
  /** Why the link wouldn't open. Shown where the request would have been. */
  const [linkedError, setLinkedError] = useState<string | null>(null);

  /**
   * A request kept on the pending queue after it stopped being pending.
   *
   * The queue only carries requests with a query still waiting, so approving
   * the last one takes the request off the list — and with it the result that
   * had just opened inside it. Held here until the result is put away, so what
   * you just ran stays where you were looking at it.
   */
  const [heldSection, setHeldSection] = useState<ListSection | null>(null);


  /** The group the view has already been scrolled to, so it only happens once. */
  const scrolledToRef = useRef<string | null>(null);
  /** The link already followed, so its fetch doesn't repeat on every render. */
  const linkHandledRef = useRef<string | null>(null);

  const focusGroup = useCallback((groupId: string) => {
    setFocusedGroupId(groupId);
    setOpenGroups((open) => ({ ...open, [groupId]: true }));
    scrolledToRef.current = null;
  }, []);

  /**
   * Close the link's page, which is what takes it out of the header.
   *
   * Leaves you on the list the request belongs to, so the thing you were just
   * reading is still in front of you — among its neighbours this time.
   */
  const closeLinkedRequest = () => {
    const records = linkedSection?.records;
    if (managerMode === 'requestsLinked') {
      setManagerMode(records && user ? tabForLinkedRequest(records, user) : 'requestsMine');
    }

    setLinkedSection(null);
    setLinkedError(null);
    setLinkedRequestGroupId(null);
    // Forget that this link was followed, so being sent the same one again
    // opens it again rather than doing nothing.
    linkHandledRef.current = null;
  };

  const handleCopyLink = async (groupId: string) => {
    if (await copyRequestLink(groupId)) {
      toast.success('Link copied — it opens this request for anyone allowed to see it');
      return;
    }
    // No clipboard (an insecure context, or permission refused). Hand over the
    // link itself rather than just reporting failure.
    toast.error(`Couldn't reach the clipboard. The link is ${requestLinkFor(groupId)}`, {
      duration: 12000,
    });
  };

  // Shared by Pending and Reviewed — "show me everything from Asha" holds
  // across both. The reviewer filter only means anything once reviewed.
  const [requesterFilter, setRequesterFilter] = useState<PersonOption | null>(null);
  const [reviewerFilter, setReviewerFilter] = useState<PersonOption | null>(null);
  const [reviewedScope, setReviewedScope] = useState<'all' | 'me'>('all');

  // Guard against a stale 'me' scope if the viewer isn't super — the toggle
  // that sets it isn't rendered for them.
  const effectiveReviewedScope = isSuperRole(user?.role) ? reviewedScope : 'all';
  // One composer for every creation path — new, or resubmitted from a settled
  // request. `prefill` is empty for a blank request.
  const [composer, setComposer] = useState<
    { items: { query: string; database: string; mode: string; pgSchema: string }[]; reason: string } | null
  >(null);
  const [editTarget, setEditTarget] = useState<QueryRequestRecord | null>(null);
  const [reasonTarget, setReasonTarget] = useState<{
    groupId: string;
    reason: string;
    queryCount: number;
  } | null>(null);
  const [pending, setPending] = useState<QueryRequestRecord[]>([]);
  const [mine, setMine] = useState<QueryRequestRecord[]>([]);
  const [reviewed, setReviewed] = useState<QueryRequestRecord[]>([]);
  const [loading, setLoading] = useState(true);

  /**
   * Passwords typed against the thing they approve — a query by its id, a
   * whole request by its group id. Held together rather than as one field
   * because the queue can show several password-needing queries at once.
   */
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const passwordFor = (key: string) => passwords[key] ?? '';
  const setPasswordAt = (key: string, value: string) =>
    setPasswords((current) => ({ ...current, [key]: value }));
  /** Forget it the moment it has been used — it is a password. */
  const clearPassword = (key: string) =>
    setPasswords((current) => {
      const { [key]: _gone, ...rest } = current;
      return rest;
    });
  const [rejectTarget, setRejectTarget] = useState<QueryRequestRecord | null>(null);
  const [rejectGroupTarget, setRejectGroupTarget] = useState<ListSection | null>(null);
  const [withdrawGroupTarget, setWithdrawGroupTarget] = useState<ListSection | null>(null);
  /** Rejecting asks for a reason, and won't go through without one. */
  const [reviewNote, setReviewNote] = useState('');
  const [actioning, setActioning] = useState(false);

  /**
   * The one query whose result is open, freshly fetched. Which row that is
   * identifies where the result renders — under that query, wherever the
   * request is being shown.
   */
  const [resultTarget, setResultTarget] = useState<QueryRequestRecord | null>(null);
  const [liveResult, setLiveResult] = useState<QueryResponse | null>(null);
  const [liveStatus, setLiveStatus] = useState<
    'running' | 'completed' | 'failed' | 'cancelled' | null
  >(null);
  const [liveProgress, setLiveProgress] = useState<{
    currentStatement: number;
    totalStatements: number;
    currentStatementText?: string;
  } | null>(null);
  const [resultLoading, setResultLoading] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resultPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const [pendingResponse, mineResponse, reviewedResponse] = await Promise.all([
        queryRequestsAPI.listPending(),
        queryRequestsAPI.listMine(),
        queryRequestsAPI.listReviewed(
          effectiveReviewedScope === 'me' ? { reviewedBy: 'me' } : {}
        ),
      ]);
      setPending(pendingResponse.requests);
      setMine(mineResponse.requests);
      setReviewed(reviewedResponse.requests);
    } catch (error) {
      toastNonApiError(error, 'Failed to load query requests');
    } finally {
      setLoading(false);
    }
  }, [effectiveReviewedScope]);

  // Spinner on first load only; later runs (e.g. the Reviewed filter changing
  // `load`'s identity) refresh in place.
  const loadedOnceRef = useRef(false);
  useEffect(() => {
    load(!loadedOnceRef.current);
    loadedOnceRef.current = true;
  }, [load]);

  /*
   * Say when a query finishes.
   *
   * A failure announced itself — the row turns red and carries the error — but
   * success only changed a chip from RUNNING to SUCCEEDED, which you had to be
   * looking at the right row to notice. Approving hands you a toast saying the
   * query started; this is the other half of that sentence.
   *
   * Only for queries you raised or approved: someone else's run finishing is
   * not your notification.
   */
  const lastStatusRef = useRef<Map<string, QueryRequestStatus> | null>(null);

  useEffect(() => {
    // One query can arrive in more than one list — a request you approved sits
    // in `reviewed`, and stays in `pending` while a sibling waits — so without
    // this it gets announced once per list it turned up in.
    const all = [...new Map([...mine, ...reviewed, ...pending].map((r) => [r.id, r])).values()];
    if (all.length === 0) return;

    const previous = lastStatusRef.current;
    const current = new Map(all.map((r) => [r.id, r.status]));
    lastStatusRef.current = current;

    // The first pass is the baseline — it must not toast a backlog of history.
    if (!previous) return;

    const settledNow = (status: QueryRequestStatus) =>
      all.filter(
        (r) =>
          r.status === status &&
          (r.requester_id === user?.id || r.reviewer_id === user?.id) &&
          previous.has(r.id) &&
          previous.get(r.id) !== status &&
          // The result dialog is already showing this request run, query by
          // query, with its rows. A toast over the top of it is the same news
          // twice — and it is open precisely because you are watching.
          r.group_id !== resultTarget?.group_id
      );

    const succeeded = settledNow('SUCCEEDED');
    const failed = settledNow('FAILED');
    if (succeeded.length === 0 && failed.length === 0) return;

    /*
     * Everything that settled since the last refresh, as one sentence.
     *
     * A request runs query by query, and a refresh can land on several of them
     * at once, so one notice per query stacked a column of them for a single
     * thing happening: the request moved on.
     */
    const notice = (): { text: string; ok: boolean } => {
      const groups = new Set([...succeeded, ...failed].map((r) => r.group_id));

      if (failed.length === 0) {
        const [first] = succeeded;
        const members = all.filter(
          (r) => r.group_id === first.group_id && r.status !== 'SUPERSEDED'
        );
        const total = first.group_size ?? members.length;

        if (
          groups.size === 1 &&
          total > 1 &&
          members.length === total &&
          members.every((r) => r.status === 'SUCCEEDED')
        ) {
          return { text: `Request complete — all ${total} queries ran successfully`, ok: true };
        }

        if (succeeded.length === 1) {
          return {
            text:
              total > 1
                ? `Query ${(first.group_position ?? 0) + 1} succeeded on ${first.database_name} · ${first.execution_mode}`
                : `Query succeeded on ${first.database_name} · ${first.execution_mode}`,
            ok: true,
          };
        }

        return { text: `${succeeded.length} queries succeeded`, ok: true };
      }

      if (failed.length === 1 && succeeded.length === 0) {
        const [only] = failed;
        return {
          text:
            (only.group_size ?? 1) > 1
              ? `Query ${(only.group_position ?? 0) + 1} failed on ${only.database_name} — the rest of the request is on hold`
              : `Query failed on ${only.database_name} · ${only.execution_mode}`,
          ok: false,
        };
      }

      const failures = `${failed.length} ${failed.length === 1 ? 'query' : 'queries'} failed`;
      return {
        text: succeeded.length > 0 ? `${failures}, ${succeeded.length} succeeded` : failures,
        ok: false,
      };
    };

    const { text, ok } = notice();
    // A fixed id, so a run that advances while you watch replaces its own
    // notice instead of growing a stack of them.
    (ok ? toast.success : toast.error)(text, { id: SETTLED_TOAST_ID });
  }, [pending, mine, reviewed, user?.id, resultTarget?.group_id]);

  // A sequential run advances query by query, so a 15s cadence would show it
  // lurching. Tighten only while something is actually executing.
  const anyInFlight = [...pending, ...mine, ...reviewed].some((r) =>
    IN_FLIGHT_STATUSES.includes(r.status)
  );

  /*
   * Poll only while something can still change — a queue of settled requests
   * doesn't need refreshing.
   *
   * `anyInFlight` is part of that, and has to be: a query you approved is in
   * `reviewed`, not in `pending` or `mine`. Without it, approving the last
   * pending query of a request emptied the queue and stopped the poll — while
   * the row it left behind was still RUNNING. The result beside it went on to
   * say SUCCEEDED, because that reads the live execution, which finishes before
   * the backend watcher writes the request row. A request of several hid this:
   * its unapproved siblings kept the queue non-empty, so the poll kept running
   * and the row caught up.
   */
  const hasOpenWork =
    pending.length > 0 || anyInFlight || mine.some((r) => r.status === 'PENDING');

  const pollInterval = anyInFlight ? 3000 : POLL_INTERVAL_MS;

  useEffect(() => {
    // Don't poll while the tab is hidden. The panel stays mounted after its
    // first open (so switching back is instant), but that also meant it kept
    // hitting the API on its interval while the user was on a different tab.
    if (!active || !hasOpenWork) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }

    pollRef.current = setInterval(() => load(), pollInterval);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [active, hasOpenWork, pollInterval, load]);

  // Refresh once when the tab is re-opened after being away — a colleague may
  // have raised a new request while we were on another tab, and the poll above
  // only runs when there's already open work. The initial mount load covers the
  // very first open, so skip that.
  const wasActiveRef = useRef(active);
  useEffect(() => {
    if (active && !wasActiveRef.current) load();
    wasActiveRef.current = active;
  }, [active, load]);

  // Land on whichever list actually has something in it — but only on the very
  // first load. Re-running it later hijacked the tab: changing the Reviewed
  // filter re-runs load(), and for a role that can rarely approve anything
  // `pending` is empty, so every filter click bounced to My requests.
  const landedRef = useRef(false);
  useEffect(() => {
    // A link picks the tab deliberately, and its request may well be one the
    // pending queue doesn't carry — letting this run would bounce off the tab
    // the link just chose.
    if (loading || landedRef.current || linkedRequestGroupId) return;

    landedRef.current = true;
    if (managerMode === 'requests' && pending.length === 0 && mine.length > 0) {
      setManagerMode('requestsMine');
    }
  }, [loading, pending.length, mine.length, managerMode, setManagerMode, linkedRequestGroupId]);

  /*
   * Open the request a link points at.
   *
   * Fetched rather than looked up in the three lists: the backend decides who
   * may see a request (requester, reviewer, a role that could approve it, or a
   * super role), and that set is wider than what any one list returns. This
   * also settles which tab to land on, which can't be known before the request
   * itself is in hand.
   */
  useEffect(() => {
    if (!user || !linkedRequestGroupId) return;
    // A link is followed once. Dismissing it clears the id, so following it
    // again means being sent it again.
    if (linkHandledRef.current === linkedRequestGroupId) return;
    linkHandledRef.current = linkedRequestGroupId;

    let cancelled = false;
    setLinkedLoading(true);
    setLinkedError(null);
    setLinkedSection(null);

    queryRequestsAPI
      // The list says what went wrong, in place of the request. The
      // interceptor's toast would only repeat it.
      .getGroup(linkedRequestGroupId, { silentError: true })
      .then(({ requests }) => {
        if (cancelled) return;
        if (requests.length === 0) {
          setLinkedError(NO_SUCH_REQUEST);
          return;
        }
        setLinkedSection({ groupId: linkedRequestGroupId, records: requests });
        // Open: it is the only thing on its page, and it is what was asked for.
        setOpenGroups((open) => ({ ...open, [linkedRequestGroupId]: true }));
      })
      .catch((error) => {
        if (cancelled) return;
        setLinkedError(linkFailureMessage(error));
      })
      .finally(() => {
        if (!cancelled) setLinkedLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user, linkedRequestGroupId, setManagerMode]);

  /*
   * Keep the linked and held requests in step with the lists.
   *
   * Both are copies the panel holds itself rather than reads from a list, and
   * both are being acted on in place — so a query running inside one leaves it
   * saying PENDING under a result that had already failed. Refetched rather
   * than patched from the lists, because neither is guaranteed to be in one:
   * the linked request may be outside every list this viewer sees, and the held
   * one is held precisely because it has just left the queue.
   */
  const linkedGroupId = linkedSection?.groupId;
  const heldGroupId = heldSection?.groupId;

  useEffect(() => {
    const ids = [...new Set([linkedGroupId, heldGroupId].filter(Boolean) as string[])];
    if (ids.length === 0) return;

    let cancelled = false;
    void Promise.all(
      ids.map((id) =>
        queryRequestsAPI
          .getGroup(id, { silentError: true })
          .then(({ requests }) => [id, requests] as const)
          // Whatever we have stays on screen; the lists behind are the
          // authority on whether the request still exists.
          .catch(() => null)
      )
    ).then((results) => {
      if (cancelled) return;
      for (const result of results) {
        if (!result) continue;
        const [id, records] = result;
        if (records.length === 0) continue;

        const patch = (current: ListSection | null) =>
          current && current.groupId === id ? { ...current, records } : current;

        setLinkedSection(patch);
        setHeldSection(patch);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [linkedGroupId, heldGroupId, pending, mine, reviewed]);

  // Scroll to the focused request once it's actually on screen. It may take a
  // render or two to get there — the list it belongs to might still be loading,
  // or the tab may be mid-switch — so this waits for the row rather than
  // scrolling to nothing.
  useEffect(() => {
    if (!focusedGroupId || scrolledToRef.current === focusedGroupId) return;

    const row = document.getElementById(groupDomId(focusedGroupId));
    if (!row) return;

    scrolledToRef.current = focusedGroupId;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusedGroupId, tab, loading, pending, mine, reviewed, linkedSection]);

  /**
   * Approve one query, with the password if it needs one.
   *
   * There is no dialog in front of this any more: the row already shows the
   * SQL, says what is alarming about it, and carries the field for the
   * password. Pressing the button is the decision.
   */
  const approveFromRow = (record: QueryRequestRecord) => {
    const password = passwordFor(record.id);
    if (record.requires_password && !password) return;

    clearPassword(record.id);
    return approveRecord(record, { password });
  };

  /** The same, for the whole request run in order. */
  const approveGroupFromRow = (section: ListSection) => {
    const key = `group:${section.groupId}`;
    const password = passwordFor(key);
    const needsPassword = section.records.some(
      (r) => r.status === 'PENDING' && r.can_approve !== false && r.requires_password
    );
    if (needsPassword && !password) return;

    clearPassword(key);
    return approveGroupInOrder(section, { password });
  };

  const openReject = (record: QueryRequestRecord) => {
    setRejectTarget(record);
    setReviewNote('');
  };

  const openRejectGroup = (section: ListSection) => {
    setRejectGroupTarget(section);
    setReviewNote('');
  };

  /**
   * Approve one query and hand over to its result.
   *
   * Approving is now a single click on the row, so this has one caller — but it
   * stays separate from it because it is also what the ordered-run path reports
   * through, and both have to hand over to the result the same way.
   */
  const approveRecord = async (
    record: QueryRequestRecord,
    review: { password?: string } = {}
  ) => {
    setActioning(true);
    try {
      await queryRequestsAPI.approve(record.id, {
        password: review.password || undefined,
        // Approve exactly what's on screen — 409s if the requester amended it
        // after this card was loaded.
        expectedHash: record.query_hash,
      });
      toast.success('Approved — the query is now running under your role');

      // Hand straight over to the result rather than making the approver hunt
      // for what they just ran — and keep the request on the queue while they
      // read it, since approving its last pending query is exactly what drops
      // it from the list the result is rendered in.
      if (tab === 'pending') void holdOnQueue(record);
      openResult(record);
      load();
    } catch (error) {
      toastNonApiError(error, 'Failed to approve request');
      // Most likely cause is a lost race (409) — refresh so the entry someone
      // else already actioned stops showing up as actionable.
      await load();
    } finally {
      setActioning(false);
      // The approvable count just changed (approved, or lost the race) — let the
      // parent refresh the tab badge.
      onReviewed?.();
    }
  };

  /** Approve every pending query in a request and run them in order. */
  const approveGroupInOrder = async (
    section: ListSection,
    review: { password?: string } = {}
  ) => {
    setActioning(true);
    try {
      const { queued } = await queryRequestsAPI.approveGroup(section.groupId, {
        password: review.password || undefined,
      });

      toast.success(`Running ${queued} queries in order under your role`);

      // Straight to the result, the way approving a single query does — an
      // ordered run is exactly the case where you want to watch it happen. The
      // open result follows the run from one query to the next as it advances.
      const firstQuery = [...section.records]
        .filter((r) => r.status !== 'SUPERSEDED')
        .sort((a, b) => (a.group_position ?? 0) - (b.group_position ?? 0))[0];

      if (firstQuery) {
        if (tab === 'pending') void holdOnQueue(firstQuery);
        openResult(firstQuery);
      }
      await load();
    } catch (error) {
      toastNonApiError(error, 'Failed to approve request');
      await load();
    } finally {
      setActioning(false);
      onReviewed?.();
    }
  };

  const handleReject = async () => {
    if (!rejectTarget || reviewNote.trim().length < 3) return;

    setActioning(true);
    try {
      await queryRequestsAPI.reject(rejectTarget.id, reviewNote.trim());
      toast.success('Request rejected');
      setRejectTarget(null);
      await load();
    } catch (error) {
      toastNonApiError(error, 'Failed to reject request');
      await load();
    } finally {
      setActioning(false);
      onReviewed?.();
    }
  };

  const handleRejectGroup = async () => {
    if (!rejectGroupTarget || reviewNote.trim().length < 3) return;

    setActioning(true);
    try {
      const { rejected, skipped } = await queryRequestsAPI.rejectGroup(
        rejectGroupTarget.groupId,
        reviewNote.trim()
      );

      toast.success(
        skipped > 0
          ? `Rejected ${rejected} queries · ${skipped} left for someone with the right role`
          : `Rejected ${rejected} queries`
      );
      setRejectGroupTarget(null);
      await load();
    } catch (error) {
      toastNonApiError(error, 'Failed to reject request');
      await load();
    } finally {
      setActioning(false);
      onReviewed?.();
    }
  };

  const handleWithdrawGroup = async () => {
    if (!withdrawGroupTarget) return;

    setActioning(true);
    try {
      const { cancelled } = await queryRequestsAPI.cancelGroup(withdrawGroupTarget.groupId);
      toast.success(`Withdrew ${cancelled} ${cancelled === 1 ? 'query' : 'queries'}`);
      setWithdrawGroupTarget(null);
      await load();
    } catch (error) {
      toastNonApiError(error, 'Failed to withdraw request');
      await load();
    } finally {
      setActioning(false);
    }
  };

  const handleCancel = async (record: QueryRequestRecord) => {
    try {
      await queryRequestsAPI.cancel(record.id);
      toast.success('Request withdrawn');
      await load();
    } catch (error) {
      toastNonApiError(error, 'Failed to withdraw request');
    }
  };

  const stopResultPoll = useCallback(() => {
    if (resultPollRef.current) {
      clearInterval(resultPollRef.current);
      resultPollRef.current = null;
    }
  }, []);

  /** Returns true once there's nothing left to wait for. */
  const fetchResult = useCallback(async (id: string): Promise<boolean> => {
    const { request, live } = await queryRequestsAPI.getResult(id);
    setResultTarget(request);
    setLiveResult(live?.result || null);
    setLiveStatus(live?.status || null);
    setLiveProgress(live?.progress || null);

    // Prefer the live execution: the request row only settles when the backend
    // watcher next polls, up to ~2s behind.
    return live ? live.status !== 'running' : !IN_FLIGHT_STATUSES.includes(request.status);
  }, []);

  /**
   * The rest of the request, in run order — used to follow an ordered run from
   * one query to the next as it advances.
   */
  const fetchGroupMembers = useCallback(async (groupId: string) => {
    try {
      const { requests } = await queryRequestsAPI.getGroup(groupId);
      return requests
        .filter((r) => r.status !== 'SUPERSEDED')
        .sort((a, b) => (a.group_position ?? 0) - (b.group_position ?? 0));
    } catch {
      // Non-critical: the open query's own result still loads and polls.
      return null;
    }
  }, []);

  /**
   * Show one query's result, following it while it runs.
   *
   * `spinner` blanks the panel while the first result loads. Handing over to
   * the next query of an ordered run passes false: the status and target come
   * from the record we already hold, so replacing a result you can read with a
   * spinner only makes the handover feel like a page load.
   */
  const showResultRef = useRef<((record: QueryRequestRecord) => void) | null>(null);

  const showResult = useCallback(
    async (record: QueryRequestRecord, spinner = false) => {
      stopResultPoll();
      setResultTarget(record);
      setLiveResult(null);
      setLiveStatus(null);
      setLiveProgress(null);
      if (spinner) setResultLoading(true);

      const multiple = (record.group_size ?? 1) > 1;

      try {
        const settled = await fetchResult(record.id);

        // Whether we're watching this one execute, as opposed to reading a
        // finished one. Only a watched query hands over to the next.
        const following = !settled;

        // Nothing left to watch: this query is done, and so is every sibling
        // that might have taken over from it. Opening a finished result used
        // to cost a probe tick to learn what the record already said.
        const siblingRunning = (record.group_statuses ?? []).some((e) =>
          IN_FLIGHT_STATUSES.includes(e.status)
        );
        if (settled && (!multiple || !siblingRunning)) return;

        // Still running — follow it. Partial per-cloud results land as each
        // cloud finishes, so the panel fills in progressively. In a request of
        // several, keep going until the whole run is done: approving in order
        // starts the next query as this one finishes, and the result should
        // move down to it rather than freeze on the one that's through.
        resultPollRef.current = setInterval(async () => {
          try {
            // Concurrently: the group listing is only read after both land, so
            // making it wait on the result doubled the time each tick takes.
            const [done, group] = await Promise.all([
              fetchResult(record.id),
              multiple ? fetchGroupMembers(record.group_id) : Promise.resolve(null),
            ]);
            const groupBusy = !!group?.some((r) => IN_FLIGHT_STATUSES.includes(r.status));

            // An ordered run starts the next query the moment this one ends, so
            // follow it across rather than leaving the finished query on screen
            // for the user to notice and click past.
            if (done && following && group) {
              const next = group.find((r) => IN_FLIGHT_STATUSES.includes(r.status));
              if (next && next.id !== record.id) {
                stopResultPoll();
                showResultRef.current?.(next);
                return;
              }
            }

            if (done && !groupBusy) {
              stopResultPoll();
              load();
            }
          } catch {
            stopResultPoll();
          }
        }, RESULT_POLL_MS);
      } catch (error) {
        toastNonApiError(error, 'Failed to load result');
      } finally {
        if (spinner) setResultLoading(false);
      }
    },
    [fetchResult, load, fetchGroupMembers, stopResultPoll]
  );

  // Lets the poll above hand over to the next query without showResult having
  // to depend on itself.
  useEffect(() => {
    showResultRef.current = (record) => {
      void showResult(record);
    };
  }, [showResult]);

  const openResult = useCallback(
    async (record: QueryRequestRecord) => {
      // The result renders inside the request, so the request has to be open
      // for it to be anywhere at all.
      setOpenGroups((open) => ({ ...open, [record.group_id]: true }));
      // Opening is the one case with nothing on screen yet to preserve.
      await showResult(record, true);
    },
    [showResult]
  );

  const closeResult = useCallback(() => {
    stopResultPoll();
    setResultTarget(null);
    // The request was only being kept on the queue to carry this result.
    setHeldSection(null);
  }, [stopResultPoll]);

  /**
   * Keep a just-run request on the pending queue while its result is open.
   *
   * Approving the last pending query of a request drops it out of the queue —
   * the endpoint only returns requests with something still waiting — which
   * took the row, and the result that had just opened inside it, off screen the
   * moment it had something to say.
   */
  const holdOnQueue = useCallback(
    async (record: QueryRequestRecord) => {
      const members = await fetchGroupMembers(record.group_id);
      setHeldSection({ groupId: record.group_id, records: members ?? [record] });
    },
    [fetchGroupMembers]
  );

  /** The eye on a row that has run: show its result, or put it away again. */
  const toggleResult = (record: QueryRequestRecord) => {
    if (resultTarget?.id === record.id) {
      closeResult();
      return;
    }
    void openResult(record);
  };

  useEffect(() => stopResultPoll, [stopResultPoll]);

  // A held request is a courtesy to the queue you were reading. Leaving that
  // page ends it — the request is settled, and Reviewed is where it lives now.
  useEffect(() => {
    if (tab !== 'pending') setHeldSection(null);
  }, [tab]);

  // Filtered in the browser rather than server-side: the queue is already
  // fully loaded and capped, so this is instant and costs no round trip.
  // The pending payload carries whole requests, so it includes settled and
  // not-yours rows for context. Counts must reflect what you can actually act on.
  const actionablePendingCount = useMemo(
    () => pending.filter((r) => r.status === 'PENDING' && r.can_approve !== false).length,
    [pending]
  );

  const pendingRequesters = useMemo(() => peopleIn(pending, 'requester'), [pending]);
  /** Whose requests this tab can be filtered to. My requests are all yours. */
  const reviewedRequesters = useMemo(() => peopleIn(reviewed, 'requester'), [reviewed]);
  const tabRequesters =
    tab === 'pending' ? pendingRequesters : tab === 'reviewed' ? reviewedRequesters : [];
  const reviewedReviewers = useMemo(() => peopleIn(reviewed, 'reviewer'), [reviewed]);

  const filteredPending = useMemo(
    () => filterByPeople(pending, requesterFilter?.id),
    [pending, requesterFilter]
  );

  /**
   * The queue, plus a request being held on it because its result is open.
   * Appended rather than merged: if the queue still carries it — because a
   * sibling is pending — there is nothing to hold it for.
   */
  const pendingView = useMemo(() => {
    if (!heldSection) return filteredPending;
    if (filteredPending.some((r) => r.group_id === heldSection.groupId)) return filteredPending;
    return [...filteredPending, ...heldSection.records];
  }, [filteredPending, heldSection]);

  const filteredReviewed = useMemo(
    () => filterByPeople(reviewed, requesterFilter?.id, reviewerFilter?.id),
    [reviewed, requesterFilter, reviewerFilter]
  );

  if (!user) return null;

  /**
   * The live verdict for the one query being watched, so its header settles at
   * the same instant its result does rather than a poll later.
   */
  const liveStatusFor = (record: QueryRequestRecord) =>
    resultTarget?.id === record.id
      ? statusFromLive(resultTarget, liveResult, liveStatus)
      : undefined;

  /**
   * This query's result, when it's the one open. Handed to every row, so the
   * result appears wherever that row is being rendered — in the queue, or in
   * the dialog a link opened.
   */
  const resultFor = (record: QueryRequestRecord) =>
    resultTarget?.id === record.id ? (
      <QueryResultView
        record={resultTarget}
        live={liveResult}
        liveStatus={liveStatus}
        progress={liveProgress}
        loading={resultLoading}
        onClose={closeResult}
      />
    ) : null;

  /**
   * Render a list, wrapping grouped members in a shared frame so it's obvious
   * they were submitted together — and that each one is still approved on its
   * own. Used by all three tabs; only the footer actions differ.
   */
  const renderSections = (
    records: QueryRequestRecord[],
    options: {
      actionsFor?: (record: QueryRequestRecord) => React.ReactNode;
      /** Rendered on the request header — only when the viewer can action every query in it. */
      groupActionsFor?: (section: ListSection) => React.ReactNode;
      /** Rows that are context rather than content: shown, but not actionable. */
      contextFor?: (record: QueryRequestRecord) => boolean;
      showRequester?: boolean;
      /**
       * What the list is ordered by. 'raised' keeps every request in a fixed
       * place; 'reviewed' is for the log, where the most recent decision leads.
       */
      orderBy?: 'raised' | 'reviewed';
    } = {}
  ) => {
    const {
      actionsFor,
      groupActionsFor,
      contextFor,
      showRequester = true,
      orderBy = 'raised',
    } = options;

    /** Whether this query is this viewer's to act on right now. */
    const rowActionable = (record: QueryRequestRecord) =>
      record.status !== 'SUPERSEDED' &&
      (contextFor ? !contextFor(record) : record.can_approve !== false);

    /**
     * What approving this query would warn about — the editor's own test, so
     * the two read as one rule. Only worth saying about a query that can still
     * be approved; on one that has run it describes a decision nobody is being
     * asked to make.
     */
    const warningFor = (record: QueryRequestRecord) =>
      record.status === 'PENDING' && rowActionable(record)
        ? dangerOf(record, user?.role)
        : null;

    // Newest first, always: the queue is read top-down and the news is at the
    // top. A sort control bought nothing here — nobody asks for the stalest
    // request first, and the request you just raised is the one you look for.
    const sections = toSections(records).sort(
      (a, b) => sectionTime(b, orderBy) - sectionTime(a, orderBy)
    );

    /**
     * Every request carries the anchor a link scrolls to, and the one being
     * pointed at is outlined. A view that jumped somewhere without saying why
     * is a view you have to read twice to trust.
     */
    const anchor = (groupId: string, card: React.ReactNode) => (
      <Box
        key={groupId}
        id={groupDomId(groupId)}
        sx={{
          borderRadius: 1,
          scrollMarginTop: 16,
          outline: groupId === focusedGroupId ? '2px solid' : 'none',
          outlineColor: 'primary.main',
        }}
      >
        {card}
      </Box>
    );

    return (
      <Stack spacing={2}>
        {sections.map((section) => {
          // A revision shares its predecessor's position, so collapse each
          // position into one live query plus the versions it replaced. Without
          // this the two render as unrelated sibling rows.
          const byPosition = new Map<
            number,
            { current?: QueryRequestRecord; history: QueryRequestRecord[] }
          >();

          for (const record of section.records) {
            const position = record.group_position ?? 0;
            const entry = byPosition.get(position) ?? { history: [] };
            if (record.status === 'SUPERSEDED') {
              entry.history.push(record);
            } else {
              entry.current = record;
            }
            byPosition.set(position, entry);
          }

          const rows = [...byPosition.entries()]
            .sort(([a], [b]) => a - b)
            .map(([position, entry]) => {
              // Newest first, and fall back to the latest superseded row if a
              // live one somehow isn't in this payload.
              const ordered = [...entry.history].reverse();
              return {
                position: position + 1,
                record: entry.current ?? ordered[0],
                history: entry.current ? ordered : ordered.slice(1),
              };
            })
            .filter(row => !!row.record);

          const first =
            section.records.find(r => r.status !== 'SUPERSEDED') ?? section.records[0];
          const total = first.group_size ?? rows.length;

          // A request of one query is presented as an ordinary request — the
          // group framing would be noise. This is the only place the
          // single-vs-multiple distinction exists; the backend has none.
          //
          // `total` counts live queries, so a revised single-query request has
          // total 1 but two rows (the replaced one and its replacement). It
          // needs the framed layout, or the card would render the superseded
          // version and hide the revision entirely.
          if (total === 1 && rows.length === 1) {
            const [only] = rows;
            return anchor(
              section.groupId,
              <RequestCard
                record={only.record}
                history={only.history}
                showRequester={showRequester}
                actions={actionsFor?.(only.record)}
                open={openGroups[section.groupId] ?? false}
                onToggle={() =>
                  setOpenGroups((open) => ({
                    ...open,
                    [section.groupId]: !(open[section.groupId] ?? false),
                  }))
                }
                onCopyLink={() => handleCopyLink(section.groupId)}
                result={resultFor(only.record)}
                onToggleResult={
                  only.record.execution_id ? () => toggleResult(only.record) : undefined
                }
                resultOpen={resultTarget?.id === only.record.id}
                warning={warningFor(only.record)}
                liveStatus={liveStatusFor(only.record)}
              />
            );
          }

          // Status rollup, so the state of a request is readable without
          // scanning every query in it.
          // Roll up the WHOLE request, not just the rows in this list. The
          // pending queue only returns PENDING queries, so counting visible
          // rows hid the fact that an earlier query had already failed.
          const allStatuses =
            first.group_statuses ??
            section.records
              .filter(r => r.status !== 'SUPERSEDED')
              .map(r => ({
                position: r.group_position ?? 0,
                status: r.status,
              }));

          const counts = new Map<QueryRequestStatus, number>();
          for (const entry of allStatuses) {
            counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
          }

          // Queries not shown here are either already actioned, or pending but
          // outside this viewer's role. Conflating the two claimed a failed
          // query "needs a role you don't have".
          const shownPositions = new Set(rows.map(r => r.position - 1));
          const missing = allStatuses.filter(e => !shownPositions.has(e.position));
          const settledElsewhere = missing.filter(e => e.status !== 'PENDING');
          const failedElsewhere = settledElsewhere.filter(e => e.status === 'FAILED');

          // Pending but not this viewer's to action — either absent from the
          // payload, or present and flagged. Group-level actions need all of
          // them to be actionable, since running out of order isn't allowed.
          const notPermitted = [
            ...missing.filter(e => e.status === 'PENDING'),
            ...rows
              .map(r => r.record)
              .filter(r => r.status === 'PENDING' && r.can_approve === false),
          ];

          // One toggle for the whole request, not one per query: the queries in
          // a request are read together, and a chevron on each turned opening a
          // request of four into four clicks. Closed by default, like a
          // single-query request — the header and reason say enough to decide
          // whether to open it.
          const groupOpen = openGroups[section.groupId] ?? false;

          // What the run came to. Counting positions rather than visible rows,
          // so a queue that only returns pending queries still reports the ones
          // that already ran.
          const succeededCount = counts.get('SUCCEEDED') ?? 0;
          const failedPositions = allStatuses
            .filter((e) => e.status === 'FAILED')
            .map((e) => e.position + 1);

          const outcome =
            succeededCount === total
              ? {
                  severity: 'success' as const,
                  message: `All ${total} ${total === 1 ? 'query' : 'queries'} ran successfully.`,
                }
              : failedPositions.length > 0
                ? {
                    severity: 'error' as const,
                    message: `${
                      failedPositions.length === 1 ? 'Query' : 'Queries'
                    } ${failedPositions.join(', ')} failed — ${succeededCount} of ${total} succeeded.`,
                  }
                : succeededCount > 0
                  ? {
                      severity: 'info' as const,
                      message: `${succeededCount} of ${total} run so far.`,
                    }
                  : null;

          return anchor(
            section.groupId,
            // A plain card, like a single-query request: the header says how
            // many queries are in it and folds them away, which a tinted blue
            // frame was doing at the cost of shouting across the list.
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Stack spacing={1.25}>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <IconButton
                    size="small"
                    sx={{ p: 0.25 }}
                    onClick={() =>
                      setOpenGroups((open) => ({ ...open, [section.groupId]: !groupOpen }))
                    }
                    aria-label={groupOpen ? 'Collapse this request' : 'Expand this request'}
                  >
                    {groupOpen ? (
                      <ExpandLessIcon fontSize="small" />
                    ) : (
                      <ExpandMoreIcon fontSize="small" />
                    )}
                  </IconButton>
                  {showRequester && <Requester record={first} />}
                  <Chip
                    size="small"
                    variant="outlined"
                    icon={<LayersIcon />}
                    label={`${total} ${total === 1 ? 'query' : 'queries'}`}
                    sx={{ borderColor: 'primary.dark', '& .MuiChip-icon': { color: 'primary.main' } }}
                  />
                  {[...counts.entries()].map(([status, count]) => (
                    <Chip
                      key={status}
                      size="small"
                      color={STATUS_COLOR[status]}
                      label={`${count} ${status.toLowerCase()}`}
                    />
                  ))}
                  <Box sx={{ flexGrow: 1 }} />
                  <IconAction
                    title="Copy a link to this request"
                    icon={<LinkIcon fontSize="small" />}
                    onClick={() => handleCopyLink(section.groupId)}
                  />
                  <Typography variant="caption" color="text.secondary">
                    {timeAgo(first.created_at)}
                  </Typography>
                </Stack>

                {/* Shared by every query — shown once here, not per row, and
                    outside the fold: the reason is why anyone opens a request
                    at all, so a closed one still says what it's for. */}
                <Reason>{first.reason}</Reason>

                {/* How the run ended, for the request as a whole — a closed
                    request shouldn't need opening to learn that it worked. The
                    per-query lines inside say which one, and when. */}
                {outcome && (
                  <Alert severity={outcome.severity} sx={{ py: 0.25 }}>
                    {outcome.message}
                  </Alert>
                )}

                {/* Closed, a request is its header line and its reason. The
                    run-order note and every query fold away, so a queue reads
                    as a list rather than as pages. */}
                <Collapse in={groupOpen} unmountOnExit>
                  <Stack spacing={1.25}>
                    {/* Running the request in order requires being able to
                        action every query in it, so this is hidden when some
                        are invisible to this viewer — the backend refuses that
                        case anyway. */}
                    {notPermitted.length === 0 && groupActionsFor && (
                      <Stack direction="row" spacing={1} justifyContent="flex-end">
                        {groupActionsFor(section)}
                      </Stack>
                    )}

                    <Typography variant="caption" color="text.secondary">
                      Each query is approved on its own. Running the request in order stops at
                      the first failure — the rest stay pending and can still be approved
                      individually.
                      {settledElsewhere.length > 0 &&
                        ` ${settledElsewhere.length} already actioned${
                          failedElsewhere.length > 0
                            ? ` (query ${failedElsewhere.map(e => e.position + 1).join(', ')} failed)`
                            : ''
                        }.`}
                      {notPermitted.length > 0 &&
                        ` ${notPermitted.length} more ${
                          notPermitted.length === 1 ? 'query needs' : 'queries need'
                        } a role you don't have.`}
                    </Typography>

                    {rows.map(({ record, history, position }) => {
                      // can_approve is only set by the pending endpoint; other
                      // tabs supply their own notion of what's context via
                      // contextFor.
                      const actionable = rowActionable(record);
                      return (
                        <QueryRow
                          key={record.id}
                          record={record}
                          history={history}
                          position={position}
                          warning={warningFor(record)}
                          actions={actionable ? actionsFor?.(record) : undefined}
                          result={resultFor(record)}
                          onToggleResult={
                            record.execution_id ? () => toggleResult(record) : undefined
                          }
                          resultOpen={resultTarget?.id === record.id}
                          liveStatus={liveStatusFor(record)}
                        />
                      );
                    })}
                  </Stack>
                </Collapse>
              </Stack>
            </Paper>
          );
        })}
      </Stack>
    );
  };

  const renderEmpty = (message: string) => (
    <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
      <Typography variant="body2" color="text.secondary">
        {message}
      </Typography>
    </Paper>
  );

  /*
   * What each list offers on a request.
   *
   * Named rather than written inline at the three call sites because the card a
   * link pins above the list is rendered from the same options: a request
   * reached by link should be exactly as actionable as the same request reached
   * by scrolling to it.
   */
  /**
   * Settled requests are immutable, so resubmitting opens a NEW request
   * prefilled from this one and leaves the original in the audit trail.
   * Offered on your own only: resubmitting makes you the requester, which
   * would misattribute someone else's.
   */
  const resubmitAction = (record: QueryRequestRecord) => (
    <IconAction
      title="Resubmit as a new request"
      icon={<ReplayIcon fontSize="small" />}
      onClick={() =>
        setComposer({
          items: [
            {
              query: record.query,
              database: record.database_name,
              mode: record.execution_mode,
              pgSchema: record.pg_schema || '',
            },
          ],
          reason: record.reason,
        })
      }
    />
  );

  const pendingOptions = {
    /*
     * Only a query still waiting on this viewer is theirs to action. Everything
     * else in the request — already run, already reviewed, or pending on
     * somebody else's role — is context.
     *
     * Stated rather than left to the default, because the default reads
     * `can_approve`, and a whole request carries queries in every state: the
     * queue only ever returns rows that are pending, but the dialog a link
     * opens shows the request entire.
     */
    contextFor: (record: QueryRequestRecord) =>
      record.status !== 'PENDING' || record.can_approve === false,
    groupActionsFor: (section: ListSection) => {
      const pendingInGroup = section.records.filter(
        r => r.status === 'PENDING' && r.can_approve !== false
      );
      if (pendingInGroup.length < 2) return null;

      // One password covers the whole run, the way the endpoint takes it.
      const key = `group:${section.groupId}`;
      const needsPassword = pendingInGroup.some((r) => r.requires_password);

      return (
        <>
          {needsPassword && (
            <PasswordPrompt
              value={passwordFor(key)}
              onChange={(value) => setPasswordAt(key, value)}
              disabled={actioning}
            />
          )}
          <Button
            size="small"
            color="error"
            startIcon={<BlockIcon />}
            onClick={() => openRejectGroup(section)}
          >
            Reject all
          </Button>
          <Button
            size="small"
            variant="contained"
            startIcon={<PlaylistAddCheckIcon />}
            onClick={() => approveGroupFromRow(section)}
            disabled={actioning || (needsPassword && !passwordFor(key))}
          >
            Approve all in order
          </Button>
        </>
      );
    },
    // No number in the label — the row's marker already says which query this
    // is, and repeating it just added noise.
    actionsFor: (record: QueryRequestRecord) => {
      // A single-query request renders as a card, which takes its actions
      // directly without consulting contextFor — so the invariant is restated
      // here: there is nothing to approve or reject on a query that has run.
      if (record.status !== 'PENDING') return null;

      return (
        <>
          {record.requires_password && (
            <PasswordPrompt
              value={passwordFor(record.id)}
              onChange={(value) => setPasswordAt(record.id, value)}
              disabled={actioning}
            />
          )}
          <Button
            size="small"
            color="error"
            startIcon={<BlockIcon />}
            onClick={() => openReject(record)}
          >
            Reject
          </Button>
          <Button
            size="small"
            variant="contained"
            startIcon={<CheckCircleIcon />}
            onClick={() => approveFromRow(record)}
            disabled={actioning || (record.requires_password && !passwordFor(record.id))}
          >
            Approve &amp; run
          </Button>
        </>
      );
    },
  };

  const reviewedOptions = {
    // The log leads with the most recent decision. Nothing here is waiting to
    // be acted on, so ordering by the review moves nothing under anyone.
    orderBy: 'reviewed' as const,
    // A request can be listed here for one reviewed query while a sibling is
    // still pending — that sibling is context.
    contextFor: (record: QueryRequestRecord) => !record.reviewer_id,
    actionsFor: (record: QueryRequestRecord) => {
      // Only your own — resubmitting makes you the requester, which would
      // misattribute someone else's request.
      const canResubmit =
        record.requester_id === user.id && SETTLED_STATUSES.includes(record.status);

      // Return null rather than an empty fragment, so a row with nothing to
      // offer doesn't render a blank action bar. The result isn't among these
      // — it has its own control on the row.
      return canResubmit ? resubmitAction(record) : null;
    },
  };

  const mineOptions = {
    showRequester: false,
    /*
     * Nothing on your own requests is context: every row offers something,
     * whether that's withdrawing a pending query or resubmitting a settled one,
     * and actionsFor decides which from the status.
     *
     * Said explicitly because the default would read `can_approve`, which is
     * false on every query you raised yourself — you cannot approve your own
     * request, which is not the same as having nothing to do with it.
     */
    contextFor: () => false,
    groupActionsFor: (section: ListSection) => {
      const pendingInGroup = section.records.filter(r => r.status === 'PENDING');
      if (pendingInGroup.length === 0) return null;

      const [first] = section.records;
      return (
        <>
          {/* Request-scoped, so it lives on the request header rather than
              inside any one query. */}
          <IconAction
            title="Edit the reason for this request"
            icon={<NotesIcon fontSize="small" />}
            onClick={() =>
              setReasonTarget({
                groupId: section.groupId,
                reason: first.reason,
                queryCount: first.group_size ?? section.records.length,
              })
            }
          />
          {pendingInGroup.length > 1 && (
            <IconAction
              title="Withdraw every pending query in this request"
              icon={<DeleteOutlineIcon fontSize="small" />}
              onClick={() => setWithdrawGroupTarget(section)}
            />
          )}
        </>
      );
    },
    actionsFor: (record: QueryRequestRecord) => (
      <>
        {record.status === 'PENDING' && (
          <>
            <IconAction
              title="Withdraw this query"
              icon={<DeleteOutlineIcon fontSize="small" />}
              onClick={() => handleCancel(record)}
            />
            {/* A single-query request has no header to hang the request-scoped
                action on. */}
            {(record.group_size ?? 1) === 1 && (
              <IconAction
                title="Edit the reason"
                icon={<NotesIcon fontSize="small" />}
                onClick={() =>
                  setReasonTarget({
                    groupId: record.group_id,
                    reason: record.reason,
                    queryCount: 1,
                  })
                }
              />
            )}
            <IconAction
              title="Revise this query"
              icon={<EditIcon fontSize="small" />}
              onClick={() => setEditTarget(record)}
            />
          </>
        )}
        {SETTLED_STATUSES.includes(record.status) && resubmitAction(record)}
      </>
    ),
  };

  /**
   * Which list's actions a linked request gets — the one it would be in.
   *
   * Its own page has no list of its own to take them from, but the request is
   * still just a request: pending on you means approve and reject, yours means
   * withdraw and revise, settled means resubmit.
   */
  const linkedOptions = linkedSection && user
    ? ({
        requests: pendingOptions,
        requestsMine: mineOptions,
        requestsReviewed: reviewedOptions,
      } as const)[tabForLinkedRequest(linkedSection.records, user)]
    : pendingOptions;

  /*
   * The page a link opens: one request, on a page of its own.
   *
   * It used to be a dialog, then a filter over one of the lists. A page is the
   * honest shape for it — a link is a fourth place a request can be looked at,
   * and it says so in the header rather than leaving a list looking mysteriously
   * short. The three lists behind are untouched, and closing this page is what
   * takes it out of the header again.
   */
  const linkedView = (
    <Stack spacing={2}>
      <Paper
        variant="outlined"
        sx={{
          p: 1.5,
          borderColor: linkedError ? 'warning.main' : 'primary.main',
          bgcolor: 'action.hover',
        }}
      >
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          {linkedError ? <WarningAmberIcon color="warning" /> : <LinkIcon color="primary" />}

          <Box sx={{ flexGrow: 1, minWidth: 220 }}>
            <Typography variant="subtitle2">
              {linkedError ? "That link didn't open" : 'Opened from a link'}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {linkedLoading
                ? 'Fetching the request…'
                : (linkedError ??
                  'Just this one request. The other pages are unchanged — close this to put it away.')}
            </Typography>
          </Box>

          <Button
            variant="contained"
            size="small"
            startIcon={<CloseIcon />}
            onClick={closeLinkedRequest}
          >
            Close
          </Button>
        </Stack>
      </Paper>

      {linkedLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress size={28} />
        </Box>
      ) : (
        linkedSection && renderSections(linkedSection.records, linkedOptions)
      )}
    </Stack>
  );

  return (
    <Box sx={{ height: '100%', overflow: 'auto' }}>
      <Stack spacing={2} sx={{ p: 1 }}>
        <Stack direction="row" alignItems="center" spacing={2}>
          {/* The header tab already names the list, so this only carries the
              count that used to sit in the tab label. */}
          {tab === 'pending' && actionablePendingCount > 0 && (
            <Chip size="small" color="warning" label={`${actionablePendingCount} awaiting you`} />
          )}
          {tab === 'mine' && mine.length > 0 && (
            <Chip size="small" variant="outlined" label={`${mine.length} queries`} />
          )}
          <Box sx={{ flexGrow: 1 }} />

          {/* Every knob for the list in one place. My requests has none —
              every row there is yours. */}
          {/* Shared by Pending and Reviewed — the filter means the same thing on
              both, only the people to choose from differ. */}
          {tabRequesters.length > 0 && (
            <PersonFilter
              label="Requester"
              options={tabRequesters}
              value={requesterFilter}
              onChange={setRequesterFilter}
            />
          )}
          {tab === 'reviewed' && reviewedReviewers.length > 0 && (
            <PersonFilter
              label="Reviewer"
              options={reviewedReviewers}
              value={reviewerFilter}
              onChange={setReviewerFilter}
            />
          )}

          {/* Compose a request without having to first get refused in the
              console — this flow picks its own target database and cloud. */}
          {/* One entry point. The composer starts with a single query and
              grows — matching the backend, where a request is always a list. */}
          <Button
            size="small"
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setComposer({ items: [], reason: '' })}
          >
            New request
          </Button>
          <Button
            size="small"
            startIcon={<RefreshIcon />}
            onClick={() => {
              // Asking for the queue as it stands means letting go of the
              // finished request being held on it.
              setHeldSection(null);
              load(true);
            }}
          >
            Refresh
          </Button>
        </Stack>

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress size={28} />
          </Box>
        ) : tab === 'linked' ? (
          linkedView
        ) : tab === 'pending' ? (
          <Stack spacing={2}>
            <Alert severity="info" sx={{ py: 0.5 }}>
              Approving runs the query immediately under <strong>your</strong> role and identity.
              You only see requests your own role is allowed to run.
            </Alert>

            {requesterFilter && (
              <Typography variant="caption" color="text.secondary">
                Showing {filteredPending.length} of {pending.length} queries from{' '}
                {requesterFilter.name || requesterFilter.username}.{' '}
                <Box
                  component="span"
                  role="button"
                  tabIndex={0}
                  onClick={() => setRequesterFilter(null)}
                  onKeyDown={(e) => e.key === 'Enter' && setRequesterFilter(null)}
                  sx={{ color: 'primary.main', cursor: 'pointer' }}
                >
                  Show everyone
                </Box>
              </Typography>
            )}

            {pendingView.length === 0
              ? pending.length === 0
                ? renderEmpty('Nothing waiting on you right now.')
                : renderEmpty(
                    `Nothing pending from ${requesterFilter?.name || requesterFilter?.username}.`
                  )
              : renderSections(pendingView, pendingOptions)}
          </Stack>
        ) : tab === 'reviewed' ? (
          <Stack spacing={2}>
            <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
              {/* Only MASTER/ADMIN see everyone's reviews, so only they have a
                  scope to choose. For everyone else the log is already limited
                  to what they raised or reviewed — an "All reviews" button
                  there would claim a breadth they don't have, and "My reviews"
                  is empty for any role that can't approve anything. Query
                  history hides its user filter from non-super roles for the
                  same reason. */}
              {isSuperRole(user.role) && (
                <ToggleButtonGroup
                  size="small"
                  exclusive
                  value={reviewedScope}
                  onChange={(_e, value) => value && setReviewedScope(value)}
                >
                  <ToggleButton value="all">All reviews</ToggleButton>
                  <ToggleButton value="me">My reviews</ToggleButton>
                </ToggleButtonGroup>
              )}

              <Typography variant="caption" color="text.secondary">
                {requesterFilter || reviewerFilter
                  ? `${filteredReviewed.length} of ${reviewed.length} queries shown`
                  : !isSuperRole(user.role) || reviewedScope === 'me'
                    ? 'Queries you approved or rejected.'
                    : 'Every query that has been approved or rejected, and by whom.'}
              </Typography>

              <Box sx={{ flexGrow: 1 }} />
              {(requesterFilter || reviewerFilter) && (
                <Button
                  size="small"
                  color="inherit"
                  onClick={() => {
                    setRequesterFilter(null);
                    setReviewerFilter(null);
                  }}
                >
                  Clear filters
                </Button>
              )}
            </Stack>

            {reviewed.length === 0
              ? renderEmpty(
                  isSuperRole(user.role) && effectiveReviewedScope === 'all'
                    ? 'Nothing has been reviewed yet.'
                    : "You haven't approved or rejected anything yet."
                )
              : filteredReviewed.length === 0
                ? renderEmpty(
                    `Nothing reviewed matches ${[
                      requesterFilter && `requests from ${requesterFilter.name || requesterFilter.username}`,
                      reviewerFilter && `reviews by ${reviewerFilter.name || reviewerFilter.username}`,
                    ]
                      .filter(Boolean)
                      .join(' and ')}.`
                  )
                : renderSections(filteredReviewed, reviewedOptions)}
          </Stack>
        ) : (
          <Stack spacing={2}>
            {mine.length === 0
              ? renderEmpty(
                  'No requests yet. When your role blocks a query in the DB Manager, you can request approval from there.'
                )
              : renderSections(mine, mineOptions)}
          </Stack>
        )}
      </Stack>

      {composer && (
        <RequestComposerDialog
          open
          initialItems={composer.items.length ? composer.items : undefined}
          initialReason={composer.reason || undefined}
          onClose={() => setComposer(null)}
          onSubmitted={(groupId) => {
            setManagerMode('requestsMine');
            load();
            // Land on the request you just raised rather than on a list you
            // then have to find it in — and it arrives with its own link
            // button, which is the point at which you'd want to share it.
            focusGroup(groupId);
          }}
        />
      )}

      {reasonTarget && (
        <EditReasonDialog
          open
          groupId={reasonTarget.groupId}
          currentReason={reasonTarget.reason}
          querycount={reasonTarget.queryCount}
          onClose={() => setReasonTarget(null)}
          onSubmitted={load}
        />
      )}

      {editTarget && (
        <EditRequestDialog
          open
          record={editTarget}
          onClose={() => setEditTarget(null)}
          onSubmitted={load}
        />
      )}

      {/* Withdraw the whole request */}
      <Dialog
        open={!!withdrawGroupTarget}
        onClose={actioning ? undefined : () => setWithdrawGroupTarget(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Withdraw this whole request?</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Alert severity="info">
              Withdraws{' '}
              {withdrawGroupTarget?.records.filter(r => r.status === 'PENDING').length ?? 0} pending
              queries. Anything already approved or run stays as it is.
            </Alert>
            <Typography variant="body2" color="text.secondary">
              You can resubmit later — the withdrawn queries stay visible here and Resubmit
              prefills a new request from them.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setWithdrawGroupTarget(null)} disabled={actioning}>
            Keep it
          </Button>
          <Button variant="contained" onClick={handleWithdrawGroup} disabled={actioning}>
            {actioning ? 'Withdrawing…' : 'Withdraw all'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Reject the whole request */}
      <Dialog
        open={!!rejectGroupTarget}
        onClose={actioning ? undefined : () => setRejectGroupTarget(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Reject this whole request?</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Alert severity="warning">
              Rejects{' '}
              {rejectGroupTarget?.records.filter(r => r.status === 'PENDING' && r.can_approve !== false)
                .length ?? 0} pending
              queries at once. Anything already run is unaffected.
            </Alert>
            <Typography variant="body2" color="text.secondary">
              The requester sees this note on every query it applies to, so say what would need
              to change.
            </Typography>
            <TextField
              label="Why are you rejecting it?"
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value.slice(0, 1000))}
              fullWidth
              multiline
              minRows={3}
              autoFocus
              required
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setRejectGroupTarget(null)} disabled={actioning}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={handleRejectGroup}
            disabled={actioning || reviewNote.trim().length < 3}
          >
            Reject all
          </Button>
        </DialogActions>
      </Dialog>

      {/* Reject */}
      <Dialog
        open={!!rejectTarget}
        onClose={actioning ? undefined : () => setRejectTarget(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Reject this request?</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              The requester sees this note, so say what would need to change.
            </Typography>
            <TextField
              label="Why are you rejecting it?"
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value.slice(0, 1000))}
              fullWidth
              multiline
              minRows={3}
              autoFocus
              required
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setRejectTarget(null)} disabled={actioning}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={handleReject}
            disabled={actioning || reviewNote.trim().length < 3}
          >
            Reject
          </Button>
        </DialogActions>
      </Dialog>

    </Box>
  );
};

export default QueryRequestsPanel;
