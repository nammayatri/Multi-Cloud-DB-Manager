-- Add username and password authentication to existing users table

-- Add username and password columns
ALTER TABLE dual_db_manager.users
ADD COLUMN IF NOT EXISTS username VARCHAR(255) UNIQUE,
ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

-- Update role column to support new roles (MASTER, USER, READER)
-- Drop existing constraint first
ALTER TABLE dual_db_manager.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE dual_db_manager.users ADD CONSTRAINT users_role_check
  CHECK (role IN ('MASTER', 'USER', 'READER', 'viewer'));

-- Change default role from 'viewer' to 'USER' for new users
ALTER TABLE dual_db_manager.users ALTER COLUMN role SET DEFAULT 'USER';

-- Update existing 'viewer' roles to 'READER'
UPDATE dual_db_manager.users SET role = 'READER' WHERE role = 'viewer';

-- is_active default should be false (pending activation)
ALTER TABLE dual_db_manager.users ALTER COLUMN is_active SET DEFAULT false;

-- Grant permissions
GRANT ALL PRIVILEGES ON TABLE dual_db_manager.users TO dual_db_user;

-- Comments
COMMENT ON COLUMN dual_db_manager.users.role IS 'User role: MASTER (full access + user management), USER (read/write queries), READER (read-only queries)';
COMMENT ON COLUMN dual_db_manager.users.is_active IS 'Whether user is activated and can login. Only MASTER can activate users.';
COMMENT ON COLUMN dual_db_manager.users.username IS 'Unique username for login';
COMMENT ON COLUMN dual_db_manager.users.password_hash IS 'Bcrypt hash of user password';
