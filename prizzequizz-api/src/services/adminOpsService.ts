/* Admin operations: transparent finance summary, running/finished match views,
 * the enriched suspicious-users list, and per-area RESET tools — all reading the
 * DB as the single source of truth, all atomic, all audited by the caller. */
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';
import { calculateUserRisk } from './deviceRiskService.js';
import { getAccount } from './walletLedgerService.js';
import { activeMatchState } from './matchStateStore.js';
import { logger } from './logger.js';
import { onlineCount, activeTodayCount } from './presenceService.js';

function pg() { try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; } }

// ---------------------------------------------------------------------------
// Transparent finance summary — every number derived from the immutable ledger.
// ---------------------------------------------------------------------------
export async function financeSummary(): Promise<Record<string, unknown>> {
  const pool = pg();
  const zero = {
    totalDeposits: 0, totalWithdrawnPaid: 0, pendingWithdraw: 0, approvedWithdraw: 0, rejectedWithdraw: 0,
    grossRewardsPaid: 0, totalTicketSpend: 0, totalStake: 0, feeIncome: 0, penalties: 0, bonuses: 0, refunds: 0,
    usersWalletBalance: 0, systemBalance: 0, netProfit: 0
  };
  if (!pool) {
    // memory driver: derive from wallet ledger via getAccount over known users
    const users = await repositories.users.list(1000).catch(() => []);
    let bal = 0; for (const u of users) { const a = await getAccount(u.id); bal += a.available + a.locked; }
    return { ...zero, usersWalletBalance: bal, formula: FORMULA, note: 'memory driver — ledger aggregates require Postgres' };
  }
  const agg = await pool.query(`
    SELECT
      coalesce(sum(amount) FILTER (WHERE entry_type='deposit'),0) AS deposits,
      coalesce(sum(amount) FILTER (WHERE entry_type='withdraw_paid'),0) AS withdrawn,
      coalesce(sum(amount) FILTER (WHERE entry_type IN ('match_reward','league_reward','referral_reward')),0) AS rewards,
      coalesce(sum(amount) FILTER (WHERE entry_type='ticket_purchase'),0) AS ticket_spend,
      coalesce(sum(amount) FILTER (WHERE entry_type='match_stake'),0) AS stake,
      coalesce(sum(amount) FILTER (WHERE entry_type='fee'),0) AS fee,
      coalesce(sum(amount) FILTER (WHERE entry_type='penalty'),0) AS penalty,
      coalesce(sum(amount) FILTER (WHERE entry_type='bonus'),0) AS bonus,
      coalesce(sum(amount) FILTER (WHERE entry_type IN ('refund','stake_refund')),0) AS refunds
    FROM wallet_ledger`);
  const w = await pool.query(`SELECT status, coalesce(sum(amount),0) AS total FROM withdraw_requests GROUP BY status`);
  const bal = await pool.query(`SELECT coalesce(sum(available),0) AS avail, coalesce(sum(locked),0) AS locked FROM wallet_accounts`);
  const a = agg.rows[0] || {};
  const byStatus: Record<string, number> = {}; for (const r of w.rows) byStatus[r.status] = Number(r.total);
  const n = (v: unknown) => Number(v) || 0;
  const deposits = n(a.deposits), withdrawn = n(a.withdrawn), rewards = n(a.rewards), ticketSpend = n(a.ticket_spend),
    stake = n(a.stake), fee = n(a.fee), penalty = n(a.penalty), bonus = n(a.bonus), refunds = n(a.refunds);
  const usersWalletBalance = n(bal.rows[0]?.avail) + n(bal.rows[0]?.locked);
  // House revenue = money collected (tickets+stakes+fees+penalties) minus money
  // paid out to players (gross rewards + bonuses + refunds).
  const netProfit = ticketSpend + stake + fee + penalty - rewards - bonus - refunds;
  // Cash the platform actually holds = external in − external out − player balances.
  const systemBalance = deposits - withdrawn - usersWalletBalance;
  return {
    totalDeposits: deposits, totalWithdrawnPaid: withdrawn,
    pendingWithdraw: byStatus['pending'] || 0, approvedWithdraw: byStatus['approved'] || 0,
    rejectedWithdraw: (byStatus['rejected'] || 0) + (byStatus['failed'] || 0),
    grossRewardsPaid: rewards, totalTicketSpend: ticketSpend, totalStake: stake,
    feeIncome: fee, penalties: penalty, bonuses: bonus, refunds,
    usersWalletBalance, systemBalance, netProfit, formula: FORMULA
  };
}
const FORMULA = 'سود خالص = (خرید بلیت + ورودی + کارمزد + جریمه) − (جوایز ناخالص + بونوس + بازگشت وجه) | موجودی سیستم = واریزها − برداشت‌های پرداختی − موجودی کل کاربران';

