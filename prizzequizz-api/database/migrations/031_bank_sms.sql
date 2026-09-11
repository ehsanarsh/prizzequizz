-- READING THE BANK'S OWN NOTIFICATIONS.
--
-- Two tables: the messages as they arrived, and the patterns that read them.
--
-- The patterns are rows and not code because the operator adds their own
-- banks from the panel. What they type is a TEMPLATE, never a regex: a wrong
-- regex reads the amount wrong (and the amount IS the payment), a regex with
-- nested quantifiers hangs the API on a single SMS, and an operator should not
-- have to know regex to add their bank. The compiler turns a template into a
-- bounded matcher where every quantifier has a limit.
CREATE TABLE IF NOT EXISTS bank_sms_patterns (
  id                TEXT PRIMARY KEY,
  bank_key          TEXT NOT NULL,
  label             TEXT NOT NULL DEFAULT '',
  senders           TEXT[] NOT NULL DEFAULT '{}',
  template          TEXT NOT NULL,
  -- No default, deliberately. Refah's SMS prints no unit at all, so a guess
  -- here is a ten-times error that nothing in the message can correct.
  amount_unit       TEXT NOT NULL,
  reject_keywords   TEXT[] NOT NULL DEFAULT '{}',
  -- A pattern is saved only when it reads a REAL deposit and refuses a REAL
  -- withdrawal. At Refah the difference between the two is a single «+».
  sample_deposit    TEXT NOT NULL DEFAULT '',
  sample_withdrawal TEXT NOT NULL DEFAULT '',
  -- draft | trial | live | disabled. A new pattern starts on trial: every
  -- match goes to a person however perfect it looks, so a wrong template
  -- costs manual reviews rather than free tickets.
  status            TEXT NOT NULL DEFAULT 'draft',
  matched_count     INT NOT NULL DEFAULT 0,
  built_in          BOOLEAN NOT NULL DEFAULT false,
  priority          INT NOT NULL DEFAULT 100,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bank_sms_patterns_pick ON bank_sms_patterns(status, priority);

-- The messages themselves. Kept even when nothing could be parsed out of
-- them: an unparsed message is real money that arrived, and the exact sample
-- needed to write the pattern that would have read it.
--
-- Nothing that looks like a credential ever reaches this table — رمز پویا, a
-- verification code, CVV2 are dropped whole before a row exists.
CREATE TABLE IF NOT EXISTS bank_sms_messages (
  id             TEXT PRIMARY KEY,
  device_id      TEXT NOT NULL DEFAULT 'manual',
  message_id     TEXT NOT NULL,
  sender         TEXT NOT NULL DEFAULT '',
  body           TEXT NOT NULL DEFAULT '',
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  status         TEXT NOT NULL DEFAULT 'PARSE_FAILED',
  pattern_id     TEXT,
  transaction_id TEXT,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The only defence against a forwarder replaying its offline queue: three of
-- the operator's four banks print no tracking code, so there is nothing in
-- the text itself to tell two identical deposits apart.
CREATE UNIQUE INDEX IF NOT EXISTS bank_sms_dedupe ON bank_sms_messages(device_id, message_id);
CREATE INDEX IF NOT EXISTS bank_sms_status_time ON bank_sms_messages(status, received_at DESC);
