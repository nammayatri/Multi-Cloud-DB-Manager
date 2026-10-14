ALTER TABLE dual_db_manager.query_requests
  ALTER COLUMN expires_at SET DEFAULT NOW() + INTERVAL '3 days';
