-- A message from a friend gets its own switch.
--
-- Chat notifications used not to exist, so a player who wanted everything else
-- but not chat had nowhere to say so. Defaulting to true is deliberate: an
-- existing player who has never seen this setting should receive the message
-- their friend just sent them, and can switch it off in one tap.
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS friend_messages BOOLEAN NOT NULL DEFAULT true;
