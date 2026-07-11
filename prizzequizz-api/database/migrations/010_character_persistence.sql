CREATE TABLE IF NOT EXISTS character_items (
  id VARCHAR(100) PRIMARY KEY,
  slot VARCHAR(40) NOT NULL,
  title VARCHAR(120) NOT NULL,
  src TEXT NOT NULL,
  rarity VARCHAR(24) NOT NULL DEFAULT 'common',
  price_coins INT NOT NULL DEFAULT 0,
  unlock_level INT NOT NULL DEFAULT 1,
  tags TEXT[] NOT NULL DEFAULT '{}',
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_character_inventory (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  unlocked_item_ids TEXT[] NOT NULL DEFAULT '{}',
  loadout JSONB NOT NULL DEFAULT '{"state":"idle","outfit":{"head":"none_head","body":"none_body","shoes":"none_shoes"}}',
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS character_unlock_events (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  item_id VARCHAR(100) REFERENCES character_items(id),
  reason VARCHAR(40) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_character_items_slot_status ON character_items(slot, status);
CREATE INDEX IF NOT EXISTS idx_character_unlock_events_user_time ON character_unlock_events(user_id, created_at DESC);
