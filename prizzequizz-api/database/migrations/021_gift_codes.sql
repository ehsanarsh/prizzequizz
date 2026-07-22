-- Gift / promo codes: minted by admins, redeemed once per user.
CREATE TABLE IF NOT EXISTS gift_codes (
  code VARCHAR(48) PRIMARY KEY,
  reward_type VARCHAR(16) NOT NULL,
  amount BIGINT NOT NULL DEFAULT 0,
  tier VARCHAR(16),
  max_uses INT NOT NULL DEFAULT 1,
  uses INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gift_code_redemptions (
  code VARCHAR(48) NOT NULL,
  user_id UUID NOT NULL,
  redeemed_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (code, user_id)
);
