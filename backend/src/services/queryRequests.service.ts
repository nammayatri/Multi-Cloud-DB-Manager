import crypto from 'crypto';
import DatabasePools from '../config/database';
import logger from '../utils/logger';
import historyService from './history.service';
import { QueryResponse } from '../types';
import { QueryRequestRecord, QueryRequestStatus } from '../types';

/**
 * Storage + state machine for the query request/approval workflow.
 *
 * Every status transition is a guarded UPDATE (`WHERE status = <expected>`)
 * returning the row: zero rows means someone else got there first. The backend
 * runs multiple pods, so double-approve is a real race, not a theoretical one.
 */

/** An APPROVED/RUNNING request older than this is assumed orphaned by a dead pod. */
const STALE_EXECUTION_MINUTES = 10;

/**
 * Least time between sweeps. The UI polls three list endpoints together, every
 * 3s while a run is in flight, so sweeping per read turned every poll into six
 * UPDATEs against query_requests — steady write traffic and lock churn to
 * discover, almost always, that there was nothing to expire.
 *
 * Both deadlines it enforces are minutes-to-hours wide, so being up to this
 * far behind changes nothing a user can see.
 */
const SWEEP_INTERVAL_MS = 30_000;

const SELECT_WITH_USERS = `
  SELECT
    qr.*,
    (
      SELECT COUNT(*) FROM dual_db_manager.query_requests sibling
      WHERE sibling.group_id = qr.group_id AND sibling.status <> 'SUPERSEDED'
    )::int AS group_size,
    -- Position + status of every query in the request, including ones this
    -- viewer isn't being shown. Without it a filtered list (e.g. /pending,
    -- which returns only PENDING rows) can't tell "already actioned" apart
    -- from "needs a role you don't have". Carries no SQL or reason, so it
    -- widens no visibility.
    (
      SELECT json_agg(
               json_build_object('position', sibling.group_position, 'status', sibling.status)
               ORDER BY sibling.group_position
             )
      FROM dual_db_manager.query_requests sibling
      WHERE sibling.group_id = qr.group_id AND sibling.status <> 'SUPERSEDED'
    ) AS group_statuses,
    requester.username AS requester_username,
    requester.name     AS requester_name,
    requester.email    AS requester_email,
    requester.role     AS requester_role,
    reviewer.username  AS reviewer_username,
    reviewer.name      AS reviewer_name
  FROM dual_db_manager.query_requests qr
  JOIN dual_db_manager.users requester ON requester.id = qr.requester_id
  LEFT JOIN dual_db_manager.users reviewer ON reviewer.id = qr.reviewer_id
`;

/** One query within a request. A request always has at least one. */
export interface QueryRequestItemInput {
  query: string;
  database: string;
  mode: string;
  pgSchema?: string;
  continueOnError?: boolean;
  requiresPassword: boolean;
}

export interface CreateQueryRequestInput {
  requesterId: string;
  /** Shared by every query in the request. */
  reason: string;
  items: QueryRequestItemInput[];
}

class QueryRequestsService {
  private get pool() {
    return DatabasePools.getInstance().history;
  }

