ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(24) NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_users_status_updated ON users(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_username_search ON users(username);
