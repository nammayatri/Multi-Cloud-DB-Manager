import { Request, Response, NextFunction } from 'express';
import queryService from '../services/query.service';
import queryRequestsService from '../services/queryRequests.service';
import {
  checkRolePermission,
  canRunDirectly,
  canRequestApproval,
  checkExecutionConstraints,
  requiresPasswordGate,
} from '../services/query/queryPermissions';
import { verifyUserPassword } from '../utils/verifyPassword';
import logger from '../utils/logger';
import { AppError } from '../middleware/error.middleware';
import { isSuperRole } from '../constants/roles';
import { QueryRequestRecord } from '../types';

/**
 * Query request / approval flow.
 *
 * A user whose role can't run a query submits it here with a reason. Anyone
 * whose OWN role permits that query can approve it, at which point it executes
 * under the APPROVER's identity and role — so the normal permission checks
 * authorise it exactly as if the approver had typed it. There is deliberately
 * no "run despite your role" flag anywhere in this file.
 */

/** How long the approving pod watches its execution before giving up. */
const WATCH_TIMEOUT_MS = 6 * 60 * 1000;
const WATCH_INTERVAL_MS = 2000;

/**
 * Can this user approve this request?
 *
 * Two conditions, both required: their role must permit every statement, and —
 * for ALTER/DROP — they must be MASTER/ADMIN, since that gate is super-only on
 * the direct-execution path too.
 */
