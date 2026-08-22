/* WHAT THIS PLAYER HAS ALREADY BEEN ASKED.
 *
 *   «وقتی موضوعی رو انتخاب میکنی و سوالات رو جواب میدی، در بازی بعدی اگه باز هم
 *    همون موضوع رو انتخاب کنی سوالات تکراری میاد — با اینکه اون موضوع سوالات
 *    زیادی داره. سوالات تکراری باید به حداقل‌ترین برسه؛ نباید سوال تکراری پخش
 *    بشه، اگه چاره‌ای نبود تکراری باشه.»
 *
 * Neither mode had any memory that outlived a single game. Last Survivor kept a
 * per-ROOM set and threw it away when the room closed; the duel drew from a
 * stably sorted list with a seed made of the match id, which spreads picks out
 * but never rules anything out. Both then narrow the bank to one difficulty
 * tier before choosing, so a topic with two hundred questions but a dozen easy
 * ones is really a dozen-question topic for the opening rounds — and with a
 * dozen to choose from, two games running lands on the same question about half
 * the time. That is the repetition, and no amount of extra shuffling fixes it:
 * what is missing is a record of what the player has already seen.
 *
 * This is that record. One row per player per question, written the moment the
 * question is put in front of them.
 *
 * `refId` — the room or match it was first seen in — is what makes the duel
 * work. That mode re-derives every round from round zero on each request, so a
 * set that grows DURING the match would change the answer to «what was round 2»
 * halfway through it. Excluding by «seen somewhere that is not this game»
 * leaves the set fixed for the whole match while still being written the
 * instant a question is served, with no cutoff timestamp to get wrong and
 * nothing to remember across a restart.
 */
import { getPgPool } from '../database/postgres.js';
import { logger } from './logger.js';

/* Kept per player. Beyond this the oldest are forgotten, which is also the
 * honest answer to «what if they have seen everything» — a question from a
 * thousand games ago is not a repeat anybody notices. */
export const SEEN_MAX_PER_USER = 4000;

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS question_seen (
    user_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    ref_id TEXT NOT NULL DEFAULT '',
    seen_at BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, question_id))`);
  /* CREATE TABLE IF NOT EXISTS does nothing at all to a table that is already
   * there, so every column that could be added later is added explicitly. A
   * server upgrading onto its own older table has to keep working. */
  for (const col of [
    `ref_id TEXT NOT NULL DEFAULT ''`,
    `seen_at BIGINT NOT NULL DEFAULT 0`
  ]) {
    await pool.query(`ALTER TABLE question_seen ADD COLUMN IF NOT EXISTS ${col}`).catch(() => undefined);
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS question_seen_user ON question_seen(user_id, seen_at)`).catch(() => undefined);
  _schemaReady = true;
}

interface SeenRow { userId: string; questionId: string; refId: string; seenAt: number; }
const _mem: SeenRow[] = [];

/** Written the moment a question is put in front of these players. */
export async function markSeen(userIds: string[], questionId: string, refId: string): Promise<void> {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  const qid = String(questionId || '');
  if (!ids.length || !qid) return;
  const now = Date.now();
  const pool = pg();
  if (pool) {
    try {
      await ensureSchema(pool);
      /* First sighting wins. A question seen again in a later game keeps the
       * game it was FIRST seen in, which is what the duel's «not this match»
       * exclusion needs to stay true. */
      await pool.query(
        `INSERT INTO question_seen(user_id, question_id, ref_id, seen_at)
         SELECT u, $2, $3, $4 FROM unnest($1::text[]) AS u
         ON CONFLICT (user_id, question_id) DO NOTHING`,
        [ids, qid, String(refId || ''), now]);
    } catch (e) {
      /* Never let bookkeeping stop a match. A missed row costs one possible
       * repeat later; a thrown error costs the round. */
      logger.warn('question_seen_write_failed', { message: (e as Error).message });
    }
    return;
  }
  for (const u of ids) {
    if (!_mem.some((r) => r.userId === u && r.questionId === qid)) {
      _mem.push({ userId: u, questionId: qid, refId: String(refId || ''), seenAt: now });
    }
  }
}

/**
 * Every question these players have already been served somewhere OTHER than
 * `exceptRefId`. Pass '' to mean «everywhere».
 */