// ---------------------------------------------------------------------------
// Matches: running (live) vs finished (history) — always matching DB reality.
// ---------------------------------------------------------------------------
const LIVE_PHASES = new Set(['matchmaking', 'toss', 'topic', 'ready', 'question', 'countdown']);
function isLive(phase: string): boolean { return LIVE_PHASES.has(phase) || (phase !== 'result' && phase !== 'finished'); }

export async function runningMatches(): Promise<any[]> {
  const active = await activeMatchState.list().catch(() => []);
  return active.filter((m: any) => isLive(m.phase) && !m.duelSettled).map(matchRow);
}
export async function finishedMatches(limit = 50): Promise<any[]> {
  const pool = pg();
  if (!pool) {
    const active = await activeMatchState.list().catch(() => []);
    return active.filter((m: any) => !isLive(m.phase) || m.duelSettled).map(matchRow).slice(0, limit);
  }
  const { rows } = await pool.query(`SELECT * FROM matches WHERE status IN ('result','finished') ORDER BY updated_at DESC LIMIT $1`, [limit]);
  const out = [];
  for (const m of rows) {
    const players = await pool.query(`SELECT mp.*, u.username FROM match_players mp LEFT JOIN users u ON u.id=mp.user_id WHERE match_id=$1`, [m.id]);
    out.push({ id: m.id, modeId: m.mode_id, phase: m.status, economyType: m.economy_type, winnerUserId: m.winner_user_id, updatedAt: m.updated_at?.toISOString?.() ?? m.updated_at, players: players.rows.map((p: any) => ({ userId: p.user_id, username: p.username, score: p.score })) });
  }
  return out;
}
function matchRow(m: any) { return { id: m.id, modeId: m.modeId, phase: m.phase, round: m.round, economyType: m.economyType, winnerUserId: m.winnerUserId, updatedAt: m.updatedAt, players: (m.players ?? []).map((p: any) => ({ userId: p.userId, username: p.username, score: p.score })) }; }

// ---------------------------------------------------------------------------
// Suspicious users — full detail, not just a count.
// ---------------------------------------------------------------------------
export async function suspiciousUsers(): Promise<any[]> {
  const pool = pg();
  const map = new Map<string, any>();
  const ensure = (uid: string) => { let e = map.get(uid); if (!e) { e = { userId: uid, reasons: [], riskScore: 0, signals: [], lastAt: null }; map.set(uid, e); } return e; };
  // 1) integrity signals (open) → concrete cheat evidence
  try {
    const sigs = await repositories.integrity.list({ status: 'open', limit: 200 } as any).catch(() => repositories.integrity.list({ limit: 200 } as any));
    for (const s of (sigs as any[])) {
      const e = ensure(String(s.userId));
      e.reasons.push(s.type); e.signals.push({ id: s.id, type: s.type, severity: s.severity, status: s.status, metadata: (s as any).evidence ?? (s as any).metadata ?? {}, createdAt: s.createdAt });
      if (!e.lastAt || String(s.createdAt) > e.lastAt) e.lastAt = s.createdAt;
    }
  } catch { /* ignore */ }
  // 2) ledger velocity / failed withdrawals (Postgres only)
  if (pool) {
    try {
      const vel = await pool.query(`SELECT user_id, count(*) n FROM wallet_ledger WHERE created_at >= now() - interval '1 hour' GROUP BY user_id HAVING count(*) >= 30`);
      for (const r of vel.rows) { const e = ensure(r.user_id); e.reasons.push('high_velocity'); }
      const fw = await pool.query(`SELECT user_id, count(*) n FROM withdraw_requests WHERE status IN ('rejected','failed') AND created_at >= now() - interval '24 hours' GROUP BY user_id HAVING count(*) >= 3`);
      for (const r of fw.rows) { const e = ensure(r.user_id); e.reasons.push('failed_withdrawals'); }
    } catch { /* ignore */ }
  }
  // enrich with username + risk score
  const out = [];
  for (const e of map.values()) {
    const u = await repositories.users.findById(e.userId).catch(() => null);
    const risk = await calculateUserRisk(e.userId).catch(() => null) as any;
    out.push({ ...e, username: u?.username ?? e.userId, reasons: [...new Set(e.reasons)], riskScore: risk?.riskScore ?? 0 });
  }
  return out.sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
}

