/* WHAT IS NEW IN THE PANEL, AND WHERE.
 *
 * The panel has thirty-six sidebar rows. A withdrawal request, a support
 * ticket and a reported question all arrive silently: nothing changes on
 * screen, so the only way to find them is to open every tab and look. That is
 * how a payout sits unanswered for a day.
 *
 * So each screen that can receive something reports a number, and the panel
 * carries it all the way in — the sidebar row, then the subtab inside it, then
 * the row in the table — so «۳ تا جدید» is never a hunt for which three.
 *
 * Two kinds of number, because two different questions:
 *
 *   queue — how many items are still waiting for somebody. Pending payouts,
 *           open tickets. It goes away when the work is done, not when the
 *           screen is opened; opening a tab must never make a payout look
 *           handled.
 *
 *   new   — how many arrived since this admin last looked. Money movements,
 *           signups. There is nothing to "handle", so being seen IS the
 *           handling, and the count resets when the screen is opened.
 *
 * The seen mark is per admin account. Two people share a panel; one opening
 * the finance tab must not clear the other's badge.
 */
import { getPgPool } from '../database/postgres.js';
import { logger } from './logger.js';

export type BadgeMode = 'queue' | 'new';

export interface BadgeSource {
  screen: string;
  mode: BadgeMode;
  /** SQL counting what is waiting. `$1` is the seen mark, for 'new' sources. */
  sql: string;
}

/* Screen keys match the panel's nav keys exactly — a badge for a key the panel
 * does not have is a badge nobody will ever see. */
export const BADGE_SOURCES: BadgeSource[] = [
  { screen: 'withdrawals', mode: 'queue', sql: `SELECT count(*)::int c FROM withdraw_requests WHERE status='pending'` },
  { screen: 'rewardholds', mode: 'queue', sql: `SELECT count(*)::int c FROM reward_holds WHERE status='pending'` },
  { screen: 'support', mode: 'queue', sql: `SELECT count(*)::int c FROM support_tickets WHERE status IN ('open','escalated')` },
  { screen: 'qreports', mode: 'queue', sql: `SELECT count(*)::int c FROM question_reports WHERE status='open'` },
  /* Questions players wrote themselves. Nobody is watching that list, and each
   * unreviewed one is a player waiting for a prize. */
  { screen: 'questions', mode: 'queue', sql: `SELECT count(*)::int c FROM user_questions WHERE status='pending'` },
  { screen: 'suspicious', mode: 'queue', sql: `SELECT count(*)::int c FROM integrity_signals WHERE status='open'` },
  /* A partner with nothing left in stock cannot pay anybody — that is work
   * waiting, exactly like an unanswered ticket. */
  { screen: 'payoutpartners', mode: 'queue', sql: `SELECT count(*)::int c FROM payout_partners p WHERE p.enabled AND NOT EXISTS (SELECT 1 FROM payout_codes pc WHERE pc.partner_id=p.id AND pc.status='available')` },
  /* What broke on a player's phone. Until this line existed the whole queue was
     invisible: the table was written by nothing and read by nobody. */
  { screen: 'errors', mode: 'queue', sql: `SELECT count(*)::int c FROM error_reports WHERE status='open'` },
  { screen: 'finance', mode: 'new', sql: `SELECT count(*)::int c FROM wallet_ledger WHERE created_at > $1` },
  { screen: 'payments', mode: 'new', sql: `SELECT count(*)::int c FROM transactions WHERE created_at > $1` },
  { screen: 'users', mode: 'new', sql: `SELECT count(*)::int c FROM users WHERE created_at > $1` }
];