  /**
   * Create the table if it isn't there yet. Mirrors historyService.initializeSchema
   * so a fresh deployment works without anyone running migrations/005 by hand
   * (the .sql file remains the record of the change).
   */
  public async initializeSchema(): Promise<void> {
    // Mirrors migrations/005. See that file for why a request is always a
    // group and why there is no separate group table.
    const createTable = `
      CREATE TABLE IF NOT EXISTS dual_db_manager.query_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        requester_id UUID NOT NULL REFERENCES dual_db_manager.users(id) ON DELETE CASCADE,
        query TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        reason TEXT NOT NULL,
        database_name VARCHAR(100) NOT NULL,
        execution_mode VARCHAR(100) NOT NULL,
        pg_schema VARCHAR(100),
        continue_on_error BOOLEAN NOT NULL DEFAULT false,
        requires_password BOOLEAN NOT NULL DEFAULT false,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        reviewer_id UUID REFERENCES dual_db_manager.users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMP,
        review_note TEXT,
        execution_id UUID,
        executed_at TIMESTAMP,
        result_summary JSONB,
        error TEXT,
        group_id UUID NOT NULL,
        group_position INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP,
        expires_at TIMESTAMP NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
        CONSTRAINT query_requests_status_check CHECK (
          status IN ('PENDING', 'APPROVED', 'RUNNING', 'SUCCEEDED', 'FAILED',
                     'REJECTED', 'CANCELLED', 'EXPIRED', 'SUPERSEDED')
        ),
        CONSTRAINT query_requests_reason_check CHECK (length(btrim(reason)) > 0),
        CONSTRAINT query_requests_no_self_review CHECK (
          reviewer_id IS NULL OR reviewer_id <> requester_id
        )
      );
    `;

    const createIndexes = `
      CREATE INDEX IF NOT EXISTS idx_query_requests_pending
        ON dual_db_manager.query_requests(created_at DESC) WHERE status = 'PENDING';
      CREATE INDEX IF NOT EXISTS idx_query_requests_requester
        ON dual_db_manager.query_requests(requester_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_query_requests_reviewer
        ON dual_db_manager.query_requests(reviewer_id, reviewed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_query_requests_group
        ON dual_db_manager.query_requests(group_id, group_position);
    `;

    const linkHistory = `
      ALTER TABLE dual_db_manager.query_history
        ADD COLUMN IF NOT EXISTS request_id UUID
        REFERENCES dual_db_manager.query_requests(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_query_history_request_id
        ON dual_db_manager.query_history(request_id) WHERE request_id IS NOT NULL;
    `;

    try {
      await this.pool.query(createTable);
      await this.pool.query(createIndexes);
      await this.pool.query(linkHistory);
      logger.info('Query requests schema initialized');
    } catch (error) {
      logger.error('Failed to initialize query requests schema:', error);
      throw error;
    }
  }

  /**
   * Pins the exact SQL an approver signed off on. Re-checked immediately before
   * execution so a row rewritten out-of-band never runs under an old approval.
   */
  public hashQuery(query: string): string {
    return crypto.createHash('sha256').update(query, 'utf8').digest('hex');
  }

  /** Row-free result summary — full rows stay in the Redis execution record. */
  public summarizeResponse(response: QueryResponse): Record<string, any> {
    const summary: Record<string, any> = {};
    for (const key of Object.keys(response)) {
      if (key === 'id' || key === 'success') continue;
      summary[key] = historyService.cleanCloudResult(response[key as keyof QueryResponse]);
    }
    return summary;
  }

  /**
   * First real error out of a failed response, prefixed with the cloud it came
   * from.
   *
   * A query that runs but fails on the database reports 'completed' with
   * success=false and no top-level error — the detail sits inside the per-cloud
   * (or per-statement) result. Without digging it out, the requester just sees
   * "Query execution failed", which tells them nothing.
   */
  public firstErrorFrom(response: QueryResponse): string | undefined {
    for (const key of Object.keys(response)) {
      if (key === 'id' || key === 'success') continue;

      const cloud = response[key as keyof QueryResponse] as any;
      if (!cloud || cloud.success) continue;

      if (cloud.error) {
        return `${key}: ${cloud.error}`;
      }

      const failedStatement = cloud.results?.find((r: any) => !r.success && r.error);
      if (failedStatement) {
        return `${key}: ${failedStatement.error}`;
      }
    }

    return undefined;
  }

