-- THE FORWARDER DEVICES.
--
-- A device is anything that can HMAC-sign a request — deliberately not «the
-- Android app». The operator's phone is the first client; a script on a Mac
-- reading forwarded messages could be the second. That generality is not
-- speculation: iOS has NO SMS-reading API at all, with any permission or
-- setting, so an iPhone can never be a forwarder directly and any iPhone
-- story has to arrive as a different KIND of client against this same table.
--
-- THE SECRET IS STORED ENCRYPTED, NOT HASHED. It cannot be hashed: the device
-- signs each request with HMAC and the server must recompute that signature,
-- which needs the same secret in the clear. A hash is one-way on purpose, and
-- one-way is exactly what HMAC cannot use. So it is sealed with a key held in
-- the environment — an attacker then needs this table AND the deploy's
-- environment. It is shown to the device once, at pairing, and never again; a
-- device that loses it is re-paired, not recovered.
CREATE TABLE IF NOT EXISTS bank_sms_devices (
  id                TEXT PRIMARY KEY,
  label             TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'ACTIVE',
  app_version       TEXT NOT NULL DEFAULT '',
  secret_enc        TEXT NOT NULL,
  last_seen_at      TIMESTAMPTZ,
  last_sms_at       TIMESTAMPTZ,
  queue_depth       INT NOT NULL DEFAULT 0,
  -- The phone reports whether Android is allowed to sleep it. On a daily-use
  -- phone — which is what the operator has — this is the single best
  -- predictor of deposits arriving hours late instead of seconds later.
  battery_optimized BOOLEAN NOT NULL DEFAULT false,
  messages_received INT NOT NULL DEFAULT 0,
  paired_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS bank_sms_devices_seen ON bank_sms_devices(status, last_seen_at DESC);

-- Pairing codes. Six digits is guessable given enough tries, so a code dies
-- after ten minutes, after five wrong attempts, or the moment it is used —
-- whichever comes first. Every failed redemption burns an attempt, including
-- an expired or already-used code, so that the server's answer never tells a
-- guesser which codes exist.
CREATE TABLE IF NOT EXISTS bank_sms_pairings (
  code       TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts   INT NOT NULL DEFAULT 0,
  used_at    TIMESTAMPTZ,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
