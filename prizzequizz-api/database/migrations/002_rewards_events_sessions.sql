CREATE TABLE IF NOT EXISTS rewards (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  match_id UUID REFERENCES matches(id),
  type VARCHAR(32) NOT NULL,
  amount BIGINT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  reason VARCHAR(80) NOT NULL DEFAULT 'match_result',
  idempotency_key VARCHAR(180) UNIQUE NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  settled_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS match_events (
  id UUID PRIMARY KEY,
  match_id UUID REFERENCES matches(id),
  event_type VARCHAR(80) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS game_sessions (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  match_id UUID REFERENCES matches(id),
  connection_id VARCHAR(160),
  status VARCHAR(24) NOT NULL,
  last_seen_at TIMESTAMP NOT NULL DEFAULT now(),
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_logs (
  id UUID PRIMARY KEY,
  admin_id UUID REFERENCES users(id),
  action VARCHAR(80) NOT NULL,
  target_type VARCHAR(80) NOT NULL,
  target_id VARCHAR(120),
  diff JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rewards_user_time ON rewards(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rewards_idempotency ON rewards(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_match_events_match_time ON match_events(match_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_game_sessions_user_status ON game_sessions(user_id, status);
