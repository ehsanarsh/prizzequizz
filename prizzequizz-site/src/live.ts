/* THE GAME'S OWN NUMBERS, ON THE PUBLIC SITE.
 *
 * The design's home page is built around live panels — a leaderboard, recent
 * winners, how many people are playing — and they were the one part of it that
 * shipped empty, because the site had never read anything but its own three
 * tables. A marketing page for a live game that cannot say who is winning is
 * the brochure, not the game.
 *
 * THE RULES THIS FILE FOLLOWS, and they are what make it safe to run beside a
 * live game on the same database:
 *
 *  1. READ ONLY. Every statement here is a SELECT. Nothing in this file writes,
 *     creates, alters or locks anything in the game's schema.
 *
 *  2. NO DATA IS BETTER THAN INVENTED DATA. Every getter returns null when it
 *     cannot answer, and the renderer omits the whole block. A leaderboard with
 *     plausible-looking placeholder names on a public page is a lie about a
 *     real product, and it is also how you end up shipping «علی رضایی — ۱۲۰۰»
 *     to production forever.
 *
 *  3. THE GAME COMES FIRST. Short statement timeouts, a small pool (db.ts), and
 *     a cache in front of everything, so a burst of visitors is a handful of
 *     queries per minute rather than per request. If a query is slow it is
 *     abandoned, not waited on.
 *
 *  4. NO PRIVATE DATA LEAVES. Phone numbers, wallet balances, emails and ids
 *     are never selected. What a visitor sees is what any player already sees
 *     on the in-game leaderboard: a display name and a score.
 */
import { getPgPool } from './db.js';
import { logger } from './log.js';

/* Long enough that a visitor sees a live-feeling page, short enough that the
 * numbers are never stale in a way anyone would notice. A page view does not
 * cost a query; a minute of page views costs one. */
const TTL_MS = Number(process.env.SITE_LIVE_TTL_MS ?? 60_000);

/* A slow query here must never become a slow page. The game's own traffic has
 * priority on this database and the site's answer is optional by design. */
const STATEMENT_TIMEOUT_MS = Number(process.env.SITE_LIVE_TIMEOUT_MS ?? 2_500);

/* `id::text NOT LIKE 'bot\_%'` is how the game's own board excludes bots, and
 * the site has to exclude exactly the same rows or the two disagree in public.
 * The `::text` is not decoration: users.id is a uuid and Postgres has no LIKE
 * for uuid — without it the query throws. */
const NOT_A_BOT = `id::text NOT LIKE 'bot\\_%'`;

export interface LeaderRow { rank: number; name: string; score: number; }
export interface WinnerRow { name: string; mode: string; when: string; }
export interface LiveStats {
  playersTotal: number;
  matchesTotal: number;
  matchesToday: number;
  playersThisWeek: number;
}

interface Entry<T> { at: number; value: T }
const cache = new Map<string, Entry<unknown>>();

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
  const hit = cache.get(key) as Entry<T> | undefined;
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    /* Logged, never rendered. A stale answer is better than none, so a failure
     * keeps serving the last good value until it ages out completely. */
    logger.warn('site_live_query_failed', { key, message: (e as Error).message });
    return hit ? hit.value : null;
  }
}

