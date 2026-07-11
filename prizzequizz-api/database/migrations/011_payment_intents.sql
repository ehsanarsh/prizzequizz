CREATE TABLE IF NOT EXISTS payment_intents (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  provider VARCHAR(40) NOT NULL,
  amount BIGINT NOT NULL,
  currency VARCHAR(16) NOT NULL DEFAULT 'cash',
  status VARCHAR(24) NOT NULL DEFAULT 'created',
  transaction_id UUID REFERENCES transactions(id),
  payment_url TEXT NOT NULL,
  callback_url TEXT,
  provider_reference VARCHAR(180),
  idempotency_key VARCHAR(180) UNIQUE NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  paid_at TIMESTAMP,
  failed_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payment_intents_user_time ON payment_intents(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_intents_status_time ON payment_intents(status, created_at DESC);
