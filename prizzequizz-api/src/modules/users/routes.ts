import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { repositories } from '../../repositories/index.js';

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
}

function toDto(user: any) {
  return { id: user.id, username: user.username, displayName: user.displayName, plan: user.plan, level: user.level, xp: user.xp, weeklyScore: user.weeklyScore, lifelines: user.lifelines ?? { p5050: 2, psecond: 1, pstats: 5 }, balances: { wallet: user.wallet, coins: user.coins, hearts: user.hearts, tickets: user.tickets } };
}
