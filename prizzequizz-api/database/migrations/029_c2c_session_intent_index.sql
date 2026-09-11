-- The retry lookup.
--
-- Every tap on «پرداخت» asks whether this intent already has a live session,
-- so that a second tap is the same payment rather than a second amount held
-- open on the card. Without an index that question is a sequential scan, and
-- c2c_sessions only ever grows — it is the payment history.
--
-- Partial, because only AWAITING is ever asked for here: the index then holds
-- just the handful of sessions that are actually live, not every payment the
-- game has ever taken.
CREATE INDEX IF NOT EXISTS idx_c2c_sessions_intent
  ON c2c_sessions(intent_id) WHERE status = 'AWAITING';
