import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { repositories } from '../../repositories/index.js';
import { AvatarError, AVATAR_MAX_BYTES, avatarUrlFor, getAvatar, removeAvatar, saveAvatar } from '../../services/avatarService.js';
import { buildUserStats } from '../../services/userStatsService.js';

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
  // Public profile of ANOTHER user + REAL aggregated stats (the card that opens
  // when you tap someone's avatar in a duel, on the leaderboard, in an LS room).
  // Public handle + competitive record only — never the real name / phone.
  router.add('GET', `${base}/users/:id/profile`, async (ctx) => {
    json(ctx.res, 200, await buildUserStats(ctx.params.id!));
  });

  router.add('GET', `${base}/users/:id/stats`, async (ctx) => {
    json(ctx.res, 200, await buildUserStats(ctx.params.id!));
  });
}

function toDto(user: any) {
  return { id: user.id, username: user.username, displayName: user.displayName, plan: user.plan, level: user.level, xp: user.xp, weeklyScore: user.weeklyScore, lifelines: user.lifelines ?? { p5050: 2, psecond: 1, pstats: 5 }, balances: { wallet: user.wallet, coins: user.coins, hearts: user.hearts, tickets: user.tickets } };
}
