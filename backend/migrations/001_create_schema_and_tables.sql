-- ============================================
-- Dual DB Manager - Schema and Tables
-- ============================================

-- Create dedicated schema
CREATE SCHEMA IF NOT EXISTS dual_db_manager;

-- ============================================
-- 1. USERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS dual_db_manager.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'viewer', -- viewer, operator, admin
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMP
);

-- Index for quick lookups
CREATE INDEX idx_users_email ON dual_db_manager.users(email);
CREATE INDEX idx_users_active ON dual_db_manager.users(is_active) WHERE is_active = true;

COMMENT ON TABLE dual_db_manager.users IS 'Users who can access the dual DB manager tool';
COMMENT ON COLUMN dual_db_manager.users.role IS 'viewer: read-only, operator: can execute operations, admin: full access';

-- ============================================
-- 2. DUAL DB ENTRIES TABLE (Main tracking)
-- ============================================
CREATE TABLE IF NOT EXISTS dual_db_manager.dual_db_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Record identification
    table_name VARCHAR(255) NOT NULL,
    record_id VARCHAR(255) NOT NULL,

    -- Operation details
    operation VARCHAR(50) NOT NULL, -- INSERT, UPDATE, DELETE

    -- AWS status
    aws_status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, success, failed, skipped
    aws_executed_at TIMESTAMP,
    aws_error TEXT,
    aws_retry_count INT DEFAULT 0,

    -- GCP status
    gcp_status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, success, failed, skipped
    gcp_executed_at TIMESTAMP,
    gcp_error TEXT,
    gcp_retry_count INT DEFAULT 0,

    -- Metadata
    priority INT DEFAULT 0, -- Higher = more urgent
    payload JSONB, -- Store the actual data to write
    notes TEXT,

    -- Audit
    created_by UUID REFERENCES dual_db_manager.users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP,

    -- Constraints
    CONSTRAINT valid_operation CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
    CONSTRAINT valid_aws_status CHECK (aws_status IN ('pending', 'success', 'failed', 'skipped')),
    CONSTRAINT valid_gcp_status CHECK (gcp_status IN ('pending', 'success', 'failed', 'skipped'))
);

-- Indexes for performance
CREATE INDEX idx_dual_db_table_record ON dual_db_manager.dual_db_entries(table_name, record_id);
CREATE INDEX idx_dual_db_aws_status ON dual_db_manager.dual_db_entries(aws_status) WHERE aws_status = 'pending';
CREATE INDEX idx_dual_db_gcp_status ON dual_db_manager.dual_db_entries(gcp_status) WHERE gcp_status = 'pending';
CREATE INDEX idx_dual_db_created_at ON dual_db_manager.dual_db_entries(created_at DESC);
CREATE INDEX idx_dual_db_priority ON dual_db_manager.dual_db_entries(priority DESC) WHERE aws_status = 'pending' OR gcp_status = 'pending';
CREATE INDEX idx_dual_db_payload ON dual_db_manager.dual_db_entries USING GIN (payload);

COMMENT ON TABLE dual_db_manager.dual_db_entries IS 'Tracks dual write operations across AWS and GCP';

-- ============================================
-- 3. HISTORY/AUDIT LOG TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS dual_db_manager.audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- What happened
    action VARCHAR(100) NOT NULL, -- 'entry_created', 'entry_updated', 'operation_executed', 'manual_retry', etc.
    entity_type VARCHAR(50) NOT NULL, -- 'dual_db_entry', 'user', 'system'
    entity_id UUID, -- ID of the affected entity

    -- Details
    details JSONB, -- Flexible field for storing action-specific data
    status VARCHAR(50), -- success, failed, info, warning
    error_message TEXT,

    -- Context
    performed_by UUID REFERENCES dual_db_manager.users(id),
    ip_address INET,
    user_agent TEXT,

    -- Timing
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes for audit queries
CREATE INDEX idx_audit_log_entity ON dual_db_manager.audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_action ON dual_db_manager.audit_log(action);
CREATE INDEX idx_audit_log_created_at ON dual_db_manager.audit_log(created_at DESC);
CREATE INDEX idx_audit_log_performed_by ON dual_db_manager.audit_log(performed_by);
CREATE INDEX idx_audit_log_details ON dual_db_manager.audit_log USING GIN (details);

COMMENT ON TABLE dual_db_manager.audit_log IS 'Complete audit trail of all actions in the dual DB manager';

-- ============================================
-- 4. AUTO-UPDATE TRIGGERS
-- ============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION dual_db_manager.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for users table
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON dual_db_manager.users
    FOR EACH ROW
    EXECUTE FUNCTION dual_db_manager.update_updated_at_column();

-- Trigger for dual_db_entries table
CREATE TRIGGER update_dual_db_entries_updated_at
    BEFORE UPDATE ON dual_db_manager.dual_db_entries
    FOR EACH ROW
    EXECUTE FUNCTION dual_db_manager.update_updated_at_column();

-- ============================================
-- 5. SEED DATA (Default admin user)
-- ============================================
INSERT INTO dual_db_manager.users (email, name, role, is_active)
VALUES
    ('admin@example.com', 'System Admin', 'admin', true),
    ('ops@example.com', 'Operations Team', 'operator', true)
ON CONFLICT (email) DO NOTHING;

-- ============================================
-- 6. GRANT PERMISSIONS
-- ============================================
-- Grant usage on schema
GRANT USAGE ON SCHEMA dual_db_manager TO dual_db_user;

-- Grant table permissions
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA dual_db_manager TO dual_db_user;
GRANT SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA dual_db_manager TO dual_db_user;

-- Grant execute on functions
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA dual_db_manager TO dual_db_user;

-- ============================================
-- VERIFICATION QUERIES
-- ============================================
-- Check schema exists
-- SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'dual_db_manager';

-- Check tables exist
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'dual_db_manager';

-- Check indexes
-- SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'dual_db_manager';
