CREATE TABLE IF NOT EXISTS integrity_signals (
  id UUID PRIMARY KEY,
  match_id UUID REFERENCES matches(id),
  user_id UUID REFERENCES users(id),
  question_id UUID REFERENCES questions(id),
  type VARCHAR(60) NOT NULL,
  severity VARCHAR(24) NOT NULL DEFAULT 'info',
  risk_score INT NOT NULL DEFAULT 0,
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  evidence JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMP,
  reviewed_by UUID
);

CREATE INDEX IF NOT EXISTS idx_integrity_signals_user_time ON integrity_signals(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_integrity_signals_match_time ON integrity_signals(match_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_integrity_signals_status_severity ON integrity_signals(status, severity, created_at DESC);
