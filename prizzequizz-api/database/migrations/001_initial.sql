CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  phone VARCHAR(32) UNIQUE NOT NULL,
  username VARCHAR(64) UNIQUE NOT NULL,
  display_name VARCHAR(120),
  plan VARCHAR(16) NOT NULL DEFAULT 'free',
  coins BIGINT NOT NULL DEFAULT 0,
  hearts INT NOT NULL DEFAULT 5,
  wallet_balance BIGINT NOT NULL DEFAULT 0,
  xp BIGINT NOT NULL DEFAULT 0,
  level INT NOT NULL DEFAULT 1,
  weekly_score BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS questions (
  id UUID PRIMARY KEY,
  text TEXT NOT NULL,
  options JSONB NOT NULL,
  correct_index INT NOT NULL,
  category VARCHAR(80) NOT NULL,
  difficulty VARCHAR(16) NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS matches (
  id UUID PRIMARY KEY,
  mode_id VARCHAR(64) NOT NULL,
  economy_type VARCHAR(16) NOT NULL,
  status VARCHAR(64) NOT NULL,
  current_round INT NOT NULL DEFAULT 0,
  winner_user_id UUID,
  config_version VARCHAR(80) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id UUID REFERENCES matches(id),
  user_id UUID REFERENCES users(id),
  score INT NOT NULL DEFAULT 0,
  correct_answers INT NOT NULL DEFAULT 0,
  wrong_answers INT NOT NULL DEFAULT 0,
  eliminated BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY(match_id, user_id)
);

CREATE TABLE IF NOT EXISTS answers (
  id UUID PRIMARY KEY,
  match_id UUID REFERENCES matches(id),
  user_id UUID REFERENCES users(id),
  question_id UUID REFERENCES questions(id),
  selected_index INT,
  correct BOOLEAN NOT NULL,
  answer_time_ms INT,
  idempotency_key VARCHAR(160) UNIQUE NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  type VARCHAR(32) NOT NULL,
  currency VARCHAR(32) NOT NULL,
  amount BIGINT NOT NULL,
  direction VARCHAR(8) NOT NULL,
  status VARCHAR(24) NOT NULL,
  reference VARCHAR(120),
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_transactions_user_time ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_questions_filter ON questions(status, category, difficulty);
