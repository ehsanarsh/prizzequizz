-- Destination cards, and the payment sessions that reserve an amount on them.
--
-- The unique index is the point of the whole scheme. A card-to-card transfer
-- carries no message — the payer cannot attach an order number, and the bank's
-- reference is created at transfer time — so the only identifier we can hand
-- out in advance is the amount. It is unique because this index says so, not
-- because the allocator tries to be careful.
--
-- The predicate covers every state that still HOLDS an amount, which is more
-- than just the live one: a session whose deadline passed keeps its amount for
-- a grace period, and so does a cancelled one, or a transfer arriving a minute
-- late would be matched to whoever was given that amount next.

CREATE TABLE IF NOT EXISTS c2c_cards (
  id TEXT PRIMARY KEY,
  pan TEXT NOT NULL,                                  -- the 16 digits the player sends to
  account_no TEXT NOT NULL DEFAULT '',                -- what the bank SMS actually prints
  bank_key TEXT NOT NULL DEFAULT '',
  holder_name TEXT NOT NULL DEFAULT '',
  bank_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE',              -- ACTIVE | INACTIVE | MAINTENANCE
  priority INT NOT NULL DEFAULT 100,
  daily_cap_rial BIGINT NOT NULL DEFAULT 0 CHECK (daily_cap_rial >= 0),
  min_amount_toman BIGINT NOT NULL DEFAULT 50000 CHECK (min_amount_toman >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_c2c_cards_pick ON c2c_cards(status, priority);

CREATE TABLE IF NOT EXISTS c2c_sessions (
  id TEXT PRIMARY KEY,
  intent_id UUID,
  user_id UUID NOT NULL REFERENCES users(id),
  card_id TEXT NOT NULL REFERENCES c2c_cards(id),
  base_amount_toman BIGINT NOT NULL CHECK (base_amount_toman > 0),
  amount_rial BIGINT NOT NULL CHECK (amount_rial > 0),
  suffix_rial INT NOT NULL CHECK (suffix_rial > 0),
  tracking_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'AWAITING',            -- AWAITING EXPIRED CANCELLED RELEASED PAID REVIEW
  expires_at TIMESTAMPTZ NOT NULL,                    -- the player's deadline
  reserved_until TIMESTAMPTZ NOT NULL,                -- until when the AMOUNT stays theirs
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS c2c_amount_unique
  ON c2c_sessions(card_id, amount_rial) WHERE status IN ('AWAITING','EXPIRED','CANCELLED');
CREATE UNIQUE INDEX IF NOT EXISTS c2c_tracking_unique ON c2c_sessions(tracking_code);
CREATE INDEX IF NOT EXISTS idx_c2c_sessions_sweep ON c2c_sessions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_c2c_sessions_user ON c2c_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_c2c_sessions_match ON c2c_sessions(amount_rial, status);
