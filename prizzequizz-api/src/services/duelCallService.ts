/* «حریفت ادامه داد.»
 *
 * A duel ends, the winner presses «ادامه میدهم» and walks straight into the
 * next stage at double the stake. The loser is left on a result screen and is
 * told nothing at all — the whole thing happens on the winner's device.
 *
 * «اگه در دوئل بازیکنی باخت و برنده دکمه ادامه میدهم رو زد و ادامه داد به بازنده
 *  اطلاع بده — البته نه پیام به صندوق اعلان، یه مودال بیاد و بنویسه حریفت ادامه
 *  داد میتونی با بلیط آبی حقتو ازش بگیری، و دو دکمه بیخیال و پیداش کن.»
 *
 * So this is a CALL, not a message: a short-lived note that one named person is
 * standing in a named tier right now, delivered while that is still true and
 * thrown away when it stops being true. It is deliberately not a notification —
 * an inbox entry read tomorrow would be an invitation to walk into an empty
 * queue, which is precisely the thing it is meant to prevent.
 *
 * Nothing here moves a ticket or a toman. The loser who answers «پیداش کن»
 * walks in through the ordinary ticket door and pays the ordinary entry.
 */
import { getPgPool } from '../database/postgres.js';
import { id } from '../utils/id.js';

export interface DuelCall {
  id: string;
  toUserId: string;
  fromUserId: string;
  fromName: string;
  /** Which tier the winner is now waiting in — green→blue, blue→red, red→red. */
  tier: string;
  /** The finished match this came out of; also what keeps it to one per match. */
  matchId: string;
  /** Which stage of the chain the winner has just gone on to (2..10). */
  stage: number;
  createdAt: number;
  expiresAt: number;
  seenAt: number;
}

/* HOW LONG THE CALL IS TRUE FOR.
 * The winner's search lasts sixty seconds and then refunds itself. Three
 * minutes covers that plus the loser closing their result screen and the next
 * poll coming round — and stops well short of the point where «پیداش کن» would
 * be sending somebody after a person who is no longer there. */
export const CALL_TTL_MS = 180_000;

/* WHICH TIER THE CALL POINTS AT.
 *
 * Not derived here, because deriving it would be guessing. The chain doubles
 * the stake and a doubled stake IS a tier's value — green 12,500 → 25,000 is
 * blue, blue 25,000 → 50,000 is red — but 50,000 doubled is 100,000, which no
 * ticket buys. The winner's own client knows the number it is now waiting at
 * and names the tier, or sends nothing at all when there is no ticket that
 * reaches them; all this end does is refuse a name that is not a tier. */
export const CALL_TIERS = ['green', 'blue', 'red'] as const;
export function isTier(tier: string): boolean {
  return (CALL_TIERS as readonly string[]).includes(String(tier || '').toLowerCase());
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

const mem = new Map<string, DuelCall>();

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS duel_calls (
    id TEXT PRIMARY KEY,
    to_user_id TEXT NOT NULL,
    from_user_id TEXT NOT NULL,
    from_name TEXT NOT NULL DEFAULT '',
    tier TEXT NOT NULL DEFAULT 'blue',
    match_id TEXT NOT NULL DEFAULT '',
    stage INT NOT NULL DEFAULT 2,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL DEFAULT 0,
    seen_at BIGINT NOT NULL DEFAULT 0)`);
  /* Said twice on purpose — `CREATE TABLE IF NOT EXISTS` does nothing to a
     table that already exists, so a column added after the first release
     reaches a fresh database and no other. See gameInviteService for the day
     that lesson cost us every invite in the game. */
  for (const col of [
    `from_name TEXT NOT NULL DEFAULT ''`,
    `tier TEXT NOT NULL DEFAULT 'blue'`,
    `match_id TEXT NOT NULL DEFAULT ''`,
    `stage INT NOT NULL DEFAULT 2`,
    `expires_at BIGINT NOT NULL DEFAULT 0`,
    `seen_at BIGINT NOT NULL DEFAULT 0`
  ]) {
    await pool.query(`ALTER TABLE duel_calls ADD COLUMN IF NOT EXISTS ${col}`);
  }
  /* One call per match per person: pressing «ادامه میدهم» twice, or a retried
     request, must not knock twice on the same door. */
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS duel_calls_once ON duel_calls(match_id, to_user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS duel_calls_to ON duel_calls(to_user_id, seen_at, expires_at)`);
  _schemaReady = true;
}

const rowToCall = (r: any): DuelCall => ({
  id: String(r.id), toUserId: String(r.to_user_id), fromUserId: String(r.from_user_id),
  fromName: String(r.from_name || ''), tier: String(r.tier || 'blue'),
  matchId: String(r.match_id || ''), stage: Number(r.stage) || 2,
  createdAt: Number(r.created_at), expiresAt: Number(r.expires_at) || 0,
  seenAt: Number(r.seen_at) || 0
});

