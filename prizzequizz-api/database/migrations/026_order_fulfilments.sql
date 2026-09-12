-- One row per delivery, so a gateway that calls back twice — or calls back
-- after the API has been restarted — hands the goods over exactly once. This
-- used to be a Set in the process's memory, which a deploy emptied mid-retry.
--
-- status  'pending' a claim in flight; 'done' delivered
-- payload what was handed over, so a duplicate can be told the same answer
-- takeovers  how many times the lease was reclaimed from a claim that never
--            settled. Anything above 0 means something crashed mid-delivery.
--
-- Mirrors fulfilmentGuard.ensureSchema() so a build+restart deploy, which
-- carries dist and nothing else, provisions the same table without a runner.
CREATE TABLE IF NOT EXISTS order_fulfilments (
  ref VARCHAR(200) PRIMARY KEY,
  status VARCHAR(12) NOT NULL DEFAULT 'pending',
  payload JSONB,
  claimed_at TIMESTAMP NOT NULL DEFAULT now(),
  settled_at TIMESTAMP,
  takeovers INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_order_fulfilments_claimed ON order_fulfilments(claimed_at);
