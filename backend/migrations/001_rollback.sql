-- ============================================
-- Dual DB Manager - ROLLBACK Schema and Tables
-- ============================================

-- Drop triggers first
DROP TRIGGER IF EXISTS update_dual_db_entries_updated_at ON dual_db_manager.dual_db_entries;
DROP TRIGGER IF EXISTS update_users_updated_at ON dual_db_manager.users;

-- Drop function
DROP FUNCTION IF EXISTS dual_db_manager.update_updated_at_column();

-- Drop tables (in reverse dependency order)
DROP TABLE IF EXISTS dual_db_manager.audit_log CASCADE;
DROP TABLE IF EXISTS dual_db_manager.dual_db_entries CASCADE;
DROP TABLE IF EXISTS dual_db_manager.users CASCADE;

-- Drop schema
DROP SCHEMA IF EXISTS dual_db_manager CASCADE;
