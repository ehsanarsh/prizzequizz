-- Admin-editable config persistence: the panel writes the whole game_config
-- here so edits (rake %, ticket prices, wallet limits, per-mode stakes, scoring)
-- survive container restarts. Loaded at boot and merged over the on-disk
-- defaults. (Also ensured at runtime by configService.)
CREATE TABLE IF NOT EXISTS app_config (
  key VARCHAR(64) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_by VARCHAR(64)
);