const canApprove = (role: string | undefined, record: QueryRequestRecord): boolean => {
  if (!role) return false;
  if (record.requires_password && !isSuperRole(role)) return false;
  return checkRolePermission(role, record.query, {
    continueOnError: record.continue_on_error,
  }).allowed;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll an execution to a terminal state and persist a row-free summary on the
 * request. Resolves true only if the query actually succeeded.
 *
 * Needed because the Redis execution record expires (default 300s) — by the
 * time a requester looks, it's gone. If this pod dies mid-poll, the service's
 * staleness sweep closes the row out instead.
 *
 * Awaitable rather than fire-and-forget because the sequential group runner
 * has to know whether a query succeeded before starting the next one.
 */
const awaitExecutionOutcome = async (
  requestId: string,
  executionId: string
): Promise<boolean> => {
  const startedAt = Date.now();

  for (;;) {
    await sleep(WATCH_INTERVAL_MS);

    try {
      const status = await queryService.getExecutionStatus(executionId);

      // Record gone (TTL) before we saw a terminal state — the sweep will close
      // it out rather than us guessing an outcome.
      if (!status) {
        if (Date.now() - startedAt > WATCH_TIMEOUT_MS) return false;
        continue;
      }

      if (status.status === 'running') {
        if (Date.now() - startedAt > WATCH_TIMEOUT_MS) {
          await queryRequestsService.markOutcome(requestId, 'FAILED', {
            error:
              'Timed out waiting for the query to finish. Check query history for the final outcome.',
          });
          return false;
        }
        continue;
      }

      const resultSummary = status.result
        ? queryRequestsService.summarizeResponse(status.result)
        : undefined;

      if (status.status === 'completed' && status.result?.success) {
        await queryRequestsService.markOutcome(requestId, 'SUCCEEDED', { resultSummary });
        logger.info('Query request execution finished', { requestId, executionId, ok: true });
        return true;
      }

      if (status.status === 'cancelled') {
        // Distinct from the CANCELLED status, which means the requester
        // withdrew the request before it ever ran.
        await queryRequestsService.markOutcome(requestId, 'FAILED', {
          resultSummary,
          error: 'Query execution was cancelled',
        });
        return false;
      }

      // status.error covers a thrown execution; a query that ran and failed on
      // the database carries its detail per-cloud instead.
      const failureDetail = status.result
        ? queryRequestsService.firstErrorFrom(status.result)
        : undefined;

      await queryRequestsService.markOutcome(requestId, 'FAILED', {
        resultSummary,
        error: status.error || failureDetail || 'Query execution failed',
      });
      return false;
    } catch (error: any) {
      logger.error('Failed to record query request outcome', {
        requestId,
        executionId,
        error: error.message,
      });
      return false;
    }
  }
};

/** Fire-and-forget wrapper for the single-query approval path. */
const watchExecution = (requestId: string, executionId: string): void => {
  void awaitExecutionOutcome(requestId, executionId);
};

/**
 * Submit a request: one or more queries under a shared reason.
 *
 * There is exactly one creation path. A request is always a group — of a
 * single query in the common case — so nothing downstream has to branch on
 * "grouped or not". Each item carries its own target database and cloud, which
 * is what a multi-statement query can't express, and each is approved
 * separately by whoever's role permits that particular statement.
 *
 * Every item is validated before anything is written, so an invalid query in
 * position 3 doesn't leave two orphaned rows behind.
 */
export const createRequest = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    const { reason, items } = req.body;

    if (!canRequestApproval(user.role)) {
      throw new AppError(
        isSuperRole(user.role)
          ? 'Your role can already execute queries directly — no approval needed.'
          : `Role ${user.role} does not have Postgres access, so there is nothing to request.`,
        403
      );
    }

    const prepared: Array<{
      query: string;
      database: string;
      mode: string;
      pgSchema?: string;
      continueOnError?: boolean;
      requiresPassword: boolean;
    }> = [];

    const multiple = (items as any[]).length > 1;

    for (const [index, item] of (items as any[]).entries()) {
      // Only prefix when there's more than one — "Query 1: ..." on a single
      // query request is noise.
      const label = multiple ? `Query ${index + 1}` : '';
      const prefix = label ? `${label}: ` : '';

      const validation = queryService.validateQuery(item.query);
      if (!validation.valid) {
        throw new AppError(`${prefix}${validation.error || 'Invalid query'}`, 400);
      }

      if (canRunDirectly(user.role, item.query, { continueOnError: item.continueOnError }).allowed) {
        throw new AppError(
          `${prefix}your role can already run this — execute it directly instead of requesting approval.`,
          400
        );
      }

      const constraints = checkExecutionConstraints({
        query: item.query,
        database: item.database,
        mode: item.mode,
        pgSchema: item.pgSchema,
      });
      if (!constraints.ok) {
        throw new AppError(`${prefix}${constraints.message}`, constraints.status || 400);
      }

      prepared.push({
        query: item.query,
        database: item.database,
        mode: item.mode,
        pgSchema: item.pgSchema,
        continueOnError: item.continueOnError,
        requiresPassword: !!requiresPasswordGate(item.query),
      });
    }

    const { groupId, requests } = await queryRequestsService.create({
      requesterId: user.id,
      reason,
      items: prepared,
    });

    logger.info('Query request submitted', {
      groupId,
      username: user.username,
      role: user.role,
      size: prepared.length,
    });

    res.status(201).json({ groupId, requests });
  } catch (error) {
    next(error);
  }
};

