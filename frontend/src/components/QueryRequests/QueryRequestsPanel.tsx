import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  InputAdornment,
  LinearProgress,
  Paper,
  Stack,
  Tab,
  Tabs,
  ToggleButton,
  ToggleButtonGroup,
  TextField,
  Typography,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import BlockIcon from '@mui/icons-material/Block';
import RefreshIcon from '@mui/icons-material/Refresh';
import VisibilityIcon from '@mui/icons-material/Visibility';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import ReplayIcon from '@mui/icons-material/Replay';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Clear';
import AddIcon from '@mui/icons-material/Add';
import LayersIcon from '@mui/icons-material/Layers';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import HistoryIcon from '@mui/icons-material/History';
import NotesIcon from '@mui/icons-material/Notes';
import PlaylistAddCheckIcon from '@mui/icons-material/PlaylistAddCheck';
import { formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';
import { queryRequestsAPI, toastNonApiError } from '../../services/api';
import { useAppStore } from '../../store/appStore';
import { isSuperRole } from '../../constants/roles';
import ResultsPanel from '../Results/ResultsPanel';
import RequestComposerDialog from './RequestComposerDialog';
import EditRequestDialog from './EditRequestDialog';
import EditReasonDialog from './EditReasonDialog';
import QueryPreviewCard from './QueryPreviewCard';
import type { QueryRequestRecord, QueryRequestStatus, QueryResponse } from '../../types';

/** Refresh cadence while anything is still pending or in flight. */
const POLL_INTERVAL_MS = 15000;

/** Terminal states — nothing more will happen, so offer a resubmit instead. */
const SETTLED_STATUSES: QueryRequestStatus[] = ['FAILED', 'REJECTED', 'EXPIRED', 'CANCELLED'];

/** Approved and handed to an executor, but not finished. */
const IN_FLIGHT_STATUSES: QueryRequestStatus[] = ['APPROVED', 'RUNNING'];

/** Tighter than the list poll — this one is watching a query actually run. */
const RESULT_POLL_MS = 1500;

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

const timeAgo = (iso: string) => {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
};

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
 * Ordered marker for a query inside a request.
 *
 * Carries the identity on its own now that the action buttons no longer repeat
 * the number, so it needs to read as a list marker rather than a stray digit.
 */
const PositionBadge = ({ position }: { position: number }) => (
  <Box
    sx={{
      width: 22,
      height: 22,
      flexShrink: 0,
      borderRadius: '50%',
      bgcolor: 'action.selected',
      color: 'text.secondary',
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

/** SQL squashed to a single line for the collapsed preview. */
const oneLine = (sql: string) => sql.replace(/\s+/g, ' ').trim();

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
              <CodeBlock maxHeight={140}>{previous.query}</CodeBlock>
            </Box>
          ))}
        </Stack>
      </Collapse>
    </Box>
  );
};

interface QueryRowProps {
  record: QueryRequestRecord;
  /** 1-based, as shown to the user. */
  position: number;
  actions?: React.ReactNode;
  defaultExpanded?: boolean;
  /** Already actioned, or not yours to action — shown for context, dimmed. */
  muted?: boolean;
  /** Superseded versions of this same query, newest first. */
  history?: QueryRequestRecord[];
}

/**
 * One query inside a multi-query request.
 *
 * Deliberately not a RequestCard: nesting bordered cards inside a bordered
 * group read as boxes-in-boxes, and repeating the full chrome and SQL block per
 * query turned a request of four into a wall. A numbered row with the SQL
 * collapsed keeps the whole request scannable, and expanding is only needed to
 * read it here — the approve dialog shows the full query before anything runs.
 */