/** Record that `fromUserId` carried on, so `toUserId` can be told. Returns the
 *  call — or the one already standing for this match, so a double press is one
 *  knock, not two. */
export async function callAfterWin(input: {
  toUserId: string; fromUserId: string; fromName: string;
  tier: string; matchId: string; stage: number;
}): Promise<DuelCall> {
  const now = Date.now();
  const call: DuelCall = {
    id: id(),
    toUserId: String(input.toUserId), fromUserId: String(input.fromUserId),
    fromName: String(input.fromName || 'حریف'),
    tier: String(input.tier || '').toLowerCase(),
    matchId: String(input.matchId || ''),
    stage: Math.max(2, Math.min(10, Number(input.stage) || 2)),
    createdAt: now, expiresAt: now + CALL_TTL_MS, seenAt: 0
  };
  /* Swept on the way in rather than on a timer: a call is only ever written
     when somebody presses «ادامه میدهم», so this runs as often as the table
     grows and never once more. Best-effort — housekeeping must not be able to
     stop the person being told. */
  try { await pruneCalls(); } catch { /* the table can wait */ }
  const pool = pg();
  if (!pool) {
    for (const c of mem.values()) {
      if (c.matchId && c.matchId === call.matchId && c.toUserId === call.toUserId) return c;
    }
    mem.set(call.id, { ...call });
    return call;
  }
  await ensureSchema(pool);
  const { rows } = await pool.query(
    `INSERT INTO duel_calls (id, to_user_id, from_user_id, from_name, tier, match_id, stage, created_at, expires_at, seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0)
     ON CONFLICT (match_id, to_user_id) DO NOTHING
     RETURNING *`,
    [call.id, call.toUserId, call.fromUserId, call.fromName, call.tier, call.matchId, call.stage, call.createdAt, call.expiresAt]
  );
  if (rows[0]) return rowToCall(rows[0]);
  const existing = await pool.query(`SELECT * FROM duel_calls WHERE match_id=$1 AND to_user_id=$2`, [call.matchId, call.toUserId]);
  return existing.rows[0] ? rowToCall(existing.rows[0]) : call;
}

/** The calls waiting for me that are still true. Unseen and unexpired only —
 *  a call whose three minutes are up is not news, it is a wrong address. */
export async function pendingFor(userId: string): Promise<DuelCall[]> {
  const now = Date.now();
  const pool = pg();
  if (!pool) {
    return [...mem.values()]
      .filter((c) => c.toUserId === userId && !c.seenAt && c.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  await ensureSchema(pool);
  const { rows } = await pool.query(
    `SELECT * FROM duel_calls WHERE to_user_id=$1 AND seen_at=0 AND expires_at>$2 ORDER BY created_at DESC LIMIT 5`,
    [userId, now]
  );
  return rows.map(rowToCall);
}

/** Shown once. Marking it seen is what stops the same modal coming back on
 *  every poll for the next three minutes. */
export async function markSeen(callId: string, userId: string): Promise<boolean> {
  const pool = pg();
  if (!pool) {
    const c = mem.get(callId);
    /* `seenAt` is checked here, not only in the SQL below: without it the two
       drivers disagreed about what a second call means, and the answer to
       «was it me who marked this read?» became true forever. */
    if (!c || c.toUserId !== userId || c.seenAt) return false;
    c.seenAt = Date.now(); mem.set(callId, c); return true;
  }
  await ensureSchema(pool);
  const { rowCount } = await pool.query(
    `UPDATE duel_calls SET seen_at=$3 WHERE id=$1 AND to_user_id=$2 AND seen_at=0`,
    [callId, userId, Date.now()]
  );
  return (rowCount ?? 0) > 0;
}

/** Housekeeping: an expired call has no reader and no purpose. The line is the
 *  same one `pendingFor` draws, so nothing is ever kept that could still be
 *  delivered — and nothing that could not is kept either. */
export async function pruneCalls(): Promise<number> {
  const now = Date.now();
  const pool = pg();
  if (!pool) {
    let n = 0;
    for (const [k, c] of mem) if (c.expiresAt <= now) { mem.delete(k); n++; }
    return n;
  }
  await ensureSchema(pool);
  const { rowCount } = await pool.query(`DELETE FROM duel_calls WHERE expires_at <= $1`, [now]);
  return rowCount ?? 0;
}

/** Tests only. */
export function _resetDuelCalls(): void { mem.clear(); _schemaReady = false; }
/** Tests only: wind a call's window back, to stand for the time a player spends
 *  inside a match with a call already waiting for them. */
export function _ageCall(callId: string, ms: number): boolean {
  const c = mem.get(callId);
  if (!c) return false;
  c.createdAt -= ms; c.expiresAt -= ms; mem.set(callId, c);
  return true;
}