/** Every member of a group the caller is allowed to see. */
export const getGroup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    const members = await queryRequestsService.getGroupMembers(req.params.groupId);

    if (members.length === 0) {
      throw new AppError('Group not found', 404);
    }

    const visible = members.filter(m => canView(user, m));
    if (visible.length === 0) {
      throw new AppError('You do not have access to this group', 403);
    }

    res.json({
      groupId: req.params.groupId,
      requests: visible,
      // Flagged so the UI can say "2 of 5 shown" rather than silently hiding
      // the members this viewer's role can't approve.
      totalInGroup: members.length,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Revise the SQL of a still-pending query — the requester fixing a typo, rather than
 * withdrawing and starting over.
 *
 * Safe because approval and execution are a single atomic action: there is no
 * window in which an approved request sits around waiting to run, so an edit
 * can never change what an approval already covered. The status guard in the
 * UPDATE closes the remaining race.
 */
export const updateRequest = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    const { query, continueOnError } = req.body;

    const record = await queryRequestsService.getById(req.params.id);
    if (!record) {
      throw new AppError('Request not found', 404);
    }
    if (record.requester_id !== user.id) {
      throw new AppError('You can only edit your own requests', 403);
    }
    if (record.status !== 'PENDING') {
      throw new AppError(
        `This request can no longer be edited (status: ${record.status})`,
        409
      );
    }

    // The amended content faces every check the original did — otherwise edit
    // becomes a way to smuggle past the checks that guarded creation.
    const validation = queryService.validateQuery(query);
    if (!validation.valid) {
      throw new AppError(validation.error || 'Invalid query', 400);
    }

    const direct = canRunDirectly(user.role, query, { continueOnError });
    if (direct.allowed) {
      throw new AppError(
        'Your role can already run this query — withdraw the request and execute it directly.',
        400
      );
    }

    const constraints = checkExecutionConstraints({
      query,
      database: record.database_name,
      mode: record.execution_mode,
      pgSchema: record.pg_schema || undefined,
    });
    if (!constraints.ok) {
      throw new AppError(constraints.message!, constraints.status || 400);
    }

    const updated = await queryRequestsService.update(record.id, user.id, {
      query,
      // Recomputed, not carried over: an edit can turn an UPDATE into an ALTER,
      // which changes who is allowed to approve it.
      requiresPassword: !!requiresPasswordGate(query),
      continueOnError,
    });

    if (!updated) {
      throw new AppError('This request was actioned while you were editing it', 409);
    }

    logger.info('Query request edited', { requestId: record.id, username: user.username });

    res.json({ request: updated });
  } catch (error) {
    next(error);
  }
};

/**
 * Change the reason on a request.
 *
 * Separate from revising a query because the scopes differ: a reason belongs to
 * the whole request, a query to itself. Editing the reason doesn't supersede
 * anything, so folding it into the revision endpoint meant one call with two
 * unrelated effects.
 */
export const updateReason = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    const { reason } = req.body;

    const updated = await queryRequestsService.updateReason(
      req.params.groupId,
      user.id,
      reason
    );

    if (updated === null) {
      throw new AppError(
        'Nothing to update — the request is not yours, or none of its queries are still pending.',
        404
      );
    }

    logger.info('Query request reason updated', {
      groupId: req.params.groupId,
      username: user.username,
      queriesUpdated: updated,
    });

    res.json({ groupId: req.params.groupId, updated });
  } catch (error) {
    next(error);
  }
};

/**
 * The requester's own requests.
 */
export const listMyRequests = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    queryRequestsService.maybeSweep();

    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 100);
    const offset = parseInt(String(req.query.offset || '0'), 10) || 0;

    const requests = await queryRequestsService.listForRequester(user.id, limit, offset);
    res.json({ requests });
  } catch (error) {
    next(error);
  }
};

/**
 * Pending requests THIS user is able to approve.
 *
 * Filtered per viewer rather than by a fixed role list, because approval
 * authority follows the query: a USER sees a READER's INSERT, but not a
 * DELETE that only MASTER/ADMIN could run.
 */
export const listPendingApprovals = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    queryRequestsService.maybeSweep();

    const rows = await queryRequestsService.listPendingGroups(user.id);

    // Whole requests come back; a request is included only if at least one of
    // its pending queries is actionable by this viewer. Every row is annotated
    // so the UI knows which have buttons — it can't work that out itself, since
    // approval depends on the SQL.
    const byGroup = new Map<string, QueryRequestRecord[]>();
    for (const row of rows) {
      const members = byGroup.get(row.group_id) ?? [];
      members.push(row);
      byGroup.set(row.group_id, members);
    }

    const requests: Array<QueryRequestRecord & { can_approve: boolean }> = [];
    for (const members of byGroup.values()) {
      const annotated = members.map(member => ({
        ...member,
        can_approve:
          member.status === 'PENDING' &&
          member.requester_id !== user.id &&
          canApprove(user.role, member),
      }));

      if (annotated.some(m => m.can_approve)) {
        requests.push(...annotated);
      }
    }

    res.json({ requests });
  } catch (error) {
    next(error);
  }
};

/**
 * Badge count — same filtering as the queue above.
 */
