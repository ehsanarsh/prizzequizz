import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { repositories } from '../../repositories/index.js';
import { inventoryFor } from '../../services/lifelineService.js';
import { AvatarError, AVATAR_MAX_BYTES, avatarUrlFor, getAvatar, removeAvatar, saveAvatar } from '../../services/avatarService.js';
import { buildUserStats } from '../../services/userStatsService.js';
import { equippedCharacterFor } from '../../services/characterSelectionService.js';
import { effectiveWeeklyScore } from '../../services/scoringConfig.js';
import { listOnlinePlayers, OnlinePlayersError } from '../../services/onlinePlayersService.js';
import { codeFor, inviteCount, redeem as redeemReferral, ReferralError, REFERRAL_REWARD_TIER, REFERRAL_REWARD_COUNT } from '../../services/referralService.js';

export function registerUserRoutes(router: Router, base: string): void {
  /* "Me" is whoever the token says it is — and nobody otherwise. This used to
   * fall back to the seeded demo account when the token was missing or stale,
   * which handed the caller ANOTHER user's XP, cup and wallet. That is exactly
   * how the header could disagree with the leaderboards: the header was showing
   * the demo user while the boards showed the real one. */
  router.add('GET', `${base}/users/me`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const user = await repositories.users.findById(ctx.userId);
    if (!user) return error(ctx.res, 404, 'USER_NOT_FOUND', 'User not found');
    // `character` rides along with `avatar` everywhere a player is drawn: the
    // card shows the photo on one face and the character on the other.
    json(ctx.res, 200, { ...toDto(user), avatar: await avatarUrlFor(user.id), character: await equippedCharacterFor(user.id) });
  });

  /* The home screen's «افراد آنلاین». `refresh=1` is the button; without it
   * this is the first look, which is free. */
  router.add('GET', `${base}/users/online`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const refresh = ctx.query.get('refresh') === '1' || ctx.query.get('refresh') === 'true';
    try {
      json(ctx.res, 200, await listOnlinePlayers(ctx.userId, refresh));
    } catch (e) {
      if (e instanceof OnlinePlayersError) {
        return error(ctx.res, e.code === 'INSUFFICIENT_COINS' ? 402 : 404, e.code, e.message);
      }
      throw e;
    }
  });

  // Complete/update the player's own profile (display name + unique username).
  /* MY OWN CODE — the half of this a player looks at rather than types.
     «خودم یه کد دارم که هر کی با اون وارد بشه برای من یه بلیط سبز میده.» There
     is deliberately no way to POST a code here: the only door is the one that
     completes a registration, and it is above. */
  router.add('GET', `${base}/users/me/referral`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const code = await codeFor(ctx.userId);
    json(ctx.res, 200, {
      code, invites: await inviteCount(ctx.userId),
      rewardTier: REFERRAL_REWARD_TIER, rewardCount: REFERRAL_REWARD_COUNT
    });
  });

  router.add('PATCH', `${base}/users/me`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const user = await repositories.users.findById(ctx.userId);
    if (!user) return error(ctx.res, 404, 'USER_NOT_FOUND', 'User not found');
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    /* Read BEFORE the fields below are written: «اولین ثبت نام» is the call
       that gives the account a username, and after this line it will have one. */
    const wasNew = !String(user.username || '').trim();
    if (typeof body.displayName === 'string' && body.displayName.trim()) user.displayName = body.displayName.trim().slice(0, 120);
    if (typeof body.username === 'string' && body.username.trim()) user.username = body.username.trim().slice(0, 64);
    /* Gender is optional and reversible. Anything that is not one of the three
     * answers clears it rather than being stored — a typo must not become a
     * value the online list then filters on. */
    if (body.gender !== undefined) {
      const g = String(body.gender);
      user.gender = (g === 'male' || g === 'female' || g === 'other') ? g : undefined;
    }
    // The username column is UNIQUE — a clash surfaces as a save error → 409.
    try {
      await repositories.users.save(user);
    } catch {
      return error(ctx.res, 409, 'USERNAME_TAKEN', 'این نام کاربری قبلاً گرفته شده است');
    }
    /* ── «کد معرف» ──────────────────────────────────────────────────────
       «اون کد رو باید در اولین ثبت نام وارد کنن، وگرنه بعد از ثبت نام دیگه
        جایی نباشه که بتونی وارد کنی و جایزه ببری.»

       So the window is THIS call, and only while it is the one that completes
       the account — `wasNew` is read before the save above, from whether the
       player had a username at all. Hiding the box on later screens would be a
       UI decision, and a UI decision is not a rule: somebody who found the
       endpoint afterwards gets the same answer as somebody who found the
       screen. Best-effort — a code that does not exist must not fail a
       registration that is otherwise complete. */
    let referral: { applied: boolean; reason?: string } = { applied: false };
    const rawRef = typeof body.referralCode === 'string' ? body.referralCode.trim() : '';
    if (rawRef) {
      if (!wasNew) referral = { applied: false, reason: 'TOO_LATE' };
      else {
        try { await redeemReferral(ctx.userId, rawRef); referral = { applied: true }; }
        catch (e) { referral = { applied: false, reason: e instanceof ReferralError ? e.code : 'FAILED' }; }
      }
    }
    json(ctx.res, 200, { ...toDto(user), avatar: await avatarUrlFor(user.id), character: await equippedCharacterFor(user.id), referral });
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

  /* Kept so older clients do not break, but it no longer writes. It used to
   * take whatever counts the browser sent, which made buying a help pointless:
   * anything the client can spend it can also mint. Spending now goes through
   * POST /lifelines/:key/use and this just answers with the truth. */
  router.add('PATCH', `${base}/users/me/lifelines`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    json(ctx.res, 200, { lifelines: await inventoryFor(ctx.userId) });
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
  return { id: user.id, username: user.username, displayName: user.displayName, gender: user.gender ?? null, plan: user.plan, level: user.level, xp: user.xp, weeklyScore: effectiveWeeklyScore(user), lifelines: user.lifelines ?? {}, balances: { wallet: user.wallet, coins: user.coins, hearts: user.hearts, tickets: user.tickets } };
}
