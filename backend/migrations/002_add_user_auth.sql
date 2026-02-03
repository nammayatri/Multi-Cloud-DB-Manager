-- Migration: Add username/password authentication with role-based access control
-- Roles: MASTER, USER, READER

-- Add authentication and role columns to users table
ALTER TABLE dual_db_manager.users
ADD COLUMN IF NOT EXISTS username VARCHAR(255) UNIQUE NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255),
ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'USER' CHECK (role IN ('MASTER', 'USER', 'READER')),
ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Create trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION dual_db_manager.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_users_updated_at ON dual_db_manager.users;
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON dual_db_manager.users
    FOR EACH ROW
    EXECUTE FUNCTION dual_db_manager.update_updated_at_column();

-- Note: First user should register normally, then manually promote to MASTER via SQL:
-- UPDATE dual_db_manager.users SET role='MASTER', is_active=true WHERE username='your_username';

-- Grant permissions
GRANT ALL PRIVILEGES ON TABLE dual_db_manager.users TO dual_db_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA dual_db_manager TO dual_db_user;

COMMENT ON COLUMN dual_db_manager.users.role IS 'User role: MASTER (full access), USER (read/write queries), READER (read-only queries)';
COMMENT ON COLUMN dual_db_manager.users.is_active IS 'Whether user is activated and can login. Only MASTER can activate users.';
