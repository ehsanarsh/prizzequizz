import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { repositories } from '../../repositories/index.js';
import { getPgPool } from '../../database/postgres.js';

export function registerUserRoutes(router: Router, base: string): void {
  router.add('GET', `${base}/users/me`, async (ctx) => {
    const user = (await repositories.users.findById(ctx.userId ?? 'u1')) ?? (await repositories.users.findById('u1'))!;
    json(ctx.res, 200, toDto(user));
  });

  // Complete/update the player's own profile (display name + unique username).
  router.add('PATCH', `${base}/users/me`, async (ctx) => {
    const user = await repositories.users.findById(ctx.userId ?? 'u1');
    if (!user) return error(ctx.res, 404, 'USER_NOT_FOUND', 'User not found');
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    if (typeof body.displayName === 'string' && body.displayName.trim()) user.displayName = body.displayName.trim().slice(0, 120);
    if (typeof body.username === 'string' && body.username.trim()) user.username = body.username.trim().slice(0, 64);
    // The username column is UNIQUE — a clash surfaces as a save error → 409.
    try {
      await repositories.users.save(user);
    } catch {
      return error(ctx.res, 409, 'USERNAME_TAKEN', 'این نام کاربری قبلاً گرفته شده است');
    }
    json(ctx.res, 200, toDto(user));
  });
  // Persist the player's lifeline inventory (decremented on use, server-side).
  router.add('PATCH', `${base}/users/me/lifelines`, async (ctx) => {
    const user = await repositories.users.findById(ctx.userId ?? 'u1');
    if (!user) return error(ctx.res, 404, 'USER_NOT_FOUND', 'User not found');
    const l = ((ctx.body ?? {}) as any).lifelines ?? {};
    const clamp = (n: unknown) => Math.max(0, Math.min(999, Math.floor(Number(n)) || 0));
    const lifelines = { p5050: clamp(l.p5050), psecond: clamp(l.psecond), pstats: clamp(l.pstats) };
    await repositories.users.updateLifelines(user.id, lifelines);
    json(ctx.res, 200, { lifelines });
  });
  // Public profile of ANOTHER user: expose only the public handle + stats.
  // Never the real name / phone (privacy).
  router.add('GET', `${base}/users/:id/profile`, async (ctx) => {
    const u = await repositories.users.findById(ctx.params.id!);
    json(ctx.res, 200, { id: ctx.params.id, username: u?.username ?? 'player', avatar: '🦊', level: u?.level ?? 1, league: 'Bronze', winRate: 62, totalPrize: 0 });
  });

  // REAL aggregated stats for a user (opponent panel): matches / wins / losses /
  // win-rate, last-5 W-L, and top-5 topics by correct-answer percentage.
  router.add('GET', `${base}/users/:id/stats`, async (ctx) => {
    const uid = ctx.params.id!;
    const u = await repositories.users.findById(uid);
    const empty = { id: uid, username: u?.username ?? 'player', level: u?.level ?? 1, matches: 0, wins: 0, losses: 0, draws: 0, winRate: 0, last5: [] as string[], topTopics: [] as any[] };
    try {
      const pool = getPgPool();
      const { rows } = await pool.query(
        `SELECT m.winner_user_id AS w FROM match_players mp JOIN matches m ON m.id = mp.match_id
         WHERE mp.user_id = $1 AND m.status IN ('result','finished') ORDER BY m.updated_at DESC LIMIT 200`, [uid]);
      let wins = 0, losses = 0, draws = 0; const last5: string[] = [];
      for (const r of rows) {
        const res = r.w == null ? 'D' : (String(r.w) === String(uid) ? 'W' : 'L');
        if (res === 'W') wins++; else if (res === 'L') losses++; else draws++;
        if (last5.length < 5) last5.push(res);
      }
      const matches = rows.length;
      const winRate = matches ? Math.round((wins / matches) * 100) : 0;
      const t = await pool.query(
        `SELECT q.category AS cat, count(*) FILTER (WHERE a.correct) AS ok, count(*) AS total
         FROM answers a JOIN questions q ON q.id = a.question_id WHERE a.user_id = $1
         GROUP BY q.category HAVING count(*) >= 3
         ORDER BY (count(*) FILTER (WHERE a.correct))::float / count(*) DESC, count(*) DESC LIMIT 5`, [uid]);
      const topTopics = t.rows.map((r) => ({ category: r.cat, pct: Math.round((Number(r.ok) / Math.max(1, Number(r.total))) * 100), count: Number(r.total) }));
      json(ctx.res, 200, { ...empty, matches, wins, losses, draws, winRate, last5, topTopics });
    } catch {
      json(ctx.res, 200, empty);
    }
  });
}

function toDto(user: any) {
  return { id: user.id, username: user.username, displayName: user.displayName, plan: user.plan, level: user.level, xp: user.xp, weeklyScore: user.weeklyScore, lifelines: user.lifelines ?? { p5050: 2, psecond: 1, pstats: 5 }, balances: { wallet: user.wallet, coins: user.coins, hearts: user.hearts, tickets: user.tickets } };
}
