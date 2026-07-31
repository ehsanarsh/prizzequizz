/* GLOBAL PER-QUESTION ANSWER STATISTICS.
 *
 * Every answer to a question, from EVERY mode (duel, arena, Last Survivor,
 * toss…), is tallied here per option index. The «درصد بقیه» lifeline reads this
 * so it shows how ALL players who have ever seen that question answered it —
 * not just the people in the current room.
 *
 * Postgres-backed with an in-memory fallback. On first read for a question with
 * no tally yet, we lazily backfill from the historical `answers` table so the
 * feature works with data that already exists. */
import { getPgPool } from '../database/postgres.js';
import { logger } from './logger.js';

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS question_answer_stats (
    question_id TEXT NOT NULL,
    option_index INT NOT NULL,
    answer_count BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (question_id, option_index))`);
  _schemaReady = true;
}

// questionId → counts[]
const mem = new Map<string, number[]>();
const backfilled = new Set<string>();

/** Tally one answer. Called from every mode's answer path (fire-and-forget). */
export async function recordQuestionAnswer(questionId: string, optionIndex: number): Promise<void> {
  const idx = Number(optionIndex);
  if (!questionId || !Number.isInteger(idx) || idx < 0 || idx > 15) return;
  const pool = pg();
  try {
    if (pool) {
      await ensureSchema(pool);
      await pool.query(
        `INSERT INTO question_answer_stats(question_id, option_index, answer_count, updated_at)
         VALUES ($1,$2,1,now())
         ON CONFLICT (question_id, option_index)
         DO UPDATE SET answer_count = question_answer_stats.answer_count + 1, updated_at = now()`,
        [questionId, idx]);
      return;
    }
  } catch (e) { logger.warn('question_stats_record_failed', { questionId, message: (e as Error).message }); return; }
  const arr = mem.get(questionId) ?? [];
  arr[idx] = (arr[idx] ?? 0) + 1;
  mem.set(questionId, arr);
}

/** One-time lazy backfill from the historical answers table (Postgres only). */
async function backfillFromAnswers(pool: ReturnType<typeof getPgPool>, questionId: string): Promise<void> {
  if (backfilled.has(questionId)) return;
  backfilled.add(questionId);
  try {
    const { rows } = await pool.query(
      `SELECT selected_index AS idx, count(*)::int AS n FROM answers
       WHERE question_id=$1 AND selected_index >= 0 GROUP BY selected_index`, [questionId]);
    for (const r of rows) {
      await pool.query(
        `INSERT INTO question_answer_stats(question_id, option_index, answer_count, updated_at)
         VALUES ($1,$2,$3,now())
         ON CONFLICT (question_id, option_index)
         DO UPDATE SET answer_count = GREATEST(question_answer_stats.answer_count, $3), updated_at = now()`,
        [questionId, Number(r.idx), Number(r.n)]);
    }
  } catch { /* history is optional */ }
}

/** Raw counts per option for a question. */
export async function getQuestionCounts(questionId: string, optionCount = 4): Promise<number[]> {
  const counts = new Array(Math.max(1, optionCount)).fill(0);
  const pool = pg();
  if (pool) {
    try {
      await ensureSchema(pool);
      const { rows: pre } = await pool.query(`SELECT 1 FROM question_answer_stats WHERE question_id=$1 LIMIT 1`, [questionId]);
      if (!pre[0]) await backfillFromAnswers(pool, questionId);
      const { rows } = await pool.query(`SELECT option_index, answer_count FROM question_answer_stats WHERE question_id=$1`, [questionId]);
      for (const r of rows) { const i = Number(r.option_index); if (i >= 0 && i < counts.length) counts[i] = Number(r.answer_count); }
      return counts;
    } catch (e) { logger.warn('question_stats_read_failed', { questionId, message: (e as Error).message }); return counts; }
  }
  const arr = mem.get(questionId) ?? [];
  for (let i = 0; i < counts.length; i++) counts[i] = arr[i] ?? 0;
  return counts;
}

/**
 * Percentage split of how EVERYONE has answered this question so far.
 * Percentages are normalised to sum to 100 (largest-remainder) when there is
 * any data at all; with no data, all zeros and sample 0.
 */
export async function getQuestionDistribution(questionId: string, optionCount = 4): Promise<{ percents: number[]; sample: number }> {
  const counts = await getQuestionCounts(questionId, optionCount);
  const sample = counts.reduce((s, c) => s + c, 0);
  if (sample <= 0) return { percents: counts.map(() => 0), sample: 0 };
  const raw = counts.map((c) => (c / sample) * 100);
  const percents = raw.map((v) => Math.floor(v));
  let remainder = 100 - percents.reduce((s, v) => s + v, 0);
  // hand the remaining points to the largest fractional parts
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) percents[order[k]!.i]!++;
  return { percents, sample };
}