export const getPendingCount = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    const pending = await queryRequestsService.listPendingForBadge(user.id);
    res.json({ count: pending.filter(r => canApprove(user.role, r)).length });
  } catch (error) {
    next(error);
  }
};

/**
 * The review log: what you approved or rejected.
 *
 * Deliberately NOT "requests you were involved in" — anything you raised is
 * already under your own requests, and listing it here too meant the same
 * request appeared in two tabs. Reviewed answers a different question: what
 * have I signed off on.
 *
 * MASTER/ADMIN can widen it to everyone's reviews, which is the audit view and
 * mirrors query history, where only super roles see other people's rows.
 */
export const listReviewed = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    queryRequestsService.maybeSweep();

    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 100);
    const offset = parseInt(String(req.query.offset || '0'), 10) || 0;
    // Non-super roles only ever see their own reviews; for them the scope and
    // the filter are the same thing. Super roles choose.
    const reviewedBy = isSuperRole(user.role)
      ? req.query.reviewedBy === 'me'
        ? user.id
        : undefined
      : user.id;

    const requests = await queryRequestsService.listReviewed({ limit, offset, reviewedBy });
    res.json({ requests });
  } catch (error) {
    next(error);
  }
};

/** Requester, reviewer, a potential approver, or a super role. */
const canView = (user: Express.User, record: QueryRequestRecord): boolean =>
  record.requester_id === user.id ||
  record.reviewer_id === user.id ||
  isSuperRole(user.role) ||
  (record.status === 'PENDING' && canApprove(user.role, record));

export const getRequest = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    const record = await queryRequestsService.getById(req.params.id);

    if (!record) {
      throw new AppError('Request not found', 404);
    }
    if (!canView(user, record)) {
      throw new AppError('You do not have access to this request', 403);
    }

    res.json({ request: record, canApprove: record.requester_id !== user.id && canApprove(user.role, record) });
  } catch (error) {
    next(error);
  }
};

/**
 * Approve and run.
 *
 * Every gate the direct-execution path applies is re-applied here against the
 * APPROVER, in the same order: role policy, password challenge, then the
 * role-independent execution constraints.
 */
