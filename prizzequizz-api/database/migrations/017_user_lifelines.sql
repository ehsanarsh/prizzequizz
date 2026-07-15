-- Persist each user's lifeline (کمکی) inventory so it survives logout/login and
-- is decremented server-side, not just in client state.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS lifelines JSONB NOT NULL DEFAULT '{"p5050":2,"psecond":1,"pstats":5}'::jsonb;