/** Runs one read-only statement with its own timeout, on its own connection. */
async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = await getPgPool().connect();
  try {
    /* Per-connection and per-transaction so it cannot leak into another
     * caller's session, and READ ONLY so the database itself refuses a write
     * even if this file is ever edited carelessly. */
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Number(STATEMENT_TIMEOUT_MS) || 2500}`);
    const { rows } = await client.query(sql, params);
    await client.query('COMMIT');
    return rows as T[];
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** The ISO week id the game stamps weekly_score with. Must match the game's
 *  isoWeekId exactly or the board reads empty every time. */
export function isoWeekId(date: Date = new Date()): string {
  const t = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((t.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/* A name safe to show a stranger. display_name is what the player chose to be
 * called; username is the fallback; «بازیکن» when there is neither, because a
 * blank row looks like a bug. Never the phone, never the id. */
const NAME_SQL = `COALESCE(NULLIF(TRIM(display_name), ''), NULLIF(TRIM(username), ''), 'بازیکن')`;

/** This week's top players, exactly as the in-game board ranks them. */
export async function leaderboard(limit = 5): Promise<LeaderRow[] | null> {
  const n = Math.max(1, Math.min(20, Math.floor(limit) || 5));
  return cached(`lb:${n}`, async () => {
    const rows = await query(
      `SELECT ${NAME_SQL} AS name, weekly_score AS score
         FROM users
        WHERE weekly_week = $1 AND weekly_score > 0 AND ${NOT_A_BOT}
        ORDER BY weekly_score DESC, id
        LIMIT $2`, [isoWeekId(), n]);
    return rows.map((r, i) => ({ rank: i + 1, name: String(r.name), score: Number(r.score) || 0 }));
  });
}

/* The modes a visitor should see named, in the words the game uses. A mode id
 * that is not here is not shown at all rather than shown raw: «lastSurvivor» on
 * a Persian marketing page is worse than one fewer row. */
const MODE_FA: Record<string, string> = {
  duel: 'دوئل',
  lastSurvivor: 'آخرین بازمانده',
  allOrNothing: 'همه یا هیچ'
};

/** Who won most recently. The ticker and the «برندگان» panel both read this. */
export async function recentWinners(limit = 6): Promise<WinnerRow[] | null> {
  const n = Math.max(1, Math.min(20, Math.floor(limit) || 6));
  return cached(`win:${n}`, async () => {
    const rows = await query(
      `SELECT ${NAME_SQL} AS name, m.mode_id, m.updated_at
         FROM matches m JOIN users u ON u.id = m.winner_user_id
        WHERE m.winner_user_id IS NOT NULL AND u.${NOT_A_BOT}
        ORDER BY m.updated_at DESC
        LIMIT $1`, [n]);
    return rows
      .filter((r) => MODE_FA[String(r.mode_id)])
      .map((r) => ({
        name: String(r.name),
        mode: MODE_FA[String(r.mode_id)]!,
        when: agoFa(new Date(r.updated_at))
      }));
  });
}

/** Counts for the stat row: how big the game is, and how busy it is today. */
export async function stats(): Promise<LiveStats | null> {
  return cached('stats', async () => {
    const rows = await query(
      `SELECT
         (SELECT count(*) FROM users WHERE ${NOT_A_BOT}) AS players_total,
         (SELECT count(*) FROM matches) AS matches_total,
         (SELECT count(*) FROM matches WHERE created_at >= now() - interval '1 day') AS matches_today,
         (SELECT count(*) FROM users WHERE weekly_week = $1 AND weekly_score > 0 AND ${NOT_A_BOT}) AS players_week`,
      [isoWeekId()]);
    const r = rows[0] ?? {};
    return {
      playersTotal: Number(r.players_total) || 0,
      matchesTotal: Number(r.matches_total) || 0,
      matchesToday: Number(r.matches_today) || 0,
      playersThisWeek: Number(r.players_week) || 0
    };
  });
}

/* «۳ دقیقه پیش». Persian, coarse on purpose — a marketing page saying «۴۷
 * ثانیه پیش» invites the reader to time it and catch the cache lying. */
export function agoFa(when: Date, now: Date = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - when.getTime()) / 1000));
  if (s < 90) return 'همین الان';
  const m = Math.round(s / 60);
  if (m < 60) return `${faNum(m)} دقیقه پیش`;
  const h = Math.round(m / 60);
  if (h < 24) return `${faNum(h)} ساعت پیش`;
  const d = Math.round(h / 24);
  if (d < 30) return `${faNum(d)} روز پیش`;
  return `${faNum(Math.round(d / 30))} ماه پیش`;
}

/** Persian digits WITH a thousands separator, for scores and counts — «۱۲٬۵۰۰».
 *  Deliberately not the same function as render.ts's `fa`, which converts digits
 *  and nothing else: a rank, a year or a step number must never be grouped. Two
 *  jobs, two names, one definition each. */
export function faNum(n: number): string {
  const grouped = String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '٬');
  return grouped.replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]!);
}

/** Everything the home page might show, fetched together. Each part is
 *  independently null, so one failing query costs one block and not the page. */
export async function homeLive(): Promise<{
  leaderboard: LeaderRow[] | null; winners: WinnerRow[] | null; stats: LiveStats | null;
}> {
  if (!process.env.DATABASE_URL) return { leaderboard: null, winners: null, stats: null };
  const [lb, win, st] = await Promise.all([
    leaderboard(5).catch(() => null),
    recentWinners(6).catch(() => null),
    stats().catch(() => null)
  ]);
  return { leaderboard: lb, winners: win, stats: st };
}

/** Testing seam: forget everything cached. */
export function _resetLiveCache(): void { cache.clear(); }
