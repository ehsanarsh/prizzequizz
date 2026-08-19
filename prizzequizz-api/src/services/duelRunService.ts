/* THE DUEL LADDER, AND WHY IT NEEDS A MEMORY.
 *
 * A player enters a paid duel with ONE ticket. Winning does not end the run: it
 * promotes them, and their winnings ride into the next rung at double the
 * stake. Green (12,500) → 25,000 → 50,000, and only when they stop is anything
 * paid out — once, on the rung they reached.
 *
 * That is not what was happening. The ladder was real on the client (each rung
 * enqueues at the higher tier and deliberately spends NO new ticket), but the
 * server settled every match on its own: a run of three wins credited the full
 * pot three times — 25,000 then 50,000 then 100,000 — against a single 12,500
 * ticket. The player was paid 166,250 for a 12,500 entry and the platform
 * funded the difference, every single run.
 *
 * So the run itself is the thing that gets settled, not the matches inside it:
 *
 *   • Entering with a ticket opens a run.
 *   • Winning a rung parks the winnings — nothing reaches the wallet.
 *   • «ادامه» rolls them into the next rung. No new ticket; that is the point.
 *   • «برداشت» settles once: netPrize(pot of the rung they reached).
 *   • Losing closes the run with nothing. The ride was the risk, and only the
 *     one entry ticket was ever spent.
 *   • Walking away without pressing either is settled for them by the sweeper
 *     below, at the last rung they won. Their money is never kept, and closing
 *     the app is never a way to escape a loss that has already happened.
 *
 * Durable on purpose: this is money mid-flight, so it lives in the database
 * when there is one, and only falls back to memory in the dev/in-memory setup
 * that the rest of the service layer already uses.
 */
import { getPgPool } from '../database/postgres.js';
import { id } from '../utils/id.js';

export type DuelRunStatus = 'open' | 'won' | 'settled' | 'lost';

export interface DuelRun {
  id: string;
  userId: string;
  /** The tier of the ticket that opened the run — the only entry ever charged. */
  entryTier: string;
  /** 1 for the first match, 2 after one «ادامه», and so on. */
  stage: number;
  /** What each side is playing for on the CURRENT rung, in toman. */
  stake: number;
  /** The match currently being played, or the last one played. */
  matchId: string | null;
  /** Gross pot of the last rung WON and not yet paid out. 0 until a win. */
  pendingGross: number;
  status: DuelRunStatus;
  createdAt: string;
  updatedAt: string;
}

/** A run with a win parked in it is settled for the player after this long. */
export const RUN_IDLE_SETTLE_MS = 10 * 60_000;

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

