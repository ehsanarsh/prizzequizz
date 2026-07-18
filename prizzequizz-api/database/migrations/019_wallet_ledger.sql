-- Ledger-based wallet: immutable ledger is the source of truth; wallet_accounts
-- is a materialized balance updated in the SAME transaction as every ledger row.
CREATE TABLE IF NOT EXISTS wallet_accounts (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  available BIGINT NOT NULL DEFAULT 0 CHECK (available >= 0),
  locked BIGINT NOT NULL DEFAULT 0 CHECK (locked >= 0),
  pending_settlement BIGINT NOT NULL DEFAULT 0 CHECK (pending_settlement >= 0),
  version BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_ledger (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  entry_type VARCHAR(32) NOT NULL,
  kind VARCHAR(12) NOT NULL, -- credit | debit | lock | release | settle
  amount BIGINT NOT NULL CHECK (amount > 0),
  available_before BIGINT NOT NULL,
  available_after BIGINT NOT NULL,
  locked_before BIGINT NOT NULL,
  locked_after BIGINT NOT NULL,
  ref_type VARCHAR(32),
  ref_id VARCHAR(120),
  idempotency_key VARCHAR(200) UNIQUE NOT NULL,
  description TEXT,
  operator_id UUID,
  ip VARCHAR(64),
  device VARCHAR(160),
  platform VARCHAR(40),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user_time ON wallet_ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_type_time ON wallet_ledger(entry_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_ref ON wallet_ledger(ref_type, ref_id);

-- Immutability: ledger rows can never be updated or deleted.
CREATE OR REPLACE FUNCTION wallet_ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger rows are immutable';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_wallet_ledger_immutable ON wallet_ledger;
CREATE TRIGGER trg_wallet_ledger_immutable
  BEFORE UPDATE OR DELETE ON wallet_ledger
  FOR EACH ROW EXECUTE FUNCTION wallet_ledger_immutable();

CREATE TABLE IF NOT EXISTS withdraw_requests (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  amount BIGINT NOT NULL CHECK (amount > 0),
  fee BIGINT NOT NULL DEFAULT 0 CHECK (fee >= 0),
  destination VARCHAR(120) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending', -- pending|approved|rejected|paid|failed
  reject_reason TEXT,
  reviewed_by UUID,
  reviewed_at TIMESTAMP,
  paid_by UUID,
  paid_at TIMESTAMP,
  payment_reference VARCHAR(160),
  idempotency_key VARCHAR(200) UNIQUE NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_withdraw_requests_user_time ON withdraw_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdraw_requests_status_time ON withdraw_requests(status, created_at DESC);

CREATE TABLE IF NOT EXISTS wallet_audit_logs (
  id UUID PRIMARY KEY,
  user_id UUID,
  actor_id UUID,
  action VARCHAR(64) NOT NULL,
  api VARCHAR(160),
  ip VARCHAR(64),
  device VARCHAR(200),
  platform VARCHAR(40),
  request JSONB,
  response JSONB,
  error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wallet_audit_user_time ON wallet_audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_audit_action_time ON wallet_audit_logs(action, created_at DESC);
