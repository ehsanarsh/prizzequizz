CREATE TABLE IF NOT EXISTS beta_invites (
  code VARCHAR(80) PRIMARY KEY,
  max_uses INT NOT NULL DEFAULT 1,
  used_count INT NOT NULL DEFAULT 0,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  note TEXT,
  created_by UUID,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  expires_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS beta_access (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  invite_code VARCHAR(80) REFERENCES beta_invites(code),
  granted_at TIMESTAMP NOT NULL DEFAULT now(),
  granted_by UUID
);

CREATE INDEX IF NOT EXISTS idx_beta_invites_status ON beta_invites(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_beta_access_invite ON beta_access(invite_code, granted_at DESC);