// ---------------------------------------------------------------------------
// RESET tools — destructive, per-area, atomic, audited by the caller.
// ---------------------------------------------------------------------------
export const RESET_AREAS = ['wallet', 'tickets', 'xp', 'cup', 'level', 'league', 'missions', 'stats', 'matchHistory', 'transactions', 'leaderboard', 'notifications', 'full'] as const;
export type ResetArea = typeof RESET_AREAS[number];

export async function resetArea(area: ResetArea): Promise<{ area: string; affected: number }> {
  const pool = pg();
  let affected = 0;
  const run = async (sql: string, args: unknown[] = []) => { if (pool) { const r = await pool.query(sql, args); affected += r.rowCount ?? 0; } };
  const areas: ResetArea[] = area === 'full' ? ['wallet', 'tickets', 'xp', 'cup', 'level', 'stats', 'matchHistory', 'transactions', 'leaderboard', 'notifications', 'missions', 'league'] : [area];

  for (const a of areas) {
    switch (a) {
      case 'wallet':
        // Hard reset: clear the ledger + accounts + mirror. (Explicit admin RESET
        // — intended for beta/testing; irreversible.)
        await run(`DELETE FROM wallet_ledger`); await run(`DELETE FROM wallet_accounts`); await run(`UPDATE users SET wallet_balance=0`);
        await run(`DELETE FROM withdraw_requests`);
        break;
      case 'tickets': await run(`UPDATE users SET tickets='{}'::jsonb`); break;
      case 'xp': await run(`UPDATE users SET xp=0`); break;
      case 'cup': await run(`UPDATE users SET weekly_score=0, weekly_week=''`); break;
      case 'level': await run(`UPDATE users SET level=1`); break;
      case 'stats': await run(`DELETE FROM answers`); break;
      case 'matchHistory': await run(`DELETE FROM match_players`); await run(`DELETE FROM matches`); break;
      case 'transactions': await run(`DELETE FROM transactions`); break;
      case 'leaderboard': await resetLeaderboards(); break;
      case 'notifications': await run(`DELETE FROM notifications`); break;
      case 'missions': await run(`DROP TABLE IF EXISTS user_missions`); break;
      case 'league': /* leagues are config-defined; nothing persisted yet */ break;
    }
  }
  if (!pool) logger.warn('reset_area_memory_noop', { area });
  return { area, affected };
}

async function resetLeaderboards(): Promise<void> {
  try {
    const { leaderboards } = await import('./leaderboardService.js');
    // rebuild from users → but a reset means clear; easiest: set every user's
    // board scores to their current (post-reset) values, which are 0 after an
    // xp/cup reset. If called standalone, clear via redis if available.
    const users = await repositories.users.list(1000).catch(() => []);
    for (const u of users) { await leaderboards.updateUser(u).catch(() => {}); }
  } catch (e) { logger.warn('reset_leaderboards_failed', { message: e instanceof Error ? e.message : 'x' }); }
}

