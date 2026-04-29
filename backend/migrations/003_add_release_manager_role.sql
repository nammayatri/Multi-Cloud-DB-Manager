-- ============================================
-- Migration 003: Add RELEASE_MANAGER role
-- Adds RELEASE_MANAGER to the users.role CHECK constraint.
-- Idempotent and constraint-name-agnostic: discovers the existing CHECK
-- on the role column at runtime so it works regardless of how 001/002 named it.
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
    AND pg_get_constraintdef(con.oid) ILIKE '%role%IN%'
  LIMIT 1;

  IF existing_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE dual_db_manager.users DROP CONSTRAINT %I', existing_constraint);
  END IF;
END $$;

ALTER TABLE dual_db_manager.users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('MASTER', 'USER', 'READER', 'CKH_MANAGER', 'RELEASE_MANAGER'));