const QueryRow = ({
  record,
  position,
  actions,
  defaultExpanded = false,
  muted = false,
  history = [],
}: QueryRowProps) => {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <Box sx={{ borderTop: '1px solid', borderColor: 'divider', pt: 1.25, opacity: muted ? 0.6 : 1 }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <IconButton size="small" onClick={() => setExpanded((v) => !v)} sx={{ p: 0.25 }}>
          {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>

        <PositionBadge position={position} />

        <Chip
          size="small"
          color={STATUS_COLOR[record.status]}
          label={record.status === 'SUPERSEDED' ? 'REPLACED' : record.status}
        />
        <Chip size="small" variant="outlined" label={`${record.database_name} · ${record.execution_mode}`} />
        {record.requires_password && (
          <Chip size="small" color="error" variant="outlined" label="Password" />
        )}
        {history.length > 0 && (
          <Chip size="small" variant="outlined" color="info" label="Revised" />
        )}

        {/* Collapsed preview — enough to tell the queries apart at a glance. */}
        {!expanded && (
          <Typography
            noWrap
            sx={{
              flex: 1,
              minWidth: 0,
              fontFamily: 'monospace',
              fontSize: '0.75rem',
              color: 'text.secondary',
            }}
          >
            {oneLine(record.query)}
          </Typography>
        )}
      </Stack>

      <Collapse in={expanded} unmountOnExit>
        <Box sx={{ pl: 4, pt: 1 }}>
          <CodeBlock maxHeight={160}>{record.query}</CodeBlock>
        </Box>
      </Collapse>

      <Box sx={{ pl: 4 }}>
        <RevisionHistory history={history} />
      </Box>

      {(record.reviewer_username || record.error) && (
        <Box sx={{ pl: 4, pt: 1 }}>
          {record.reviewer_username && (
            <Typography variant="caption" color="text.secondary">
              {record.status === 'REJECTED' ? 'Rejected' : 'Approved'} by{' '}
              {record.reviewer_name || record.reviewer_username}
              {record.review_note ? ` — \u201c${record.review_note}\u201d` : ''}
            </Typography>
          )}
          {record.error && (
            <Alert severity="error" sx={{ py: 0, mt: 0.5 }}>
              {record.error}
            </Alert>
          )}
        </Box>
      )}

      {actions && (
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
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
  /** Rendered in the card footer — approve/reject, or cancel on your own request. */
  actions?: React.ReactNode;
  showRequester?: boolean;
  /** Superseded versions of this query, newest first. */
  history?: QueryRequestRecord[];
}

const RequestCard = ({
  record,
  actions,
  showRequester = true,
  history = [],
}: RequestCardProps) => (
  <Paper variant="outlined" sx={{ p: 2 }}>
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Chip size="small" color={STATUS_COLOR[record.status]} label={record.status} />
        {showRequester && (
          <Typography variant="body2" color="text.secondary">
            {record.requester_name || record.requester_username}
            {' · '}
            {record.requester_role}
          </Typography>
        )}
        <Box sx={{ flexGrow: 1 }} />
        {/* An amended request is visibly not the one an approver may have
            skimmed earlier. */}
        {record.updated_at && (
          <Chip size="small" variant="outlined" label={`edited ${timeAgo(record.updated_at)}`} />
        )}
        <Typography variant="caption" color="text.secondary">
          {timeAgo(record.created_at)}
        </Typography>
      </Stack>

      {/* The reason leads — an approver scans this before the SQL. */}
      <Box sx={{ borderLeft: '3px solid', borderColor: 'primary.main', pl: 1.5, py: 0.5 }}>
        <Typography variant="body2">{record.reason}</Typography>
      </Box>

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

      <CodeBlock>{record.query}</CodeBlock>

      <RevisionHistory history={history} />

      {record.reviewer_username && (
        <Typography variant="caption" color="text.secondary">
          {record.status === 'REJECTED' ? 'Rejected' : 'Approved'} by{' '}
          {record.reviewer_name || record.reviewer_username}
          {record.reviewed_at ? ` · ${timeAgo(record.reviewed_at)}` : ''}
          {record.review_note ? ` — “${record.review_note}”` : ''}
        </Typography>
      )}

      {record.error && (
        <Alert severity="error" sx={{ py: 0.5 }}>
          {record.error}
        </Alert>
      )}

      {actions && (
        <>
          <Divider />
          <Stack direction="row" spacing={1} justifyContent="flex-end">
            {actions}
          </Stack>
        </>
      )}
    </Stack>
  </Paper>
);

const QueryRequestsPanel = ({ onReviewed }: { onReviewed?: () => void }) => {
  const user = useAppStore((s) => s.user);

  const [tab, setTab] = useState<'pending' | 'mine' | 'reviewed'>('pending');
  const [pendingSearch, setPendingSearch] = useState('');
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

  const [approveTarget, setApproveTarget] = useState<QueryRequestRecord | null>(null);
  const [approveGroupTarget, setApproveGroupTarget] = useState<ListSection | null>(null);
  /** Siblings of the query being approved, when it belongs to a multi-query request. */
  const [approveSiblings, setApproveSiblings] = useState<QueryRequestRecord[]>([]);
  const [rejectTarget, setRejectTarget] = useState<QueryRequestRecord | null>(null);
  const [rejectGroupTarget, setRejectGroupTarget] = useState<ListSection | null>(null);
  const [withdrawGroupTarget, setWithdrawGroupTarget] = useState<ListSection | null>(null);
  const [password, setPassword] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [actioning, setActioning] = useState(false);

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

  // Poll only while something can still change — a queue of settled requests
  // doesn't need refreshing.
  const hasOpenWork =
    pending.length > 0 ||
    mine.some((r) => ['PENDING', 'APPROVED', 'RUNNING'].includes(r.status));

  // A sequential run advances query by query, so a 15s cadence would show it
  // lurching. Tighten only while something is actually executing.
  const anyInFlight = [...pending, ...mine, ...reviewed].some((r) =>
    IN_FLIGHT_STATUSES.includes(r.status)
  );
  const pollInterval = anyInFlight ? 3000 : POLL_INTERVAL_MS;

  useEffect(() => {
    if (!hasOpenWork) {
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
  }, [hasOpenWork, pollInterval, load]);

  // Land on whichever list actually has something in it — but only on the very
  // first load. Re-running it later hijacked the tab: changing the Reviewed
  // filter re-runs load(), and for a role that can rarely approve anything
  // `pending` is empty, so every filter click bounced to My requests.
  const landedRef = useRef(false);
  useEffect(() => {
    if (loading || landedRef.current) return;

    landedRef.current = true;
    if (pending.length === 0 && mine.length > 0) {
      setTab('mine');
    }
  }, [loading, pending.length, mine.length]);

  const openApprove = async (record: QueryRequestRecord) => {
    setApproveTarget(record);
    setPassword('');
    setReviewNote('');
    setApproveSiblings([]);

    // A failed sibling no longer blocks approval — the requester's stop-on-
    // failure choice halts the ordered run, it doesn't veto a human decision
    // afterwards. But the approver should know before they click.
    if ((record.group_size ?? 1) > 1) {
      try {
        const { requests } = await queryRequestsAPI.getGroup(record.group_id);
        setApproveSiblings(requests.filter((r) => r.id !== record.id));
      } catch {
        // Non-critical context — the approval itself is unaffected.
      }
    }
  };

  const openApproveGroup = (section: ListSection) => {
    setApproveGroupTarget(section);
    setPassword('');
    setReviewNote('');
  };

  const openReject = (record: QueryRequestRecord) => {
    setRejectTarget(record);
    setReviewNote('');
  };

  const openRejectGroup = (section: ListSection) => {
    setRejectGroupTarget(section);
    setReviewNote('');
  };

  const handleApprove = async () => {
    if (!approveTarget) return;

    setActioning(true);
    try {
      await queryRequestsAPI.approve(approveTarget.id, {
        password: password || undefined,
        reviewNote: reviewNote.trim() || undefined,
        // Approve exactly what's on screen — 409s if the requester amended it
        // after this card was loaded.
        expectedHash: approveTarget.query_hash,
      });
      toast.success('Approved — the query is now running under your role');

      // Hand straight over to the result view rather than making the approver
      // hunt for what they just ran. The request has already left the pending
      // queue at this point, so there is nowhere obvious for them to look.
      const approved = approveTarget;
      setApproveTarget(null);
      openResult(approved);
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

  const handleApproveGroup = async () => {
    if (!approveGroupTarget) return;

    setActioning(true);
    try {
      const { queued } = await queryRequestsAPI.approveGroup(approveGroupTarget.groupId, {
        password: password || undefined,
        reviewNote: reviewNote.trim() || undefined,
      });

      toast.success(`Running ${queued} queries in order under your role`);
      setApproveGroupTarget(null);
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

  const openResult = useCallback(
    async (record: QueryRequestRecord) => {
      stopResultPoll();
      setResultTarget(record);
      setLiveResult(null);
      setLiveStatus(null);
      setLiveProgress(null);
      setResultLoading(true);

      try {
        const settled = await fetchResult(record.id);
        if (settled) return;

        // Still running — follow it. Partial per-cloud results land as each
        // cloud finishes, so the panel fills in progressively.
        resultPollRef.current = setInterval(async () => {
          try {
            if (await fetchResult(record.id)) {
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
        setResultLoading(false);
      }
    },
    [fetchResult, load, stopResultPoll]
  );

  const closeResult = useCallback(() => {
    stopResultPoll();
    setResultTarget(null);
  }, [stopResultPoll]);

  useEffect(() => stopResultPoll, [stopResultPoll]);

  // Filtered in the browser rather than server-side: the queue is already
  // fully loaded and capped, so this is instant and costs no round trip.
  // The pending payload carries whole requests, so it includes settled and
  // not-yours rows for context. Counts must reflect what you can actually act on.
  const actionablePendingCount = useMemo(
    () => pending.filter((r) => r.status === 'PENDING' && r.can_approve !== false).length,
    [pending]
  );

  const filteredPending = useMemo(() => {
    const term = pendingSearch.trim().toLowerCase();
    if (!term) return pending;

    return pending.filter(
      (r) =>
        r.requester_username.toLowerCase().includes(term) ||
        (r.requester_name || '').toLowerCase().includes(term)
    );
  }, [pending, pendingSearch]);

  if (!user) return null;

  // The live execution is ahead of the request row, which only settles when the
  // backend watcher next polls — so drive the dialog off `live` when it exists
  // and fall back to the stored status once the execution record has expired.
  const isResultRunning = resultTarget
    ? liveStatus
      ? liveStatus === 'running'
      : IN_FLIGHT_STATUSES.includes(resultTarget.status)
    : false;

  const displayStatus: QueryRequestStatus = !resultTarget
    ? 'PENDING'
    : isResultRunning
      ? 'RUNNING'
      : liveStatus
        ? liveStatus === 'completed' && liveResult?.success
          ? 'SUCCEEDED'
          : 'FAILED'
        : resultTarget.status;

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
      /** Rows that are context rather than content, dimmed and stripped of actions. */
      mutedFor?: (record: QueryRequestRecord) => boolean;
      showRequester?: boolean;
    } = {}
  ) => {
    const { actionsFor, groupActionsFor, mutedFor, showRequester = true } = options;

    return (
      <Stack spacing={2}>
        {toSections(records).map((section) => {
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
            return (
              <RequestCard
                key={only.record.id}
                record={only.record}
                history={only.history}
                showRequester={showRequester}
                actions={actionsFor?.(only.record)}
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

          // Short requests open expanded; longer ones stay collapsed so the
          // list of queries is scannable rather than a wall of SQL.
          const defaultExpanded = rows.length <= 2;

          return (
            // The blue frame is what marks these as one request; what made it
            // confusing was the bordered cards nested inside, not the frame.
            <Paper
              key={section.groupId}
              variant="outlined"
              sx={{ p: 2, borderColor: 'primary.dark', bgcolor: 'rgba(33,150,243,0.04)' }}
            >
              <Stack spacing={1.25}>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <LayersIcon fontSize="small" sx={{ color: 'primary.main' }} />
                  <Typography variant="subtitle2">
                    {total} {total === 1 ? 'query' : 'queries'}
                  </Typography>
                  {[...counts.entries()].map(([status, count]) => (
                    <Chip
                      key={status}
                      size="small"
                      color={STATUS_COLOR[status]}
                      label={`${count} ${status.toLowerCase()}`}
                    />
                  ))}
                  <Box sx={{ flexGrow: 1 }} />
                  {showRequester && (
                    <Typography variant="body2" color="text.secondary">
                      {first.requester_name || first.requester_username} · {first.requester_role}
                    </Typography>
                  )}
                  <Typography variant="caption" color="text.secondary">
                    {timeAgo(first.created_at)}
                  </Typography>
                </Stack>

                {/* Running the request in order requires being able to action
                    every query in it, so this is hidden when some are invisible
                    to this viewer — the backend refuses that case anyway. */}
                {notPermitted.length === 0 && groupActionsFor && (
                  <Stack direction="row" spacing={1} justifyContent="flex-end">
                    {groupActionsFor(section)}
                  </Stack>
                )}

                {/* Shared by every query — shown once here, not per row. */}
                <Box sx={{ borderLeft: '3px solid', borderColor: 'primary.main', pl: 1.5, py: 0.5 }}>
                  <Typography variant="body2">{first.reason}</Typography>
                </Box>

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
                  // can_approve is only set by the pending endpoint; other tabs
                  // supply their own notion of what's context via mutedFor.
                  const actionable =
                    record.status !== 'SUPERSEDED' &&
                    (mutedFor ? !mutedFor(record) : record.can_approve !== false);
                  return (
                    <QueryRow
                      key={record.id}
                      record={record}
                      history={history}
                      position={position}
                      defaultExpanded={defaultExpanded}
                      muted={!actionable}
                      actions={actionable ? actionsFor?.(record) : undefined}
                    />
                  );
                })}
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

  return (
    <Box sx={{ height: '100%', overflow: 'auto' }}>
      <Stack spacing={2} sx={{ p: 1 }}>
        <Stack direction="row" alignItems="center" spacing={2}>
          <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ minHeight: 40 }}>
            <Tab
              value="pending"
              label={`Pending approvals${actionablePendingCount ? ` (${actionablePendingCount})` : ''}`}
              sx={{ minHeight: 40 }}
            />
            <Tab
              value="mine"
              label={`My requests${mine.length ? ` (${mine.length})` : ''}`}
              sx={{ minHeight: 40 }}
            />
            <Tab value="reviewed" label="Reviewed" sx={{ minHeight: 40 }} />
          </Tabs>
          <Box sx={{ flexGrow: 1 }} />
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
          <Button size="small" startIcon={<RefreshIcon />} onClick={() => load(true)}>
            Refresh
          </Button>
        </Stack>

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress size={28} />
          </Box>
        ) : tab === 'pending' ? (
          <Stack spacing={2}>
            <Alert severity="info" sx={{ py: 0.5 }}>
              Approving runs the query immediately under <strong>your</strong> role and identity.
              You only see requests your own role is allowed to run.
            </Alert>

            {pending.length > 0 && (
              <TextField
                size="small"
                fullWidth
                placeholder="Search by requester — username or name"
                value={pendingSearch}
                onChange={(e) => setPendingSearch(e.target.value)}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                  endAdornment: pendingSearch ? (
                    <InputAdornment position="end">
                      <IconButton size="small" onClick={() => setPendingSearch('')} edge="end">
                        <ClearIcon fontSize="small" />
                      </IconButton>
                    </InputAdornment>
                  ) : undefined,
                }}
                helperText={
                  pendingSearch
                    ? `${filteredPending.length} of ${pending.length} matching`
                    : undefined
                }
              />
            )}

            {pending.length === 0
              ? renderEmpty('Nothing waiting on you right now.')
              : filteredPending.length === 0
                ? renderEmpty(`No pending requests from anyone matching “${pendingSearch.trim()}”.`)
                : renderSections(filteredPending, {
                    groupActionsFor: (section) => {
                      const pendingInGroup = section.records.filter(
                        r => r.status === 'PENDING' && r.can_approve !== false
                      );
                      if (pendingInGroup.length < 2) return null;

                      return (
                        <>
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
                            onClick={() => openApproveGroup(section)}
                          >
                            Approve all in order
                          </Button>
                        </>
                      );
                    },
                    // No number in the label — the row's marker already says
                    // which query this is, and repeating it just added noise.
                    actionsFor: (record) => (
                      <>
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
                          onClick={() => openApprove(record)}
                        >
                          Approve &amp; run
                        </Button>
                      </>
                    ),
                  })}
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
                {!isSuperRole(user.role) || reviewedScope === 'me'
                  ? 'Queries you approved or rejected.'
                  : 'Every query that has been approved or rejected, and by whom.'}
              </Typography>
            </Stack>

            {reviewed.length === 0
              ? renderEmpty(
                  isSuperRole(user.role) && effectiveReviewedScope === 'all'
                    ? 'Nothing has been reviewed yet.'
                    : "You haven't approved or rejected anything yet."
                )
              : renderSections(reviewed, {
                  // A request can be listed here for one reviewed query while a
                  // sibling is still pending — that sibling is context.
                  mutedFor: (record) => !record.reviewer_id,
                  actionsFor: (record) => {
                    // Only your own — resubmitting makes you the requester,
                    // which would misattribute someone else's request.
                    const canResubmit =
                      record.requester_id === user.id && SETTLED_STATUSES.includes(record.status);

                    // Return null rather than an empty fragment, so a row with
                    // nothing to offer doesn't render a blank action bar.
                    if (!canResubmit && !record.execution_id) return null;

                    return (
                      <>
                        {canResubmit && (
                          <Button
                            size="small"
                            startIcon={<ReplayIcon />}
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
                          >
                            Resubmit
                          </Button>
                        )}
                        {record.execution_id && (
                          <Button
                            size="small"
                            startIcon={<VisibilityIcon />}
                            onClick={() => openResult(record)}
                          >
                            View result
                          </Button>
                        )}
                      </>
                    );
                  },
                })}
          </Stack>
        ) : (
          <Stack spacing={2}>
            {mine.length === 0
              ? renderEmpty(
                  'No requests yet. When your role blocks a query in the DB Manager, you can request approval from there.'
                )
              : renderSections(mine, {
                  showRequester: false,
                  groupActionsFor: (section) => {
                    const pendingInGroup = section.records.filter(r => r.status === 'PENDING');
                    if (pendingInGroup.length === 0) return null;

                    const [first] = section.records;
                    return (
                      <>
                        {/* Request-scoped, so it lives on the request header
                            rather than inside any one query. */}
                        <Button
                          size="small"
                          startIcon={<NotesIcon />}
                          onClick={() =>
                            setReasonTarget({
                              groupId: section.groupId,
                              reason: first.reason,
                              queryCount: first.group_size ?? section.records.length,
                            })
                          }
                        >
                          Edit reason
                        </Button>
                        {pendingInGroup.length > 1 && (
                          <Button
                            size="small"
                            color="inherit"
                            startIcon={<DeleteOutlineIcon />}
                            onClick={() => setWithdrawGroupTarget(section)}
                          >
                            Withdraw all
                          </Button>
                        )}
                      </>
                    );
                  },
                  actionsFor: (record) => (
                    <>
                      {record.status === 'PENDING' && (
                        <>
                          <Button
                            size="small"
                            color="inherit"
                            startIcon={<DeleteOutlineIcon />}
                            onClick={() => handleCancel(record)}
                          >
                            Withdraw
                          </Button>
                          {/* A single-query request has no header to hang the
                              request-scoped action on. */}
                          {(record.group_size ?? 1) === 1 && (
                            <Button
                              size="small"
                              startIcon={<NotesIcon />}
                              onClick={() =>
                                setReasonTarget({
                                  groupId: record.group_id,
                                  reason: record.reason,
                                  queryCount: 1,
                                })
                              }
                            >
                              Edit reason
                            </Button>
                          )}
                          <Button
                            size="small"
                            startIcon={<EditIcon />}
                            onClick={() => setEditTarget(record)}
                          >
                            Revise query
                          </Button>
                        </>
                      )}
                      {/* Settled requests are immutable — resubmitting opens a
                          NEW request prefilled from this one, leaving the
                          original intact in the audit trail. */}
                      {SETTLED_STATUSES.includes(record.status) && (
                        <Button
                          size="small"
                          startIcon={<ReplayIcon />}
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
                        >
                          Resubmit
                        </Button>
                      )}
                      {record.execution_id && (
                        <Button
                          size="small"
                          startIcon={<VisibilityIcon />}
                          onClick={() => openResult(record)}
                        >
                          View result
                        </Button>
                      )}
                    </>
                  ),
                })}
          </Stack>
        )}
      </Stack>

      {composer && (
        <RequestComposerDialog
          open
          initialItems={composer.items.length ? composer.items : undefined}
          initialReason={composer.reason || undefined}
          onClose={() => setComposer(null)}
          onSubmitted={() => {
            setTab('mine');
            load();
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

      {/* Approve the whole request, in order */}
      <Dialog
        open={!!approveGroupTarget}
        onClose={actioning ? undefined : () => setApproveGroupTarget(null)}
        maxWidth="lg"
        fullWidth
      >
        <DialogTitle>Run this whole request?</DialogTitle>
        <DialogContent>
          {approveGroupTarget && (() => {
            const queue = approveGroupTarget.records
              .filter(r => r.status === 'PENDING' && r.can_approve !== false)
              .sort((a, b) => (a.group_position ?? 0) - (b.group_position ?? 0));
            const needsPassword = queue.some(r => r.requires_password);

            return (
              <Stack spacing={2} sx={{ mt: 1 }}>
                <Alert severity="warning">
                  {queue.length} queries run <strong>one after another</strong> as{' '}
                  <strong>you</strong>, each waiting for the previous to finish. If one fails
                  the run stops there — you can still approve the rest individually
                  afterwards.
                </Alert>


                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Reason given
                  </Typography>
                  <Typography variant="body2">{queue[0]?.reason}</Typography>
                </Box>

                <Stack spacing={1}>
                  {queue.map((record, index) => (
                    <QueryPreviewCard
                      key={record.id}
                      record={record}
                      title={`Query ${index + 1}`}
                      minRows={6}
                      maxRows={16}
                    />
                  ))}
                </Stack>

                {needsPassword && (
                  <TextField
                    type="password"
                    label="Your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    fullWidth
                    required
                    helperText="At least one query is an ALTER/DROP. One confirmation covers the run."
                  />
                )}

                <TextField
                  label="Note (optional)"
                  placeholder="Recorded against every query in this request"
                  value={reviewNote}
                  onChange={(e) => setReviewNote(e.target.value.slice(0, 1000))}
                  fullWidth
                  multiline
                  minRows={2}
                />
              </Stack>
            );
          })()}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setApproveGroupTarget(null)} disabled={actioning}>
            Cancel
          </Button>
          <Button
            variant="contained"
            startIcon={<PlaylistAddCheckIcon />}
            onClick={handleApproveGroup}
            disabled={
              actioning ||
              (approveGroupTarget?.records.some(
                r => r.status === 'PENDING' && r.can_approve !== false && r.requires_password
              ) &&
                !password)
            }
          >
            {actioning ? 'Starting…' : 'Approve & run in order'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Approve */}
      <Dialog
        open={!!approveTarget}
        onClose={actioning ? undefined : () => setApproveTarget(null)}
        maxWidth="lg"
        fullWidth
      >
        <DialogTitle>Approve and run this query?</DialogTitle>
        <DialogContent>
          {approveTarget && (
            <Stack spacing={2} sx={{ mt: 1 }}>
              <Alert severity="warning">
                {(approveTarget.group_size ?? 1) > 1 && (
                  <>
                    <strong>
                      Query {(approveTarget.group_position ?? 0) + 1} of{' '}
                      {approveTarget.group_size}
                    </strong>{' '}
                    in this request — the others are unaffected.{' '}
                  </>
                )}
                This runs immediately on <strong>{approveTarget.database_name}</strong> (
                {approveTarget.execution_mode}) as <strong>you</strong>, with your role's
                permissions. Requested by{' '}
                {approveTarget.requester_name || approveTarget.requester_username}.
              </Alert>

              {approveSiblings.some((r) => r.status === 'FAILED') && (
                <Alert severity="warning">
                  Another query in this request already failed
                    .{' '}
                  You can still approve this one — check the failure first.
                </Alert>
              )}

              <Box>
                <Typography variant="caption" color="text.secondary">
                  Reason given
                </Typography>
                <Typography variant="body2">{approveTarget.reason}</Typography>
              </Box>

              <QueryPreviewCard record={approveTarget} minRows={12} maxRows={24} />

              {approveTarget.requires_password && (
                <TextField
                  type="password"
                  label="Your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  fullWidth
                  required
                  autoFocus
                  helperText="This query contains an ALTER/DROP, which needs password confirmation."
                />
              )}

              <TextField
                label="Note (optional)"
                placeholder="e.g. Approved — verified the WHERE clause matches the ticket"
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value.slice(0, 1000))}
                fullWidth
                multiline
                minRows={2}
              />
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setApproveTarget(null)} disabled={actioning}>
            Cancel
          </Button>
          <Button
            variant="contained"
            startIcon={<CheckCircleIcon />}
            onClick={handleApprove}
            disabled={actioning || (!!approveTarget?.requires_password && !password)}
          >
            {actioning ? 'Running…' : 'Approve & run'}
          </Button>
        </DialogActions>
      </Dialog>

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

      {/* Result */}
      <Dialog open={!!resultTarget} onClose={closeResult} maxWidth="lg" fullWidth>
        <DialogTitle>{isResultRunning ? 'Running…' : 'Result'}</DialogTitle>
        <DialogContent>
          {resultLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
              <CircularProgress size={28} />
            </Box>
          ) : (
            resultTarget && (
              <Stack spacing={2} sx={{ mt: 1 }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip size="small" color={STATUS_COLOR[displayStatus]} label={displayStatus} />
                  <Typography variant="body2" color="text.secondary">
                    {resultTarget.database_name} · {resultTarget.execution_mode}
                  </Typography>
                </Stack>

                {isResultRunning && (
                  <Box>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                      {liveProgress
                        ? `Statement ${liveProgress.currentStatement} of ${liveProgress.totalStatements}`
                        : 'Executing…'}
                    </Typography>
                    <LinearProgress
                      variant={
                        liveProgress?.totalStatements ? 'determinate' : 'indeterminate'
                      }
                      value={
                        liveProgress?.totalStatements
                          ? (liveProgress.currentStatement / liveProgress.totalStatements) * 100
                          : undefined
                      }
                    />
                    {liveProgress?.currentStatementText && (
                      <CodeBlock maxHeight={80}>{liveProgress.currentStatementText}</CodeBlock>
                    )}
                  </Box>
                )}

                {!isResultRunning && resultTarget.error && (
                  <Alert severity="error">{resultTarget.error}</Alert>
                )}

                {/* Partial per-cloud results appear here while the query is
                    still in flight — each cloud lands as it finishes. */}
                {liveResult ? (
                  <ResultsPanel result={liveResult} />
                ) : resultTarget.result_summary ? (
                  <>
                    <Alert severity="info" sx={{ py: 0.5 }}>
                      Full result rows have expired. This is the stored summary.
                    </Alert>
                    <CodeBlock maxHeight={400}>
                      {JSON.stringify(resultTarget.result_summary, null, 2)}
                    </CodeBlock>
                  </>
                ) : (
                  !isResultRunning && (
                    <Typography variant="body2" color="text.secondary">
                      No result recorded.
                    </Typography>
                  )
                )}
              </Stack>
            )
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={closeResult}>
            {isResultRunning ? 'Close (keeps running)' : 'Close'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default QueryRequestsPanel;