const mem = new Map<string, DuelRun>();

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS duel_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    entry_tier TEXT NOT NULL DEFAULT '',
    stage INT NOT NULL DEFAULT 1,
    stake BIGINT NOT NULL DEFAULT 0,
    match_id TEXT,
    pending_gross BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS duel_runs_user ON duel_runs(user_id, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS duel_runs_match ON duel_runs(match_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS duel_runs_open ON duel_runs(status, updated_at)`);
  _schemaReady = true;
}

const rowToRun = (r: any): DuelRun => ({
  id: String(r.id), userId: String(r.user_id), entryTier: String(r.entry_tier || ''),
  stage: Number(r.stage) || 1, stake: Number(r.stake) || 0,
  matchId: r.match_id ? String(r.match_id) : null,
  pendingGross: Number(r.pending_gross) || 0, status: String(r.status) as DuelRunStatus,
  createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString()
});

async function save(run: DuelRun): Promise<DuelRun> {
  run.updatedAt = new Date().toISOString();
  const pool = pg();
  if (!pool) { mem.set(run.id, { ...run }); return run; }
  await ensureSchema(pool);
  await pool.query(
    `INSERT INTO duel_runs (id, user_id, entry_tier, stage, stake, match_id, pending_gross, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET stage=$4, stake=$5, match_id=$6, pending_gross=$7, status=$8, updated_at=$10`,
    [run.id, run.userId, run.entryTier, run.stage, run.stake, run.matchId, run.pendingGross, run.status, run.createdAt, run.updatedAt]
  );
  return run;
}

/** The run this player is currently on, if any. */
export async function openRunFor(userId: string): Promise<DuelRun | null> {
  const pool = pg();
  if (!pool) {
    const rows = [...mem.values()].filter((r) => r.userId === userId && (r.status === 'open' || r.status === 'won'));
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return rows[0] ?? null;
  }
  await ensureSchema(pool);
  const { rows } = await pool.query(
    `SELECT * FROM duel_runs WHERE user_id=$1 AND status IN ('open','won') ORDER BY updated_at DESC LIMIT 1`, [userId]
  );
  return rows[0] ? rowToRun(rows[0]) : null;
}

export async function getRun(runId: string): Promise<DuelRun | null> {
  const pool = pg();
  if (!pool) return mem.get(runId) ?? null;
  await ensureSchema(pool);
  const { rows } = await pool.query(`SELECT * FROM duel_runs WHERE id=$1`, [runId]);
  return rows[0] ? rowToRun(rows[0]) : null;
}

/** Opened by the entry that actually spends a ticket. */
export async function startRun(userId: string, entryTier: string, stake: number): Promise<DuelRun> {
  /* One run at a time. An older one still lying around is abandoned rather than
     left to collide with this one — its money is settled by the sweeper. */
  const now = new Date().toISOString();
  const run: DuelRun = {
    id: id(), userId, entryTier: String(entryTier || ''), stage: 1,
    stake: Math.max(0, Math.round(Number(stake) || 0)), matchId: null,
    pendingGross: 0, status: 'open', createdAt: now, updatedAt: now
  };
  return save(run);
}

/** The run is now playing this match — how a finished match finds its run. */
export async function attachMatch(runId: string, matchId: string): Promise<DuelRun | null> {
  const run = await getRun(runId);
  if (!run) return null;
  run.matchId = matchId;
  return save(run);
}

export async function runForMatch(matchId: string, userId: string): Promise<DuelRun | null> {
  const pool = pg();
  if (!pool) {
    return [...mem.values()].find((r) => r.matchId === matchId && r.userId === userId && (r.status === 'open' || r.status === 'won')) ?? null;
  }
  await ensureSchema(pool);
  const { rows } = await pool.query(
    `SELECT * FROM duel_runs WHERE match_id=$1 AND user_id=$2 AND status IN ('open','won') LIMIT 1`, [matchId, userId]
  );
  return rows[0] ? rowToRun(rows[0]) : null;
}

/** A rung was won: the pot rides instead of being paid. */
export async function recordWin(runId: string, grossPot: number): Promise<DuelRun | null> {
  const run = await getRun(runId);
  if (!run || (run.status !== 'open' && run.status !== 'won')) return null;
  run.pendingGross = Math.max(0, Math.round(Number(grossPot) || 0));
  run.status = 'won';
  return save(run);
}

/** A rung was lost: everything riding on it goes with it. */
export async function recordLoss(runId: string): Promise<DuelRun | null> {
  const run = await getRun(runId);
  if (!run || run.status === 'settled') return null;
  run.pendingGross = 0;
  run.status = 'lost';
  return save(run);
}

/** «ادامه» — double or nothing, on the same entry ticket. */
export async function advance(runId: string): Promise<DuelRun | null> {
  const run = await getRun(runId);
  if (!run || run.status !== 'won') return null;
  run.stage += 1;
  run.stake = run.stake * 2;
  run.matchId = null;
  run.status = 'open';
  return save(run);
}

/** Marks the run paid. The caller does the crediting — money moves in the
 *  ledger, never here — and only when this returns the amount, exactly once. */
export async function settle(runId: string): Promise<{ run: DuelRun; gross: number } | null> {
  const run = await getRun(runId);
  if (!run || run.status !== 'won' || run.pendingGross <= 0) return null;
  const gross = run.pendingGross;
  run.status = 'settled';
  run.pendingGross = 0;
  await save(run);
  return { run, gross };
}

/** Runs with a win parked in them that nobody has come back for. */
export async function idleWonRuns(now = Date.now(), olderThanMs = RUN_IDLE_SETTLE_MS): Promise<DuelRun[]> {
  const cutoff = new Date(now - olderThanMs).toISOString();
  const pool = pg();
  if (!pool) return [...mem.values()].filter((r) => r.status === 'won' && r.pendingGross > 0 && r.updatedAt <= cutoff);
  await ensureSchema(pool);
  const { rows } = await pool.query(
    `SELECT * FROM duel_runs WHERE status='won' AND pending_gross > 0 AND updated_at <= $1 LIMIT 200`, [cutoff]
  );
  return rows.map(rowToRun);
}

/** Tests only. */
export function _resetDuelRuns(): void { mem.clear(); }