export const approveRequest = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    const { password, reviewNote, expectedHash } = req.body;

    const record = await queryRequestsService.getById(req.params.id);
    if (!record) {
      throw new AppError('Request not found', 404);
    }

    // Approve exactly what you read. The requester can amend a pending request,
    // so the version on the approver's screen may be stale by the time they
    // click — refuse rather than run something they never looked at.
    if (expectedHash && expectedHash !== record.query_hash) {
      throw new AppError(
        'This request was edited after you opened it. Review the updated query and approve again.',
        409
      );
    }

    // No self-approval, for any role. Also enforced by a CHECK constraint.
    if (record.requester_id === user.id) {
      throw new AppError('You cannot approve your own request', 403);
    }

    if (record.status !== 'PENDING') {
      throw new AppError(`This request is no longer pending (status: ${record.status})`, 409);
    }

    if (new Date(record.expires_at).getTime() < Date.now()) {
      throw new AppError('This request has expired. Ask the requester to resubmit it.', 409);
    }

    // Integrity: the approver approves exactly the bytes that will run.
    if (queryRequestsService.hashQuery(record.query) !== record.query_hash) {
      logger.error('Query request hash mismatch — refusing to execute', { requestId: record.id });
      throw new AppError(
        'This request failed its integrity check and cannot be executed. Please ask the requester to resubmit it.',
        409
      );
    }

    // 1. The approver's own role must permit every statement.
    const roleVerdict = checkRolePermission(user.role, record.query, {
      continueOnError: record.continue_on_error,
    });
    if (!roleVerdict.allowed) {
      throw new AppError(
        `Your role cannot approve this query — ${roleVerdict.message}`,
        403
      );
    }

    // 2. ALTER/DROP: MASTER/ADMIN only, and the approver re-enters their password.
    const sensitiveOperation = requiresPasswordGate(record.query);
    if (sensitiveOperation) {
      if (!isSuperRole(user.role)) {
        throw new AppError('Only MASTER or ADMIN users can approve ALTER/DROP queries', 403);
      }
      if (!password) {
        throw new AppError('Password verification required to approve this query', 400);
      }

      const passwordValid = await verifyUserPassword(user.username, password);
      if (passwordValid === null) {
        throw new AppError('User not found', 404);
      }
      if (!passwordValid) {
        logger.warn('Password verification failed approving a query request', {
          requestId: record.id,
          username: user.username,
        });
        throw new AppError('Invalid password', 401);
      }
    }

    // 3. Re-check the execution constraints — the cloud configuration may have
    //    changed between submission and approval.
    const constraints = checkExecutionConstraints({
      query: record.query,
      database: record.database_name,
      mode: record.execution_mode,
      pgSchema: record.pg_schema || undefined,
    });
    if (!constraints.ok) {
      throw new AppError(constraints.message!, constraints.status || 400);
    }

    // Guarded transition — zero rows means another approver won the race.
    const approved = await queryRequestsService.approve(record.id, user.id, reviewNote);
    if (!approved) {
      throw new AppError('This request was already actioned by someone else', 409);
    }

    let executionId: string;
    try {
      executionId = await queryService.startExecution(
        {
          query: record.query,
          database: record.database_name,
          mode: record.execution_mode,
          pgSchema: record.pg_schema || undefined,
          continueOnError: record.continue_on_error,
          userRole: user.role,
          requestId: record.id,
        },
        user.id // the approver runs it, and owns the resulting history row
      );
    } catch (error: any) {
      await queryRequestsService.markOutcome(record.id, 'FAILED', {
        error: `Failed to start execution: ${error.message}`,
      });
      throw error;
    }

    await queryRequestsService.markRunning(record.id, executionId);
    watchExecution(record.id, executionId);

    logger.info('Query request approved and executing', {
      requestId: record.id,
      executionId,
      approver: user.username,
      approverRole: user.role,
      requester: record.requester_username,
    });

    res.json({ requestId: record.id, executionId, status: 'RUNNING' });
  } catch (error) {
    next(error);
  }
};

/**
 * Run the approved queries of a request one after another.
 *
 * Sequential by design: "in order" is only meaningful if each query has
 * finished before the next starts, so this awaits each outcome rather than
 * firing them all off.
 *
 * A failure stops the loop. The remaining
 * queries stay PENDING — deliberately, so a reviewer can still approve them
 * individually once they've looked at what went wrong. Nothing is marked
 * rejected or cancelled on their behalf.
 *
 * Runs detached from the HTTP request: a request of five queries can take
 * minutes, and the client polls the group for progress.
 */
const runGroupSequentially = async (
  ids: string[],
  approver: Express.User,
  reviewNote?: string
): Promise<void> => {
  for (const id of ids) {
    const record = await queryRequestsService.getById(id);

    // Someone approved or rejected this one individually while we worked
    // toward it — the guarded transitions mean first writer wins.
    if (!record || record.status !== 'PENDING') continue;

    const approved = await queryRequestsService.approve(id, approver.id, reviewNote);
    if (!approved) continue;

    let executionId: string;
    try {
      executionId = await queryService.startExecution(
        {
          query: record.query,
          database: record.database_name,
          mode: record.execution_mode,
          pgSchema: record.pg_schema || undefined,
          continueOnError: record.continue_on_error,
          userRole: approver.role,
          requestId: record.id,
        },
        approver.id
      );
    } catch (error: any) {
      await queryRequestsService.markOutcome(id, 'FAILED', {
        error: `Failed to start execution: ${error.message}`,
      });
      return;
    }

    await queryRequestsService.markRunning(id, executionId);

    const succeeded = await awaitExecutionOutcome(id, executionId);
    if (!succeeded) {
      logger.warn('Stopping request run after a failure', {
        groupId: record.group_id,
        failedAt: record.group_position,
      });
      return;
    }
  }
};

/**
 * Approve every pending query in a request, running them in order.
 *
 * Requires that the approver can action ALL of them: running queries 1 and 3
 * while skipping 2 would silently break the ordering the requester asked for.
 * A mixed request has to be approved query by query instead, and the error
 * says so.
 */
