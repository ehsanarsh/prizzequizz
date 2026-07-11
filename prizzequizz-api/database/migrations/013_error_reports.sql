CREATE TABLE IF NOT EXISTS error_reports (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  source VARCHAR(32) NOT NULL,
  severity VARCHAR(24) NOT NULL DEFAULT 'error',
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  message TEXT NOT NULL,
  stack TEXT,
  route TEXT,
  user_agent TEXT,
  app_version VARCHAR(80),
  build_id VARCHAR(120),
  device_id VARCHAR(120),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  resolved_at TIMESTAMP,
  resolved_by UUID
);

CREATE INDEX IF NOT EXISTS idx_error_reports_status_time ON error_reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_reports_source_time ON error_reports(source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_reports_user_time ON error_reports(user_id, created_at DESC);
