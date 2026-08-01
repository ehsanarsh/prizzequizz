/* PUBLIC PLAYER STATS — the single real source behind the profile card that
 * opens when you tap someone's avatar (in a duel, on the leaderboard, in a Last
 * Survivor room, anywhere).
 *
 * Everything here is computed from the real tables: matches actually played,
 * money actually won from the ledger, answers actually given. Nothing is
 * invented — a player with no history comes back with zeros and `hasHistory:
 * false` so the client can show an honest empty state instead of filler.
 *
 * Privacy: this is what OTHER people see, so it exposes the public handle and
 * competitive record only — never the real name or phone number. */
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';
import { avatarUrlFor } from './avatarService.js';
import { equippedCharacterFor } from './characterSelectionService.js';
import type { EquippedCharacter } from './characterSelectionService.js';
import { effectiveWeeklyScore } from './scoringConfig.js';

/** Weekly-cup thresholds. Must stay in step with the client's `leagueTargets`. */
export const LEAGUE_TIERS = { bronze: 500, silver: 940, gold: 1680 } as const;

export function leagueForCup(cup: number): { key: string; emoji: string; name: string } {
  const c = Number(cup) || 0;
  if (c >= LEAGUE_TIERS.gold) return { key: 'gold', emoji: '🥇', name: 'لیگ طلایی' };
  if (c >= LEAGUE_TIERS.silver) return { key: 'silver', emoji: '🥈', name: 'لیگ نقره‌ای' };
  if (c >= LEAGUE_TIERS.bronze) return { key: 'bronze', emoji: '🥉', name: 'لیگ برنزی' };
  return { key: 'none', emoji: '🎯', name: 'بدون لیگ' };
}

export interface PublicUserStats {
  id: string;
  username: string;
  avatar: string | null;
  /** The card's other face. null when nothing is equipped. */
  character: EquippedCharacter | null;
  level: number;
  xp: number;
  weeklyScore: number;
  league: string;
  leagueKey: string;
  /** false → the player has never finished a match; the client shows an empty state. */
  hasHistory: boolean;
  matches: number; wins: number; losses: number; draws: number;
  winRate: number; accuracy: number;
  last5: string[];
  topTopics: Array<{ category: string; pct: number; count: number }>;
  totalPrize: number; bestPrize: number; weeklyPrize: number;
  perMode: Array<{ modeId: string; played: number; wins: number; winRate: number }>;
  recentMatches: Array<{ modeId: string; result: string; at: string }>;
}

export async function buildUserStats(uid: string): Promise<PublicUserStats> {
  let user = null;
  try { user = await repositories.users.findById(uid); } catch { user = null; }
  const weeklyScore = effectiveWeeklyScore(user);   // 0 once the week has rolled over
  const lg = leagueForCup(weeklyScore);
  const base: PublicUserStats = {
    id: uid,
    username: user?.username ?? 'player',
    avatar: await avatarUrlFor(uid),
    character: await equippedCharacterFor(uid),
    level: Number(user?.level ?? 1),
    xp: Number(user?.xp ?? 0),
    weeklyScore,
    league: `${lg.emoji} ${lg.name}`,
    leagueKey: lg.key,
    hasHistory: false,
    matches: 0, wins: 0, losses: 0, draws: 0, winRate: 0, accuracy: 0,
    last5: [], topTopics: [],
    totalPrize: 0, bestPrize: 0, weeklyPrize: 0,
    perMode: [], recentMatches: []
  };

  let pool;
  try { pool = getPgPool(); } catch { return base; }   // memory driver → real zeros

  try {
    const { rows } = await pool.query(
      `SELECT m.id AS mid, m.mode_id AS mode, m.winner_user_id AS w, m.updated_at AS at
         FROM match_players mp JOIN matches m ON m.id = mp.match_id
        WHERE mp.user_id = $1 AND m.status IN ('result','finished')
        ORDER BY m.updated_at DESC LIMIT 200`, [uid]);

    let wins = 0, losses = 0, draws = 0;
    const last5: string[] = [];
    const recentMatches: PublicUserStats['recentMatches'] = [];
    const modeAgg: Record<string, { played: number; wins: number }> = {};
    for (const r of rows) {
      const res = r.w == null ? 'D' : (String(r.w) === String(uid) ? 'W' : 'L');
      if (res === 'W') wins++; else if (res === 'L') losses++; else draws++;
      if (last5.length < 5) last5.push(res);
      const mode = String(r.mode ?? 'duel');
      const m = (modeAgg[mode] ??= { played: 0, wins: 0 });
      m.played += 1; if (res === 'W') m.wins += 1;
      if (recentMatches.length < 12) recentMatches.push({ modeId: mode, result: res, at: r.at?.toISOString?.() ?? String(r.at) });
    }
    const matches = rows.length;

    const acc = await pool.query(`SELECT count(*) FILTER (WHERE correct) AS ok, count(*) AS total FROM answers WHERE user_id = $1`, [uid]);
    const accTotal = Number(acc.rows[0]?.total ?? 0);
    const accuracy = accTotal > 0 ? Math.round((Number(acc.rows[0].ok) / accTotal) * 100) : 0;

    /* Prize money straight from the ledger, net of the commission taken on the
     * same match — the figure that actually reached the wallet, and the same one
     * the leaderboards use. `best` is the biggest single match net, so it can
     * never exceed the total, and `weekly` uses the cup's Monday boundary so it
     * can never exceed the lifetime figure. */
    const pz = await pool.query(
      `WITH per_match AS (
         SELECT coalesce(ref_id, id::text) AS m,
                min(created_at) AS at,
                sum(CASE WHEN entry_type IN ('match_reward','league_reward') AND kind='credit' THEN amount
                         WHEN entry_type='fee' AND ref_type='match' THEN -amount ELSE 0 END) AS net
           FROM wallet_ledger
          WHERE user_id = $1
            AND (entry_type IN ('match_reward','league_reward') OR (entry_type='fee' AND ref_type='match'))
          GROUP BY 1)
       SELECT coalesce(sum(net) FILTER (WHERE net > 0),0) AS total,
              coalesce(max(net),0) AS best,
              coalesce(sum(net) FILTER (WHERE net > 0 AND at >= date_trunc('week', now())),0) AS weekly
         FROM per_match`, [uid]);
    const pzr = pz.rows[0] || {};

    const t = await pool.query(
      `SELECT q.category AS cat, count(*) FILTER (WHERE a.correct) AS ok, count(*) AS total
         FROM answers a JOIN questions q ON q.id = a.question_id WHERE a.user_id = $1
        GROUP BY q.category HAVING count(*) >= 3
        ORDER BY (count(*) FILTER (WHERE a.correct))::float / count(*) DESC, count(*) DESC LIMIT 6`, [uid]);

    return {
      ...base,
      hasHistory: matches > 0 || accTotal > 0,
      matches, wins, losses, draws,
      winRate: matches ? Math.round((wins / matches) * 100) : 0,
      accuracy, last5,
      topTopics: t.rows.map((r) => ({ category: r.cat, pct: Math.round((Number(r.ok) / Math.max(1, Number(r.total))) * 100), count: Number(r.total) })),
      totalPrize: Number(pzr.total || 0), bestPrize: Number(pzr.best || 0), weeklyPrize: Number(pzr.weekly || 0),
      perMode: Object.entries(modeAgg).map(([modeId, v]) => ({ modeId, played: v.played, wins: v.wins, winRate: v.played ? Math.round((v.wins / v.played) * 100) : 0 })),
      recentMatches
    };
  } catch {
    return base;   // a query problem must never fabricate numbers
  }
}
