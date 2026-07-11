CREATE TABLE IF NOT EXISTS reward_holds (
  id UUID PRIMARY KEY,
  reward_id UUID NOT NULL,
  user_id UUID REFERENCES users(id),
  match_id UUID REFERENCES matches(id),
  reward_type VARCHAR(32) NOT NULL,
  amount BIGINT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  risk_score INT NOT NULL DEFAULT 0,
  risk_level VARCHAR(24) NOT NULL DEFAULT 'low',
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}',
  idempotency_key VARCHAR(180) UNIQUE NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMP,
  reviewed_by UUID,
  released_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reward_holds_status_time ON reward_holds(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reward_holds_user_time ON reward_holds(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reward_holds_match ON reward_holds(match_id);