  /**
   * Create a request. Always a group — of one query in the common case.
   *
   * Every member is a normal request row with its own target and its own
   * lifecycle; the group only records that they were submitted together, their
   * order, and the requester's failure policy. Inserted in a transaction so a
   * half-created request can never exist.
   */
  public async create(
    input: CreateQueryRequestInput
  ): Promise<{ groupId: string; requests: QueryRequestRecord[] }> {
    const groupId = crypto.randomUUID();
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      for (const [index, item] of input.items.entries()) {
        await client.query(
          `INSERT INTO dual_db_manager.query_requests (
             requester_id, query, query_hash, reason, database_name, execution_mode,
             pg_schema, continue_on_error, requires_password,
             group_id, group_position
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            input.requesterId,
            item.query,
            this.hashQuery(item.query),
            // Denormalised onto each member so every existing query path —
            // listing, approval, the history join — keeps working unchanged.
            input.reason.trim(),
            item.database,
            item.mode,
            item.pgSchema || null,
            !!item.continueOnError,
            item.requiresPassword,
            groupId,
            index,
          ]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return { groupId, requests: await this.getGroupMembers(groupId) };
  }

  /** Every query in a request, in submission order. */
  public async getGroupMembers(groupId: string): Promise<QueryRequestRecord[]> {
    const result = await this.pool.query(
      `${SELECT_WITH_USERS} WHERE qr.group_id = $1 ORDER BY qr.group_position ASC, qr.created_at ASC`,
      [groupId]
    );
    return result.rows;
  }

  /**
   * Revise one still-pending query.
   *
   * The original is NOT rewritten. It's marked SUPERSEDED and a replacement row
   * is added to the same request with the new SQL, so what was originally asked
   * for stays on the record — an approver can see that a query was revised
   * rather than silently receiving different bytes than the requester first
   * submitted.
   *
   * The replacement keeps the original's group_position: position drives the
   * order of a "run in order" approval, so appending it would quietly move the
   * revised query to the back of the queue.
   *
   * The reason is NOT touched here — it belongs to the request rather than to
   * one query, so it has its own operation (updateReason).
   *
   * The replacement also inherits the original's expiry, so a request has one
   * bounded lifetime however many times it is revised.
   *
   * Returns the replacement row, or null if the original was no longer pending.
   */
  public async update(
    id: string,
    requesterId: string,
    input: {
      query: string;
      requiresPassword: boolean;
      continueOnError?: boolean;
    }
  ): Promise<QueryRequestRecord | null> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Lock the row so a concurrent approval can't slip in between the check
      // and the supersede.
      const current = await client.query(
        `SELECT * FROM dual_db_manager.query_requests
         WHERE id = $1 AND requester_id = $2 AND status = 'PENDING'
         FOR UPDATE`,
        [id, requesterId]
      );

      if (current.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      const record = current.rows[0];

      // Nothing to supersede if the SQL is unchanged.
      if (input.query === record.query) {
        await client.query('COMMIT');
        return this.getById(id);
      }

      await client.query(
        `UPDATE dual_db_manager.query_requests
         SET status = 'SUPERSEDED', updated_at = NOW()
         WHERE id = $1`,
        [id]
      );

      const replacement = await client.query(
        `INSERT INTO dual_db_manager.query_requests (
           requester_id, query, query_hash, reason, database_name, execution_mode,
           pg_schema, continue_on_error, requires_password,
           group_id, group_position, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          requesterId,
          input.query,
          this.hashQuery(input.query),
          record.reason,
          record.database_name,
          record.execution_mode,
          record.pg_schema,
          input.continueOnError ?? record.continue_on_error,
          input.requiresPassword,
          record.group_id,
          record.group_position,
          // The original's absolute deadline, not a fresh window. Granting a
          // new 24h on every revision would let a requester keep a request
          // alive indefinitely by re-editing it, which is exactly what the
          // expiry exists to prevent. Resubmit is one click if more time is
          // genuinely needed, and that starts an honest new clock.
          record.expires_at,
        ]
      );

      await client.query('COMMIT');
      return this.getById(replacement.rows[0].id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Change the reason on a request.
   *
   * Request-scoped, so it lands on every query still pending in it. Queries
   * that already settled keep the reason they were approved under — the
   * justification for something already executed isn't rewritable.
   *
   * Returns the number of queries updated, or null if the caller owns no
   * pending query in this request.
   */
  public async updateReason(
    groupId: string,
    requesterId: string,
    reason: string
  ): Promise<number | null> {
    const result = await this.pool.query(
      `UPDATE dual_db_manager.query_requests
       SET reason = $3, updated_at = NOW()
       WHERE group_id = $1 AND requester_id = $2 AND status = 'PENDING'
       RETURNING id`,
      [groupId, requesterId, reason.trim()]
    );

    return result.rows.length > 0 ? result.rows.length : null;
  }

  /**
   * Lazy housekeeping, run before every list read so no cron is needed:
   *   - PENDING past its expiry becomes EXPIRED (a day-old query approved
   *     against changed data is a foot-gun)
   *   - APPROVED/RUNNING left behind by a pod that died becomes FAILED, so it
   *     doesn't sit in the UI as perpetually in-flight
   */
  /** Wall-clock of the last sweep started by THIS process. */
  private lastSweptAt = 0;
  private sweepInFlight = false;

  /**
   * Run the sweep if one hasn't run recently, without blocking the caller.
   *
   * Throttled per process rather than globally: with N pods you get at most N
   * sweeps per window, which is bounded and harmless — the UPDATEs are
   * idempotent, and whichever runs first leaves nothing for the others.
   *
   * Fire-and-forget because a list read shouldn't wait on housekeeping. A row
   * that expires between sweeps is still excluded from the pending queue, which
   * filters on expires_at directly; only its displayed status lags.
   */
  public maybeSweep(): void {
    const now = Date.now();
    if (this.sweepInFlight || now - this.lastSweptAt < SWEEP_INTERVAL_MS) {
      return;
    }

    this.lastSweptAt = now;
    this.sweepInFlight = true;
    void this.sweep().finally(() => {
      this.sweepInFlight = false;
    });
  }

  public async sweep(): Promise<void> {
    try {
      await this.pool.query(`
        UPDATE dual_db_manager.query_requests
        SET status = 'EXPIRED'
        WHERE status = 'PENDING' AND expires_at < NOW()
      `);

      await this.pool.query(
        `
        UPDATE dual_db_manager.query_requests
        SET status = 'FAILED',
            error = COALESCE(error, 'Execution status lost — the server handling this request restarted. Check query history before retrying.')
        WHERE status IN ('APPROVED', 'RUNNING')
          AND COALESCE(executed_at, reviewed_at) < NOW() - make_interval(mins => $1::int)
      `,
        [STALE_EXECUTION_MINUTES]
      );
    } catch (error) {
      // Housekeeping must never break a list read.
      logger.error('Query request sweep failed:', error);
    }
  }

  public async getById(id: string): Promise<QueryRequestRecord | null> {
    const result = await this.pool.query(`${SELECT_WITH_USERS} WHERE qr.id = $1`, [id]);
    return result.rows[0] || null;
  }

  public async listForRequester(
    requesterId: string,
    limit = 50,
    offset = 0
  ): Promise<QueryRequestRecord[]> {
    const result = await this.pool.query(
      `${SELECT_WITH_USERS}
       WHERE qr.requester_id = $1
       ORDER BY qr.created_at DESC
       LIMIT $2 OFFSET $3`,
      [requesterId, limit, offset]
    );
    return result.rows;
  }

  /**
   * Every open request except the viewer's own — self-approval is barred, so
   * excluding them here keeps the queue honest. The caller still filters by
   * whether the viewer's role permits each query.
   */
  public async listPendingExcluding(viewerId: string, limit = 100): Promise<QueryRequestRecord[]> {
    const result = await this.pool.query(
      `${SELECT_WITH_USERS}
       WHERE qr.status = 'PENDING'
         AND qr.requester_id <> $1
         AND qr.expires_at > NOW()
       ORDER BY qr.created_at ASC
       LIMIT $2`,
      [viewerId, limit]
    );
    return result.rows;
  }

  /**
   * Every query of every request that has at least one pending query someone
   * other than `viewerId` raised.
   *
   * Returns whole requests rather than just their pending rows: a queue that
   * shows only what's still pending makes a request look like queries vanished
   * as they settle, and leaves no way to tell "already actioned" apart from
   * "needs a role you don't have". The caller decides which rows are
   * actionable.
   *
   * The limit applies to requests, not rows, so a request is never returned
   * half-complete.
   */
  public async listPendingGroups(viewerId: string, groupLimit = 100): Promise<QueryRequestRecord[]> {
    const result = await this.pool.query(
      `WITH candidate_groups AS (
         SELECT p.group_id, MIN(p.created_at) AS first_created
         FROM dual_db_manager.query_requests p
         WHERE p.status = 'PENDING'
           AND p.requester_id <> $1
           AND p.expires_at > NOW()
         GROUP BY p.group_id
         ORDER BY first_created ASC
         LIMIT $2
       )
       ${SELECT_WITH_USERS}
       JOIN candidate_groups cg ON cg.group_id = qr.group_id
       ORDER BY cg.first_created ASC, qr.group_position ASC, qr.created_at ASC`,
      [viewerId, groupLimit]
    );
    return result.rows;
  }

  /**
   * Requests in which something was actually reviewed — approved or rejected.
   *
   * Selects by request, not by row, and returns each one whole: a request where
   * query 1 was approved and query 2 is still pending would otherwise appear
   * with half its queries missing. Withdrawn and expired requests never surface
   * here, since nobody reviewed those.
   *
   * `reviewedBy` narrows to requests THAT person reviewed — still returning the
   * whole request, including queries colleagues actioned. The caller passes it
   * unconditionally for non-super roles, which is both the visibility scope and
   * the only thing that makes this tab distinct from "my requests".
   */
  public async listReviewed(
    options: { limit?: number; offset?: number; reviewedBy?: string } = {}
  ): Promise<QueryRequestRecord[]> {
    const { limit = 50, offset = 0, reviewedBy } = options;
    const values: any[] = [limit, offset];
    let scope = '';

    if (reviewedBy) {
      values.push(reviewedBy);
      scope = `AND r.reviewer_id = $${values.length}`;
    }

    const result = await this.pool.query(
      `WITH candidate_groups AS (
         SELECT r.group_id, MAX(r.reviewed_at) AS last_reviewed
         FROM dual_db_manager.query_requests r
         WHERE r.reviewer_id IS NOT NULL
         ${scope}
         GROUP BY r.group_id
         ORDER BY last_reviewed DESC
         LIMIT $1 OFFSET $2
       )
       ${SELECT_WITH_USERS}
       JOIN candidate_groups cg ON cg.group_id = qr.group_id
       ORDER BY cg.last_reviewed DESC, qr.group_position ASC, qr.created_at ASC`,
      values
    );
    return result.rows;
  }

  /**
   * PENDING -> APPROVED. Returns null if it was no longer PENDING (already
   * approved/rejected/cancelled/expired by someone else).
   */
  public async approve(
    id: string,
    reviewerId: string,
    reviewNote?: string
  ): Promise<QueryRequestRecord | null> {
    const result = await this.pool.query(
      `UPDATE dual_db_manager.query_requests
       SET status = 'APPROVED', reviewer_id = $2, reviewed_at = NOW(), review_note = $3
       WHERE id = $1 AND status = 'PENDING' AND expires_at > NOW()
       RETURNING id`,
      [id, reviewerId, reviewNote || null]
    );

    if (result.rows.length === 0) {
      return null;
    }
    return this.getById(id);
  }

  /** PENDING -> REJECTED. */
  public async reject(
    id: string,
    reviewerId: string,
    reviewNote: string
  ): Promise<QueryRequestRecord | null> {
    const result = await this.pool.query(
      `UPDATE dual_db_manager.query_requests
       SET status = 'REJECTED', reviewer_id = $2, reviewed_at = NOW(), review_note = $3
       WHERE id = $1 AND status = 'PENDING'
       RETURNING id`,
      [id, reviewerId, reviewNote]
    );

    if (result.rows.length === 0) {
      return null;
    }
    return this.getById(id);
  }

  /** PENDING -> CANCELLED, requester only (enforced in the WHERE clause). */
  public async cancel(id: string, requesterId: string): Promise<QueryRequestRecord | null> {
    const result = await this.pool.query(
      `UPDATE dual_db_manager.query_requests
       SET status = 'CANCELLED'
       WHERE id = $1 AND requester_id = $2 AND status = 'PENDING'
       RETURNING id`,
      [id, requesterId]
    );

    if (result.rows.length === 0) {
      return null;
    }
    return this.getById(id);
  }

  /**
   * APPROVED -> RUNNING, recording the execution it was handed to.
   *
   * The execution_id is written unconditionally (guarded only against being
   * overwritten) while the status advance is conditional: a very fast query
   * whose outcome landed first must not be dragged back to RUNNING, but the
   * requester still needs the execution_id to fetch its result.
   */
  public async markRunning(id: string, executionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE dual_db_manager.query_requests
       SET execution_id = $2,
           executed_at = COALESCE(executed_at, NOW()),
           status = CASE WHEN status = 'APPROVED' THEN 'RUNNING' ELSE status END
       WHERE id = $1 AND execution_id IS NULL`,
      [id, executionId]
    );
  }

  /**
   * RUNNING -> terminal. Guarded so a late writer can't overwrite an outcome
   * the staleness sweep already recorded.
   */
  public async markOutcome(
    id: string,
    status: Extract<QueryRequestStatus, 'SUCCEEDED' | 'FAILED'>,
    payload: { resultSummary?: Record<string, any>; error?: string }
  ): Promise<void> {
    await this.pool.query(
      `UPDATE dual_db_manager.query_requests
       SET status = $2, result_summary = $3, error = $4
       WHERE id = $1 AND status IN ('APPROVED', 'RUNNING')`,
      [
        id,
        status,
        payload.resultSummary ? JSON.stringify(payload.resultSummary) : null,
        payload.error || null,
      ]
    );
  }

  /** Count of pending requests not raised by this user (input to the badge). */
  public async listPendingForBadge(viewerId: string): Promise<QueryRequestRecord[]> {
    return this.listPendingExcluding(viewerId, 200);
  }
}

export default new QueryRequestsService();
