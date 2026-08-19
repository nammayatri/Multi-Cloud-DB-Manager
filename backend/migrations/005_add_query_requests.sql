-- ============================================
-- Migration 005: Query request / approval workflow
--
-- A user whose role cannot run a given query submits it here with a written
-- reason. Someone whose OWN role permits that query approves it, and the query
-- then executes under the APPROVER's identity and role — the requester never
-- gains elevated rights, and no bypass path exists in the permission checks.
--
-- This table is also the audit record for approved SELECTs: query_history
-- deliberately skips read-only statements, so a READER's approved SELECT would
-- otherwise leave no trace anywhere.
--
-- A request is ALWAYS a group, of one query in the common case. There is no
-- separate group table: members are ordinary rows sharing a group_id, so each
-- keeps its own target, status, reviewer, execution and result — and approve,
-- reject, execute and expire all operate on a member with no special casing.
--
-- Idempotent — safe to re-run.
-- ============================================

CREATE TABLE IF NOT EXISTS dual_db_manager.query_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- CASCADE matches query_history: deleting a user already erases their query
    -- history, so keeping orphaned requests around would be inconsistent (and
    -- RESTRICT would break the ADMIN delete-user flow with an FK violation).
    requester_id UUID NOT NULL REFERENCES dual_db_manager.users(id) ON DELETE CASCADE,

    -- The exact SQL that will run. query_hash pins it: the approver approves
    -- these bytes, and the execute path re-verifies the hash before running.
    query TEXT NOT NULL,
    query_hash TEXT NOT NULL,

    -- Why this needs to run. Required — it is the first thing an approver reads.
    -- Shared by every query in a request, so it is written to each member.
    reason TEXT NOT NULL,

    database_name VARCHAR(100) NOT NULL,
    execution_mode VARCHAR(100) NOT NULL,
    pg_schema VARCHAR(100),
    continue_on_error BOOLEAN NOT NULL DEFAULT false,

    -- Computed at submit time: ALTER/DROP (excluding ALTER ... ADD) needs the
    -- approver to re-enter their password, and restricts approval to MASTER/ADMIN.
    requires_password BOOLEAN NOT NULL DEFAULT false,

    -- SUPERSEDED is the original of a revised query: editing a pending query
    -- adds a replacement rather than rewriting it, so what was first asked for
    -- stays on the record.
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',

    reviewer_id UUID REFERENCES dual_db_manager.users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP,
    review_note TEXT,

    execution_id UUID,
    executed_at TIMESTAMP,
    -- Row-free summary (per-cloud success / rowcount / duration / error).
    -- Full result rows live in the Redis execution record until its TTL expires.
    result_summary JSONB,
    error TEXT,

    -- Shared by queries submitted together. No default: the service generates
    -- it and inserts every member in one transaction, so a row that reached
    -- this table without a group is a bug, not something to paper over.
    group_id UUID NOT NULL,
    -- Order within the request, 0-based. Drives the execution order of a
    -- "run in order" approval, not just display. A revision inherits its
    -- predecessor's position, so ties break on created_at.
    group_position INTEGER NOT NULL DEFAULT 0,

    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    -- Bumped when the requester revises a query or edits the reason.
    updated_at TIMESTAMP,
    expires_at TIMESTAMP NOT NULL DEFAULT NOW() + INTERVAL '24 hours',

    CONSTRAINT query_requests_status_check CHECK (
        status IN ('PENDING', 'APPROVED', 'RUNNING', 'SUCCEEDED', 'FAILED',
                   'REJECTED', 'CANCELLED', 'EXPIRED', 'SUPERSEDED')
    ),
    -- Non-empty only, no length policing. Enforced in the Zod schema too; this
    -- is the backstop against direct API calls.
    CONSTRAINT query_requests_reason_check CHECK (length(btrim(reason)) > 0),
    -- No self-approval, for any role.
    CONSTRAINT query_requests_no_self_review CHECK (
        reviewer_id IS NULL OR reviewer_id <> requester_id
    )
);

-- The approval queue reads only PENDING rows — partial index keeps it small.
CREATE INDEX IF NOT EXISTS idx_query_requests_pending
    ON dual_db_manager.query_requests(created_at DESC)
    WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_query_requests_requester
    ON dual_db_manager.query_requests(requester_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_query_requests_reviewer
    ON dual_db_manager.query_requests(reviewer_id, reviewed_at DESC);

-- Members are always fetched by request and rendered in order.
CREATE INDEX IF NOT EXISTS idx_query_requests_group
    ON dual_db_manager.query_requests(group_id, group_position);

-- Links an executed write back to the request that authorised it, so the
-- History tab can answer "who asked for this, who approved it, and why".
ALTER TABLE dual_db_manager.query_history
    ADD COLUMN IF NOT EXISTS request_id UUID
    REFERENCES dual_db_manager.query_requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_query_history_request_id
    ON dual_db_manager.query_history(request_id)
    WHERE request_id IS NOT NULL;

GRANT ALL ON dual_db_manager.query_requests TO db_user;
