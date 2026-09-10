-- Delivery, exactly once — and the record of what was sold.
--
-- Replaces two in-process guards (`_fulfilled: Set` in purchaseOrderService and
-- `_seen: Map` in shopPurchaseService). Both were bounded and evicted their
-- oldest entries, so they forgot real payments under load, not only across a
-- restart. A card-to-card payment is confirmed minutes or hours later and from
-- three different directions, so the record has to outlive the process.
--
-- It is also where income for externally-paid orders becomes visible: that
-- money belongs to the house and deliberately never enters `wallet_ledger`,
-- which is the only place the finance report reads from today.

CREATE TABLE IF NOT EXISTS order_fulfilments (
  ref VARCHAR(200) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  source VARCHAR(20) NOT NULL,                 -- vault | gateway | card_to_card
  status VARCHAR(12) NOT NULL DEFAULT 'pending', -- pending | done | void
  kind VARCHAR(16) NOT NULL DEFAULT '',        -- ticket | shop
  category VARCHAR(40) NOT NULL DEFAULT '',    -- tickets | coins | … (shop shelf)
  currency VARCHAR(8) NOT NULL DEFAULT 'cash',
  amount_toman BIGINT NOT NULL DEFAULT 0 CHECK (amount_toman >= 0),
  payment_ref VARCHAR(120),
  order_json JSONB NOT NULL DEFAULT '{}',
  payload JSONB,                               -- what the player got, replayed on a duplicate
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_fulfilments_status ON order_fulfilments(status, claimed_at);
CREATE INDEX IF NOT EXISTS idx_order_fulfilments_time ON order_fulfilments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_fulfilments_income ON order_fulfilments(source, category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_fulfilments_user ON order_fulfilments(user_id, created_at DESC);