export const approveGroup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    const { password, reviewNote } = req.body;

    const members = await queryRequestsService.getGroupMembers(req.params.groupId);
    if (members.length === 0) {
      throw new AppError('Request not found', 404);
    }

    const pending = members.filter(m => m.status === 'PENDING');
    if (pending.length === 0) {
      throw new AppError('Nothing left to approve in this request', 409);
    }

    // No self-approval, for any role.
    if (pending.some(m => m.requester_id === user.id)) {
      throw new AppError('You cannot approve your own request', 403);
    }

    const positionsOf = (records: QueryRequestRecord[]) =>
      records.map(r => (r.group_position ?? 0) + 1).join(', ');

    const notPermitted = pending.filter(m => !canApprove(user.role, m));
    if (notPermitted.length > 0) {
      throw new AppError(
        `Quer${notPermitted.length === 1 ? 'y' : 'ies'} ${positionsOf(notPermitted)} need a role you don't have, so this request can't be run in order. Approve the ones you can individually instead.`,
        403
      );
    }

    const expired = pending.filter(m => new Date(m.expires_at).getTime() < Date.now());
    if (expired.length > 0) {
      throw new AppError('This request has expired. Ask the requester to resubmit it.', 409);
    }

    // Every gate the single-query path applies, applied to each query up front —
    // better to refuse the whole run than to fail halfway through.
    for (const member of pending) {
      const position = (member.group_position ?? 0) + 1;

      if (queryRequestsService.hashQuery(member.query) !== member.query_hash) {
        logger.error('Query request hash mismatch — refusing to execute', { requestId: member.id });
        throw new AppError(
          `Query ${position} failed its integrity check and cannot be executed. Ask the requester to resubmit it.`,
          409
        );
      }

      const constraints = checkExecutionConstraints({
        query: member.query,
        database: member.database_name,
        mode: member.execution_mode,
        pgSchema: member.pg_schema || undefined,
      });
      if (!constraints.ok) {
        throw new AppError(`Query ${position}: ${constraints.message}`, constraints.status || 400);
      }
    }

    // One password challenge covers the run, if any query in it needs one.
    if (pending.some(m => m.requires_password)) {
      if (!isSuperRole(user.role)) {
        throw new AppError('Only MASTER or ADMIN users can approve ALTER/DROP queries', 403);
      }
      if (!password) {
        throw new AppError('Password verification required to approve this request', 400);
      }

      const passwordValid = await verifyUserPassword(user.username, password);
      if (passwordValid === null) {
        throw new AppError('User not found', 404);
      }
      if (!passwordValid) {
        logger.warn('Password verification failed approving a query request', {
          groupId: req.params.groupId,
          username: user.username,
        });
        throw new AppError('Invalid password', 401);
      }
    }

    const ordered = [...pending].sort(
      (a, b) => (a.group_position ?? 0) - (b.group_position ?? 0)
    );

    // Detached: the client polls the request for progress.
    void runGroupSequentially(ordered.map(m => m.id), user, reviewNote);

    logger.info('Query request group approved', {
      groupId: req.params.groupId,
      approver: user.username,
      approverRole: user.role,
      queued: ordered.length,
    });

    res.json({ groupId: req.params.groupId, queued: ordered.length, status: 'RUNNING' });
  } catch (error) {
    next(error);
  }
};

export const rejectRequest = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    const { reviewNote } = req.body;

    const record = await queryRequestsService.getById(req.params.id);
    if (!record) {
      throw new AppError('Request not found', 404);
    }
    if (record.requester_id === user.id) {
      throw new AppError('You cannot review your own request — cancel it instead', 403);
    }
    if (!canApprove(user.role, record)) {
      throw new AppError('Your role cannot review this request', 403);
    }

    const rejected = await queryRequestsService.reject(record.id, user.id, reviewNote);
    if (!rejected) {
      throw new AppError('This request was already actioned by someone else', 409);
    }

    logger.info('Query request rejected', {
      requestId: record.id,
      reviewer: user.username,
      requester: record.requester_username,
    });

    res.json({ request: rejected });
  } catch (error) {
    next(error);
  }
};

