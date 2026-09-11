-- DEPOSITS THE GAME KNOWS ABOUT.
--
-- One row per transfer that arrived. Stage 6 fills this by hand from the
-- panel; stage 7 fills it from the forwarded bank SMS. Both write the same
-- row, which is the point: the settlement path is built and proven against
-- manual entry before a single line of Android code exists, so the first
-- matching bug is found with the operator's own test transfer and not with a
-- player's money.
--
-- AMOUNTS ARE ALWAYS RIAL. The banks disagree with each other — Refah's SMS
-- reports rial, others toman — so the unit is resolved at the edge (manual
-- entry asks for it, the parser declares it per template) and never stored
-- ambiguously. A column that sometimes means toman is a ten-times error
-- waiting for a busy evening.
CREATE TABLE IF NOT EXISTS bank_transactions (
  id            TEXT PRIMARY KEY,
  bank_key      TEXT NOT NULL DEFAULT '',
  amount_rial   BIGINT NOT NULL,
  -- What the SMS printed as the destination, raw. Sepah prints an account
  -- number, not a card number, so this is matched against c2c_cards by
  -- whichever field the bank actually uses.
  dest_ref      TEXT NOT NULL DEFAULT '',
  dest_ref_kind TEXT NOT NULL DEFAULT 'account',
  card_id       TEXT REFERENCES c2c_cards(id),
  -- The running balance the bank reported. Not used for matching: it is the
  -- anti-forgery chain — a fabricated deposit has to keep the balance
  -- arithmetic consistent with every real one around it.
  balance_rial  BIGINT,
  source_ref    TEXT NOT NULL DEFAULT '',
  reference     TEXT NOT NULL DEFAULT '',
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT NOT NULL DEFAULT 'NEW',
  session_id    TEXT REFERENCES c2c_sessions(id),
  entered_by    TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  raw_text      TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A bank reference is the second defence against entering the same deposit
-- twice. Partial, because three of the operator's four banks do not print one
-- — so an empty reference must never collide with another empty one.
CREATE UNIQUE INDEX IF NOT EXISTS bank_tx_reference_unique
  ON bank_transactions(bank_key, reference) WHERE reference <> '';

-- The queue screen, newest first.
CREATE INDEX IF NOT EXISTS bank_tx_status_time ON bank_transactions(status, occurred_at DESC);
-- Finding the session an amount belongs to.
CREATE INDEX IF NOT EXISTS bank_tx_amount_lookup ON bank_transactions(amount_rial, occurred_at DESC);
-- ONE transaction per session, ever. Two deposits settling one order is two
-- payments for one delivery, and the second is money the player has lost.
CREATE UNIQUE INDEX IF NOT EXISTS bank_tx_session_unique
  ON bank_transactions(session_id) WHERE session_id IS NOT NULL;
