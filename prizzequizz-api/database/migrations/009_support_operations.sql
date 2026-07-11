CREATE TABLE IF NOT EXISTS support_tickets (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  title VARCHAR(180) NOT NULL,
  category VARCHAR(80) NOT NULL,
  body TEXT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  priority VARCHAR(24) NOT NULL DEFAULT 'normal',
  reply TEXT,
  linked_match_id UUID,
  linked_transaction_id UUID,
  linked_reward_hold_id UUID,
  assigned_admin_id UUID,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  closed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS support_messages (
  id UUID PRIMARY KEY,
  ticket_id UUID REFERENCES support_tickets(id),
  sender_id VARCHAR(80) NOT NULL,
  sender_role VARCHAR(20) NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status_time ON support_tickets(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user_time ON support_tickets(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket_time ON support_messages(ticket_id, created_at ASC);
