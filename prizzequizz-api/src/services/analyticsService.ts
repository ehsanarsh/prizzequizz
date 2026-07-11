import { db } from '../repositories/memory.js';
import { getPgPool } from '../database/postgres.js';

export async function getAdminAnalytics() {
  if (process.env.REPOSITORY_DRIVER === 'postgres' || (process.env.DATABASE_URL && process.env.REPOSITORY_DRIVER !== 'memory')) {
    try {
      const pool = getPgPool();
      const [matches, questions, transactions, rewards, users] = await Promise.all([
        pool.query('select count(*)::int as c from matches'),
        pool.query('select count(*)::int as c from questions'),
        pool.query('select count(*)::int as c from transactions'),
        pool.query('select count(*)::int as c from rewards'),
        pool.query('select count(*)::int as c from users')
      ]);
      return {
        matches: matches.rows[0]?.c ?? 0,
        questions: questions.rows[0]?.c ?? 0,
        transactions: transactions.rows[0]?.c ?? 0,
        rewards: rewards.rows[0]?.c ?? 0,
        activeUsersEstimate: users.rows[0]?.c ?? 0
      };
    } catch {
      // fall through to memory-safe stats
    }
  }
  return {
    matches: db.matches.size,
    questions: db.questions.size,
    transactions: db.transactions.size,
    rewards: db.rewards.size,
    activeUsersEstimate: db.users.size
  };
}