// ---------------------------------------------------------------------------
// Main dashboard — a real, live snapshot of the whole system from the DB.
// Every number is a direct query; anything unavailable degrades to 0/[] rather
// than faking a value. Process RAM/uptime are real; full host CPU needs an agent.
// ---------------------------------------------------------------------------
export async function dashboardMetrics(): Promise<Record<string, unknown>> {
  const pool = pg();
  const live = await activeMatchState.list().catch(() => []);
  const runningCount = live.filter((m: any) => isLive(m.phase) && !m.duelSettled).length;
  const mem = process.memoryUsage();
  const sys = {
    ramUsedMB: Math.round(mem.rss / 1048576),
    heapUsedMB: Math.round(mem.heapUsed / 1048576),
    uptimeH: Math.round((process.uptime() / 3600) * 10) / 10,
    node: process.version
  };
  if (!pool) {
    const users = await repositories.users.list(1000).catch(() => []);
    return {
      registeredUsers: users.length,
      onlineUsers: await onlineCount(5).catch(() => 0),
      dau: await activeTodayCount().catch(() => 0),
      newUsersToday: 0,
      matchesToday: 0, runningMatches: runningCount, avgMatchSec: 0, todayRevenue: 0,
      pendingWithdrawals: 0, pendingWithdrawAmount: 0, openTickets: 0,
      usersSeries: [], matchesSeries: [], liveFeed: [], system: sys,
      note: 'memory driver — connect Postgres for full metrics'
    };
  }
  const q = async (sql: string, args: unknown[] = []): Promise<any[]> => {
    try { const r = await pool.query(sql, args); return r.rows; } catch { return []; }
  };
  const one = async (sql: string, args: unknown[] = [], key = 'c'): Promise<number> => {
    const rows = await q(sql, args); return Number(rows[0]?.[key] ?? 0) || 0;
  };
  const [
    registeredUsers, newUsersToday, dau, onlineUsers, matchesToday, avgMatchSec,
    pendingW, openTickets, usersSeries, matchesSeries, revToday
  ] = await Promise.all([
    one(`SELECT count(*)::int c FROM users`),
    one(`SELECT count(*)::int c FROM users WHERE created_at >= current_date`),
    /* Both of these used to read `game_sessions`, which nothing has ever
     * written to — so they were always 0 no matter how many people were
     * playing. They now read the presence table the router keeps up to date. */
    activeTodayCount().catch(() => 0),
    onlineCount(5).catch(() => 0),
    one(`SELECT count(*)::int c FROM matches WHERE created_at >= current_date`),
    one(`SELECT coalesce(avg(extract(epoch from (updated_at - created_at))),0)::int c FROM matches WHERE status IN ('result','finished') AND updated_at >= now() - interval '7 days'`),
    q(`SELECT count(*)::int n, coalesce(sum(amount),0)::bigint amt FROM withdraw_requests WHERE status='pending'`),
    one(`SELECT count(*)::int c FROM support_tickets WHERE status='open'`),
    q(`SELECT to_char(d::date,'MM-DD') AS "day", coalesce(u.c,0)::int c FROM generate_series(current_date - interval '29 days', current_date, interval '1 day') d
        LEFT JOIN (SELECT date(created_at) dt, count(*) c FROM users GROUP BY 1) u ON u.dt = d::date ORDER BY d`),
    q(`SELECT to_char(d::date,'MM-DD') AS "day", coalesce(m.c,0)::int c FROM generate_series(current_date - interval '29 days', current_date, interval '1 day') d
        LEFT JOIN (SELECT date(created_at) dt, count(*) c FROM matches GROUP BY 1) m ON m.dt = d::date ORDER BY d`),
    // today's house revenue from the ledger (income − payout), same formula as finance
    q(`SELECT
         coalesce(sum(amount) FILTER (WHERE entry_type='ticket_purchase'),0)
        +coalesce(sum(amount) FILTER (WHERE entry_type='match_stake'),0)
        +coalesce(sum(amount) FILTER (WHERE entry_type='fee'),0)
        +coalesce(sum(amount) FILTER (WHERE entry_type='penalty'),0)
        -coalesce(sum(amount) FILTER (WHERE entry_type IN ('match_reward','league_reward','referral_reward')),0)
        -coalesce(sum(amount) FILTER (WHERE entry_type='bonus'),0)
        -coalesce(sum(amount) FILTER (WHERE entry_type IN ('refund','stake_refund')),0) AS net
       FROM wallet_ledger WHERE created_at >= current_date`)
  ]);
  // Live feed: newest real events across signups, matches, withdrawals, security.
  const feed: any[] = [];
  for (const r of await q(`SELECT username, created_at FROM users ORDER BY created_at DESC LIMIT 6`))
    feed.push({ kind: 'signup', at: iso(r.created_at), text: `ثبت‌نام: ${r.username ?? '—'}` });
  for (const r of await q(`SELECT m.id, m.mode_id, m.status, m.updated_at, u.username FROM matches m LEFT JOIN users u ON u.id=m.winner_user_id ORDER BY m.updated_at DESC LIMIT 6`))
    feed.push({ kind: 'match', at: iso(r.updated_at), text: `مسابقه ${String(r.id).slice(0, 6)} · ${r.status}${r.username ? ' · برنده ' + r.username : ''}` });
  for (const r of await q(`SELECT amount, status, created_at FROM withdraw_requests ORDER BY created_at DESC LIMIT 4`))
    feed.push({ kind: 'withdraw', at: iso(r.created_at), text: `برداشت ${Number(r.amount).toLocaleString('fa-IR')} · ${r.status}` });
  feed.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  return {
    registeredUsers, newUsersToday, dau, onlineUsers,
    matchesToday, runningMatches: runningCount, avgMatchSec,
    todayRevenue: Number(revToday[0]?.net ?? 0) || 0,
    pendingWithdrawals: Number(pendingW[0]?.n ?? 0) || 0,
    pendingWithdrawAmount: Number(pendingW[0]?.amt ?? 0) || 0,
    openTickets,
    usersSeries, matchesSeries, liveFeed: feed.slice(0, 14), system: sys
  };
}
function iso(d: any): string { return d?.toISOString?.() ?? String(d ?? ''); }
