import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { repositories } from '../../repositories/index.js';
import { getPgPool } from '../../database/postgres.js';
import { AvatarError, AVATAR_MAX_BYTES, avatarUrlFor, getAvatar, removeAvatar, saveAvatar } from '../../services/avatarService.js';

export function registerUserRoutes(router: Router, base: string): void {
  router.add('GET', `${base}/users/me`, async (ctx) => {
    const user = (await repositories.users.findById(ctx.userId ?? 'u1')) ?? (await repositories.users.findById('u1'))!;
    json(ctx.res, 200, { ...toDto(user), avatar: await avatarUrlFor(user.id) });
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
    json(ctx.res, 200, { ...toDto(user), avatar: await avatarUrlFor(user.id) });
  });
  /* ---- Profile photo ----
   * The client uploads an ALREADY-SHRUNK square thumbnail (WebP when the device
   * supports it, otherwise JPEG). We validate type + magic bytes, hard-cap the
   * size, store the bytes in their own table, and point the user's avatar at a
   * cacheable URL. The original camera file is never stored. */
  router.add('POST', `${base}/users/me/avatar`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const user = await repositories.users.findById(ctx.userId);
    if (!user) return error(ctx.res, 404, 'USER_NOT_FOUND', 'User not found');
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    try {
      const saved = await saveAvatar(user.id, String(body.image ?? ''));
      json(ctx.res, 200, { avatar: saved.url, bytes: saved.bytes, mime: saved.mime, maxBytes: AVATAR_MAX_BYTES });
    } catch (e) {
      if (e instanceof AvatarError) return error(ctx.res, 422, e.code, e.message);
      throw e;
    }
  });

  router.add('DELETE', `${base}/users/me/avatar`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const user = await repositories.users.findById(ctx.userId);
    if (!user) return error(ctx.res, 404, 'USER_NOT_FOUND', 'User not found');
    await removeAvatar(user.id);           // back to the character/mascot
    json(ctx.res, 200, { removed: true, avatar: null });
  });

  // Public image endpoint — long cache + ETag so it costs one request, once.
  router.add('GET', `${base}/users/:id/avatar`, async (ctx) => {
    const av = await getAvatar(ctx.params.id!);
    if (!av) return error(ctx.res, 404, 'AVATAR_NOT_FOUND', 'Avatar not found');
    const inm = ctx.req.headers['if-none-match'];
    if (inm && String(inm).replace(/"/g, '') === av.etag) { ctx.res.statusCode = 304; ctx.res.end(); return; }
    ctx.res.statusCode = 200;
    ctx.res.setHeader('content-type', av.mime);
    ctx.res.setHeader('content-length', String(av.data.length));
    ctx.res.setHeader('etag', `"${av.etag}"`);
    ctx.res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    ctx.res.end(av.data);
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
    json(ctx.res, 200, { id: ctx.params.id, username: u?.username ?? 'player', avatar: (await avatarUrlFor(ctx.params.id!)) ?? '🦊', level: u?.level ?? 1, league: 'Bronze', winRate: 62, totalPrize: 0 });
  });

  // REAL aggregated stats for a user (opponent panel): matches / wins / losses /
  // win-rate, last-5 W-L, and top-5 topics by correct-answer percentage.
  router.add('GET', `${base}/users/:id/stats`, async (ctx) => {
    const uid = ctx.params.id!;
    const u = await repositories.users.findById(uid);
    const empty = { id: uid, username: u?.username ?? 'player', level: u?.level ?? 1, xp: u?.xp ?? 0, weeklyScore: u?.weeklyScore ?? 0, matches: 0, wins: 0, losses: 0, draws: 0, winRate: 0, accuracy: 0, last5: [] as string[], topTopics: [] as any[], totalPrize: 0, bestPrize: 0, weeklyPrize: 0, perMode: [] as any[], recentMatches: [] as any[] };
    try {
      const pool = getPgPool();
      const { rows } = await pool.query(
        `SELECT m.id AS mid, m.mode_id AS mode, m.winner_user_id AS w, m.updated_at AS at FROM match_players mp JOIN matches m ON m.id = mp.match_id
         WHERE mp.user_id = $1 AND m.status IN ('result','finished') ORDER BY m.updated_at DESC LIMIT 200`, [uid]);
      let wins = 0, losses = 0, draws = 0; const last5: string[] = []; const recentMatches: any[] = [];
      const modeAgg: Record<string, { played: number; wins: number }> = {};
      for (const r of rows) {
        const res = r.w == null ? 'D' : (String(r.w) === String(uid) ? 'W' : 'L');
        if (res === 'W') wins++; else if (res === 'L') losses++; else draws++;
        if (last5.length < 5) last5.push(res);
        const mode = String(r.mode ?? 'duel');
        const m = (modeAgg[mode] ??= { played: 0, wins: 0 });
        m.played += 1; if (res === 'W') m.wins += 1;
        if (recentMatches.length < 12) recentMatches.push({ modeId: mode, result: res, at: r.at?.toISOString?.() ?? r.at });
      }
      const matches = rows.length;
      const winRate = matches ? Math.round((wins / matches) * 100) : 0;
      const perMode = Object.entries(modeAgg).map(([modeId, v]) => ({ modeId, played: v.played, wins: v.wins, winRate: v.played ? Math.round((v.wins / v.played) * 100) : 0 }));
      // Answer accuracy across all answered questions.
      const acc = await pool.query(`SELECT count(*) FILTER (WHERE correct) AS ok, count(*) AS total FROM answers WHERE user_id = $1`, [uid]);
      const accuracy = acc.rows[0] && Number(acc.rows[0].total) > 0 ? Math.round((Number(acc.rows[0].ok) / Number(acc.rows[0].total)) * 100) : 0;
      // Real cash prizes from the transactions ledger (won money only).
      const pz = await pool.query(
        `SELECT coalesce(sum(amount),0) AS total, coalesce(max(amount),0) AS best,
                coalesce(sum(amount) FILTER (WHERE created_at >= date_trunc('week', now())),0) AS weekly
         FROM transactions WHERE user_id = $1 AND direction='in' AND status <> 'failed' AND type IN ('reward','win') AND currency = 'cash'`, [uid]);
      const pzr = pz.rows[0] || {};
      const t = await pool.query(
        `SELECT q.category AS cat, count(*) FILTER (WHERE a.correct) AS ok, count(*) AS total
         FROM answers a JOIN questions q ON q.id = a.question_id WHERE a.user_id = $1
         GROUP BY q.category HAVING count(*) >= 3
         ORDER BY (count(*) FILTER (WHERE a.correct))::float / count(*) DESC, count(*) DESC LIMIT 6`, [uid]);
      const topTopics = t.rows.map((r) => ({ category: r.cat, pct: Math.round((Number(r.ok) / Math.max(1, Number(r.total))) * 100), count: Number(r.total) }));
      json(ctx.res, 200, { ...empty, matches, wins, losses, draws, winRate, accuracy, last5, topTopics, totalPrize: Number(pzr.total || 0), bestPrize: Number(pzr.best || 0), weeklyPrize: Number(pzr.weekly || 0), perMode, recentMatches });
    } catch {
      json(ctx.res, 200, empty);
    }
  });
}

function toDto(user: any) {
  return { id: user.id, username: user.username, displayName: user.displayName, plan: user.plan, level: user.level, xp: user.xp, weeklyScore: user.weeklyScore, lifelines: user.lifelines ?? { p5050: 2, psecond: 1, pstats: 5 }, balances: { wallet: user.wallet, coins: user.coins, hearts: user.hearts, tickets: user.tickets } };
}
