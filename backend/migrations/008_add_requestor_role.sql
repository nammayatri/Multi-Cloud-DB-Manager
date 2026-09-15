-- ============================================
-- Migration 008: Add REQUESTOR role
-- Adds REQUESTOR to the users.role CHECK constraint.
-- REQUESTOR has no execution rights anywhere: no Postgres (not even SELECT),
-- no Redis, no Shudhi, no ClickHouse. It composes queries and submits them for
-- approval; the approver runs them under their own role. It can never approve
-- anything, since approval requires the approver's own role to permit the query.
-- Idempotent and constraint-name-agnostic: discovers the existing CHECK
-- on the role column at runtime so it works regardless of how 001-007 named it.
-- ============================================

DO $$
DECLARE
  existing_constraint text;
BEGIN
  SELECT con.conname INTO existing_constraint
  FROM pg_constraint con
  JOIN pg_class cl ON cl.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = cl.relnamespace
  WHERE n.nspname = 'dual_db_manager'
    AND cl.relname = 'users'
    AND con.contype = 'c'
    AND (pg_get_constraintdef(con.oid) ILIKE '%role%IN%' OR pg_get_constraintdef(con.oid) ILIKE '%role%ANY%')
  LIMIT 1;

  IF existing_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE dual_db_manager.users DROP CONSTRAINT %I', existing_constraint);
  END IF;
END $$;

ALTER TABLE dual_db_manager.users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('MASTER', 'ADMIN', 'USER', 'READER', 'CKH_MANAGER', 'RELEASE_MANAGER', 'CACHE_CLEARER', 'REQUESTOR'));