/**
 * Reject every pending query in a request that this user is able to review.
 *
 * Unlike approval, a partial reject is harmless — there's no ordering to
 * preserve and nothing executes — so queries needing a role this user doesn't
 * have are simply left pending, and the count is reported back.
 */
export const rejectGroup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    const { reviewNote } = req.body;

    const members = await queryRequestsService.getGroupMembers(req.params.groupId);
    if (members.length === 0) {
      throw new AppError('Request not found', 404);
    }

    const pending = members.filter(m => m.status === 'PENDING');
    if (pending.length === 0) {
      throw new AppError('Nothing left to reject in this request', 409);
    }

    if (pending.some(m => m.requester_id === user.id)) {
      throw new AppError('You cannot review your own request — withdraw it instead', 403);
    }

    const reviewable = pending.filter(m => canApprove(user.role, m));
    if (reviewable.length === 0) {
      throw new AppError('Your role cannot review any query in this request', 403);
    }

    let rejected = 0;
    for (const member of reviewable) {
      // Guarded per row: anything actioned in the meantime is simply skipped.
      if (await queryRequestsService.reject(member.id, user.id, reviewNote)) {
        rejected += 1;
      }
    }

    logger.info('Query request group rejected', {
      groupId: req.params.groupId,
      reviewer: user.username,
      rejected,
      skipped: pending.length - reviewable.length,
    });

    res.json({
      groupId: req.params.groupId,
      rejected,
      skipped: pending.length - reviewable.length,
    });
  } catch (error) {
    next(error);
  }
};

/** The requester withdraws their own pending request. */
export const cancelRequest = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;

    const cancelled = await queryRequestsService.cancel(req.params.id, user.id);
    if (!cancelled) {
      throw new AppError(
        'Request not found, not yours, or no longer pending',
        404
      );
    }

    res.json({ request: cancelled });
  } catch (error) {
    next(error);
  }
};

/**
 * Withdraw every pending query in your own request.
 *
 * Only touches PENDING rows, so anything already approved or run is left
 * alone — withdrawing can't retract something that already executed.
 */
export const cancelGroup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;

    const members = await queryRequestsService.getGroupMembers(req.params.groupId);
    if (members.length === 0) {
      throw new AppError('Request not found', 404);
    }

    // Every query in a request shares one requester.
    if (members[0].requester_id !== user.id) {
      throw new AppError('You can only withdraw your own requests', 403);
    }

    const pending = members.filter(m => m.status === 'PENDING');
    if (pending.length === 0) {
      throw new AppError('Nothing left to withdraw in this request', 409);
    }

    let cancelled = 0;
    for (const member of pending) {
      // Guarded per row: anything approved in the meantime is simply skipped.
      if (await queryRequestsService.cancel(member.id, user.id)) {
        cancelled += 1;
      }
    }

    logger.info('Query request group withdrawn', {
      groupId: req.params.groupId,
      username: user.username,
      cancelled,
    });

    res.json({ groupId: req.params.groupId, cancelled });
  } catch (error) {
    next(error);
  }
};

/**
 * Outcome of an approved request.
 *
 * The stored summary is row-free and permanent; `live` carries the full result
 * rows but only while the Redis execution record survives its TTL.
 */
export const getRequestResult = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    const record = await queryRequestsService.getById(req.params.id);

    if (!record) {
      throw new AppError('Request not found', 404);
    }

    // Deliberately narrower than canView: this payload can contain result rows,
    // so a would-be approver who never actioned it doesn't get to see them.
    const allowed =
      record.requester_id === user.id ||
      record.reviewer_id === user.id ||
      isSuperRole(user.role);

    if (!allowed) {
      throw new AppError('You do not have access to this result', 403);
    }

    let live = null;
    if (record.execution_id) {
      live = await queryService.getExecutionStatus(record.execution_id);
    }

    res.json({ request: record, live });
  } catch (error) {
    next(error);
  }
};
