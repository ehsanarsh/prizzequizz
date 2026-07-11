ALTER TABLE users ADD COLUMN IF NOT EXISTS tickets JSONB NOT NULL DEFAULT '{"bronze":0,"silver":0,"gold":0}';
