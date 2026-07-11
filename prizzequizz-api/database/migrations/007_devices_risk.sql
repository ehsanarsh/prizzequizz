CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY,
  fingerprint_hash VARCHAR(128) UNIQUE NOT NULL,
  client_device_id VARCHAR(160),
  user_agent TEXT,
  platform VARCHAR(120),
  first_ip_address VARCHAR(80),
  last_ip_address VARCHAR(80),
  first_seen_at TIMESTAMP NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMP NOT NULL DEFAULT now(),
  trust_status VARCHAR(24) NOT NULL DEFAULT 'new',
  revoked_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_device_bindings (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  device_id UUID REFERENCES devices(id),
  first_seen_at TIMESTAMP NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMP NOT NULL DEFAULT now(),
  last_ip_address VARCHAR(80),
  trust_status VARCHAR(24) NOT NULL DEFAULT 'new',
  risk_score INT NOT NULL DEFAULT 0,
  UNIQUE(user_id, device_id)
);

CREATE TABLE IF NOT EXISTS user_risk_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  risk_score INT NOT NULL DEFAULT 0,
  risk_level VARCHAR(24) NOT NULL DEFAULT 'low',
  reasons TEXT[] NOT NULL DEFAULT '{}',
  device_count INT NOT NULL DEFAULT 0,
  shared_device_count INT NOT NULL DEFAULT 0,
  integrity_signal_count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_devices_fingerprint ON devices(fingerprint_hash);
CREATE INDEX IF NOT EXISTS idx_user_device_bindings_user ON user_device_bindings(user_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_device_bindings_device ON user_device_bindings(device_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_risk_profiles_score ON user_risk_profiles(risk_score DESC, updated_at DESC);