export async function seenElsewhere(userIds: string[], exceptRefId: string): Promise<Set<string>> {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (!ids.length) return new Set();
  const except = String(exceptRefId || '');
  const pool = pg();
  if (pool) {
    try {
      await ensureSchema(pool);
      /* An EMPTY `except` means «everywhere», and it has to be spelled out:
         rows written before ref_id existed carry the column's default, which is
         also the empty string, so a plain `ref_id <> $2` would hide a player's
         entire pre-upgrade history from them. */
      const { rows } = await pool.query(
        `SELECT DISTINCT question_id FROM question_seen
          WHERE user_id = ANY($1::text[]) AND ($2 = '' OR ref_id <> $2)`,
        [ids, except]);
      return new Set(rows.map((r: any) => String(r.question_id)));
    } catch (e) {
      /* A bank with no exclusions is the old behaviour, which is worse but not
       * broken. Refusing to pick a question at all would be. */
      logger.warn('question_seen_read_failed', { message: (e as Error).message });
      return new Set();
    }
  }
  const out = new Set<string>();
  for (const r of _mem) if (ids.includes(r.userId) && (!except || r.refId !== except)) out.add(r.questionId);
  return out;
}

/**
 * How many of these players have already seen each question, ignoring the game
 * they are in now. Last Survivor rooms hold many people and one question goes
 * to all of them, so «nobody has seen this» is often impossible — the room asks
 * for the LEAST-seen instead, which degrades to «unseen» whenever it can.
 */
export async function seenCounts(userIds: string[], exceptRefId: string): Promise<Map<string, number>> {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const except = String(exceptRefId || '');
  const pool = pg();
  if (pool) {
    try {
      await ensureSchema(pool);
      const { rows } = await pool.query(
        `SELECT question_id, count(*)::int AS n FROM question_seen
          WHERE user_id = ANY($1::text[]) AND ($2 = '' OR ref_id <> $2) GROUP BY question_id`,
        [ids, except]);
      for (const r of rows) out.set(String(r.question_id), Number(r.n) || 0);
      return out;
    } catch (e) {
      logger.warn('question_seen_read_failed', { message: (e as Error).message });
      return out;
    }
  }
  for (const r of _mem) {
    if (!ids.includes(r.userId) || (except && r.refId === except)) continue;
    out.set(r.questionId, (out.get(r.questionId) ?? 0) + 1);
  }
  return out;
}

/**
 * Choose from the candidates the players have seen least, and let the caller's
 * own randomness decide among those. This is «نباید سوال تکراری پخش بشه، اگه
 * چاره‌ای نبود تکراری باشه» expressed as a filter: it never returns an empty
 * list, so a thin bank still yields a question rather than stalling a match.
 */
export function leastSeen<T extends { id: string }>(candidates: T[], counts: Map<string, number>): T[] {
  if (candidates.length < 2) return candidates;
  let best = Infinity;
  for (const q of candidates) best = Math.min(best, counts.get(q.id) ?? 0);
  const out = candidates.filter((q) => (counts.get(q.id) ?? 0) === best);
  return out.length ? out : candidates;
}

/** Forget the oldest rows for one player once they are past the cap. */
export async function prune(userId: string): Promise<number> {
  const u = String(userId || '');
  if (!u) return 0;
  const pool = pg();
  if (pool) {
    try {
      await ensureSchema(pool);
      const { rowCount } = await pool.query(
        `DELETE FROM question_seen WHERE user_id = $1 AND question_id IN (
           SELECT question_id FROM question_seen WHERE user_id = $1
            ORDER BY seen_at DESC OFFSET $2)`,
        [u, SEEN_MAX_PER_USER]);
      return rowCount ?? 0;
    } catch { return 0; }
  }
  const mine = _mem.filter((r) => r.userId === u).sort((a, b) => b.seenAt - a.seenAt);
  let gone = 0;
  for (const r of mine.slice(SEEN_MAX_PER_USER)) {
    const i = _mem.indexOf(r);
    if (i >= 0) { _mem.splice(i, 1); gone++; }
  }
  return gone;
}

/** Test seam. */
export function _resetSeen(): void { _mem.length = 0; _schemaReady = false; }
export function _seenSize(): number { return _mem.length; }
