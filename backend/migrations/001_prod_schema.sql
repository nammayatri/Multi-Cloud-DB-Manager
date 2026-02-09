-- ============================================
-- Dual DB Manager - Production Schema
-- Run with a superuser (e.g., postgres or RDS master)
-- ============================================

-- 1. Create schema
CREATE SCHEMA IF NOT EXISTS dual_db_manager;

-- 2. Grant schema access to db_user
GRANT ALL ON SCHEMA dual_db_manager TO db_user;

-- 3. Users table (for authentication)
CREATE TABLE IF NOT EXISTS dual_db_manager.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'READER',
    is_active BOOLEAN DEFAULT false,
    picture TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_username ON dual_db_manager.users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON dual_db_manager.users(email);
CREATE INDEX IF NOT EXISTS idx_users_active ON dual_db_manager.users(is_active) WHERE is_active = true;

-- 4. Query history table (for audit trail)
-- database_name: actual DB name (bpp, bap, etc.)
-- execution_mode: cloud name or 'both'
-- cloud_results: JSONB with per-cloud results keyed by cloud name
--   e.g., {"aws": {"success": true, "duration_ms": 50, "result": {...}}, "gcp": {"success": false, "error": "..."}}
CREATE TABLE IF NOT EXISTS dual_db_manager.query_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES dual_db_manager.users(id) ON DELETE CASCADE,
    query TEXT NOT NULL,
    database_name VARCHAR(50) NOT NULL,
    execution_mode VARCHAR(50) NOT NULL,
    cloud_results JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_query_history_user_id ON dual_db_manager.query_history(user_id);
CREATE INDEX IF NOT EXISTS idx_query_history_created_at ON dual_db_manager.query_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_history_database ON dual_db_manager.query_history(database_name);

-- 5. Grant table permissions to db_user
GRANT ALL ON ALL TABLES IN SCHEMA dual_db_manager TO db_user;
GRANT ALL ON ALL SEQUENCES IN SCHEMA dual_db_manager TO db_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA dual_db_manager GRANT ALL ON TABLES TO db_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA dual_db_manager GRANT ALL ON SEQUENCES TO db_user;


