-- «Coming soon» is not «off».
--
-- `enabled` had to carry two meanings at once: may this gateway take money,
-- and is a player told it exists. They come apart as soon as a second way to
-- pay is announced before it is ready — the bank gateway must be VISIBLE and
-- unselectable while card-to-card carries the traffic.
--
--   live         picked by pickActiveGateway, shown, selectable
--   coming_soon  never picked, shown greyed out
--   hidden       never picked, never shown
--
-- The boolean is carried across and then dropped rather than kept alongside:
-- two fields that can disagree about whether a gateway takes money is worse
-- than either of them.
--
-- `payment_gateways` is created at runtime by paymentGatewayService, so this
-- file has to cope with the table not existing yet on a fresh database.

CREATE TABLE IF NOT EXISTS payment_gateways (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
  api_key TEXT DEFAULT '', merchant_id TEXT DEFAULT '', secret TEXT DEFAULT '', callback_url TEXT DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT true, sandbox BOOLEAN NOT NULL DEFAULT true, priority INT NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

ALTER TABLE payment_gateways ADD COLUMN IF NOT EXISTS availability TEXT NOT NULL DEFAULT 'live';

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'payment_gateways' AND column_name = 'enabled') THEN
    UPDATE payment_gateways SET availability = CASE WHEN enabled THEN 'live' ELSE 'hidden' END;
    ALTER TABLE payment_gateways DROP COLUMN enabled;
  END IF;
END
$do$;