export interface ScreenBadge {
  count: number;
  mode: BadgeMode;
  /** For 'new': what the panel should mark individual rows against. */
  since: string | null;
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

/* ── the seen mark ─────────────────────────────────────────────────────── */

/* A SEPARATOR THAT SURVIVES BEING EDITED. This was a RAW NUL BYTE in the
   source — which made the file «binary» to grep, and any tool that copied it
   through a text round-trip silently turned `'\u0000'` into `''`. Then
   `k.split('')` split into single characters and every mark was lost: the
   badges kept counting from the beginning of time. Written as an escape, it
   behaves identically and cannot be destroyed by looking at it. */
const SEEN_SEP = '\u0000';
const memSeen = new Map<string, string>();          // `${adminId}${SEEN_SEP}${screen}` → ISO
const memCount = new Map<string, (since: Date | null) => number | Promise<number>>();

/** Test seam: stand in for a table this process has no database for. */
export function _setCounter(screen: string, fn: ((since: Date | null) => number | Promise<number>) | null): void {
  if (fn) memCount.set(screen, fn); else memCount.delete(screen);
}
/** Test seam. */
export function _resetBadges(): void { memSeen.clear(); memCount.clear(); _schemaReady = false; }

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<boolean> {
  if (_schemaReady) return true;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS admin_screen_seen (
      admin_id TEXT NOT NULL,
      screen   TEXT NOT NULL,
      seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (admin_id, screen))`);
    _schemaReady = true;
    return true;
  } catch (e) {
    /* Badges are decoration on top of a working panel. If this table cannot be
     * created the panel must still open — every other screen is unaffected. */
    logger.warn('admin_screen_seen_unavailable', { message: (e as Error).message });
    return false;
  }
}

const seenKey = (adminId: string, screen: string): string => adminId + SEEN_SEP + screen;

async function loadSeen(adminId: string): Promise<Map<string, string>> {
  const pool = pg();
  const out = new Map<string, string>();
  if (pool && await ensureSchema(pool)) {
    try {
      const { rows } = await pool.query(`SELECT screen, seen_at FROM admin_screen_seen WHERE admin_id=$1`, [adminId]);
      for (const r of rows) out.set(String(r.screen), new Date(r.seen_at).toISOString());
      return out;
    } catch (e) { logger.warn('badge_seen_read_failed', { message: (e as Error).message }); }
  }
  for (const [k, v] of memSeen) {
    const [a, s] = k.split(SEEN_SEP);
    if (a === adminId && s) out.set(s, v);
  }
  return out;
}

/**
 * Record that this admin has now looked at a screen.
 * Returns the PREVIOUS mark, which is what the panel needs: everything after
 * it is what the admin is about to see for the first time, and gets a «جدید»
 * tag on its row. Returning the new mark would tag nothing, ever.
 */
export async function markScreenSeen(adminId: string, screen: string): Promise<string | null> {
  const before = (await loadSeen(adminId)).get(screen) ?? null;
  const now = new Date().toISOString();
  const pool = pg();
  if (pool && await ensureSchema(pool)) {
    try {
      await pool.query(
        `INSERT INTO admin_screen_seen(admin_id, screen, seen_at) VALUES ($1,$2,$3)
         ON CONFLICT (admin_id, screen) DO UPDATE SET seen_at=$3`,
        [adminId, screen, now]
      );
      return before;
    } catch (e) { logger.warn('badge_seen_write_failed', { message: (e as Error).message }); }
  }
  memSeen.set(seenKey(adminId, screen), now);
  return before;
}

/* ── the counts ────────────────────────────────────────────────────────── */

async function countFor(src: BadgeSource, since: Date | null): Promise<number> {
  /* A 'new' source with no mark yet would count the whole table — every user
   * who ever registered, on a panel opened for the first time. First sight of
   * a screen starts the clock instead. This is a property of the mode, so it
   * holds whatever the count is read from. */
  if (src.mode === 'new' && !since) return 0;
  try {
    const injected = memCount.get(src.screen);
    if (injected) return Math.max(0, Number(await injected(since)) || 0);
    const pool = pg();
    if (!pool) return 0;
    const { rows } = await pool.query(src.sql, src.mode === 'new' ? [since] : []);
    return Math.max(0, Number(rows[0]?.c) || 0);
  } catch (e) {
    /* One missing table must not blank out every other badge. */
    logger.warn('badge_count_failed', { screen: src.screen, message: (e as Error).message });
    return 0;
  }
}

function permitted(perms: string[] | undefined, screen: string): boolean {
  if (!perms || perms.includes('*')) return true;
  return perms.includes(screen);
}

/**
 * Every badge this admin should see, keyed by the panel's own screen key.
 * Screens they cannot open are left out — a number they can never act on is
 * worse than no number.
 */
export async function badgeCounts(adminId: string, perms?: string[]): Promise<{ screens: Record<string, ScreenBadge>; total: number; at: string }> {
  const seen = await loadSeen(adminId);
  const screens: Record<string, ScreenBadge> = {};
  let total = 0;
  await Promise.all(BADGE_SOURCES.filter((s) => permitted(perms, s.screen)).map(async (src) => {
    const since = seen.get(src.screen) ?? null;
    const count = await countFor(src, since ? new Date(since) : null);
    screens[src.screen] = { count, mode: src.mode, since };
    total += count;
  }));
  /* A screen with a mark but no source still reports its mark, so a table that
   * tags new rows keeps working even where there is no badge for it. */
  for (const [screen, since] of seen) {
    if (!screens[screen] && permitted(perms, screen)) screens[screen] = { count: 0, mode: 'new', since };
  }
  return { screens, total, at: new Date().toISOString() };
}

/** Marking a screen seen only affects 'new' screens — a queue is not cleared by looking at it. */
export function isQueueScreen(screen: string): boolean {
  return BADGE_SOURCES.some((s) => s.screen === screen && s.mode === 'queue');
}
