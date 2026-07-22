-- Durable admin audit trail: EVERY admin mutation is recorded here permanently,
-- with before/after/delta for value changes, the acting admin, the target user,
-- a reason and a stable operation id. This is the "who did what, and what
-- changed" ledger the panel reads. Mirrors adminAuditService.ensure() so a
-- --no-cache rebuild + restart provisions the same schema without a runner.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id UUID PRIMARY KEY,
  admin_id VARCHAR(64) NOT NULL,
  target_user_id VARCHAR(64),
  action VARCHAR(64) NOT NULL,
  before_value BIGINT,
  after_value BIGINT,
  delta BIGINT,
  reason TEXT,
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_time ON admin_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_log(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_log(target_user_id, created_at DESC);
