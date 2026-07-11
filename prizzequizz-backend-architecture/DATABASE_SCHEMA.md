# PrizzeQuizz — Database Schema

Recommended database: PostgreSQL.

Redis is used for active match state and transient matchmaking queues.

## users

```sql
CREATE TABLE users (
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
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
```

Indexes:

```sql
CREATE INDEX idx_users_plan ON users(plan);
CREATE INDEX idx_users_xp ON users(xp DESC);
```

## matches

```sql
CREATE TABLE matches (
  id UUID PRIMARY KEY,
  mode_id VARCHAR(64) NOT NULL,
  economy_type VARCHAR(16) NOT NULL,
  status VARCHAR(64) NOT NULL,
  config_version VARCHAR(80) NOT NULL,
  current_round INT NOT NULL DEFAULT 0,
  winner_user_id UUID REFERENCES users(id),
  started_at TIMESTAMP,
  finished_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
```

Indexes:

```sql
CREATE INDEX idx_matches_status ON matches(status);
CREATE INDEX idx_matches_mode_status ON matches(mode_id, status);
CREATE INDEX idx_matches_created_at ON matches(created_at DESC);
```

## match_players

```sql
CREATE TABLE match_players (
  match_id UUID REFERENCES matches(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  score INT NOT NULL DEFAULT 0,
  correct_answers INT NOT NULL DEFAULT 0,
  wrong_answers INT NOT NULL DEFAULT 0,
  eliminated BOOLEAN NOT NULL DEFAULT false,
  reward_type VARCHAR(32),
  reward_amount BIGINT NOT NULL DEFAULT 0,
  joined_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id)
);
```

## questions

```sql
CREATE TABLE questions (
  id UUID PRIMARY KEY,
  text TEXT NOT NULL,
  options JSONB NOT NULL,
  correct_index INT NOT NULL,
  category VARCHAR(80) NOT NULL,
  difficulty VARCHAR(16) NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  locale VARCHAR(16) NOT NULL DEFAULT 'fa-IR',
  media JSONB,
  explanation TEXT,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  version INT NOT NULL DEFAULT 1,
  created_by UUID REFERENCES users(id),
  reviewed_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
```

Indexes:

```sql
CREATE INDEX idx_questions_active ON questions(status, locale, category, difficulty);
CREATE INDEX idx_questions_tags ON questions USING GIN(tags);
CREATE INDEX idx_questions_text_trgm ON questions USING GIN(text gin_trgm_ops);
```

## answers

```sql
CREATE TABLE answers (
  id UUID PRIMARY KEY,
  match_id UUID REFERENCES matches(id),
  user_id UUID REFERENCES users(id),
  question_id UUID REFERENCES questions(id),
  selected_index INT,
  correct BOOLEAN NOT NULL,
  answer_time_ms INT,
  idempotency_key VARCHAR(120) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(match_id, user_id, question_id),
  UNIQUE(idempotency_key)
);
```

## rewards

```sql
CREATE TABLE rewards (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  match_id UUID REFERENCES matches(id),
  type VARCHAR(32) NOT NULL,
  amount BIGINT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  reason VARCHAR(80) NOT NULL,
  idempotency_key VARCHAR(160) UNIQUE NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  settled_at TIMESTAMP
);
```

## transactions

```sql
CREATE TABLE transactions (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  type VARCHAR(32) NOT NULL,
  currency VARCHAR(32) NOT NULL,
  amount BIGINT NOT NULL,
  direction VARCHAR(8) NOT NULL,
  status VARCHAR(24) NOT NULL,
  reference_type VARCHAR(64),
  reference_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
```

Indexes:

```sql
CREATE INDEX idx_transactions_user_time ON transactions(user_id, created_at DESC);
CREATE INDEX idx_transactions_reference ON transactions(reference_type, reference_id);
```

## game_sessions

```sql
CREATE TABLE game_sessions (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  match_id UUID REFERENCES matches(id),
  connection_id VARCHAR(120),
  status VARCHAR(24) NOT NULL,
  last_seen_at TIMESTAMP NOT NULL DEFAULT now(),
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
```

## match_events

```sql
CREATE TABLE match_events (
  id BIGSERIAL PRIMARY KEY,
  match_id UUID REFERENCES matches(id),
  event_type VARCHAR(80) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
```

## admin_logs

```sql
CREATE TABLE admin_logs (
  id UUID PRIMARY KEY,
  admin_id UUID REFERENCES users(id),
  action VARCHAR(80) NOT NULL,
  target_type VARCHAR(80) NOT NULL,
  target_id VARCHAR(120),
  diff JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
```

## Performance Considerations

- Active match state should live in Redis with periodic durable snapshots.
- Match events provide replay and auditability.
- Rewards and transactions must use idempotency keys.
- Question selection indexes must include status, locale, category, difficulty.
- Leaderboards should be precomputed in Redis sorted sets and periodically persisted.
- Use partitioning for high-volume tables like answers, match_events, and transactions when scale requires it.
