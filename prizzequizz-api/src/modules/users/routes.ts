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
  router.add('GET', `${base}/users/:id/profile`, (ctx) => {
    json(ctx.res, 200, { id: ctx.params.id, username: 'Opponent', displayName: 'حریف', avatar: '🦊', level: 5, league: 'Bronze', winRate: 62, totalPrize: 1250000 });
  });
}

function toDto(user: any) {
  return { id: user.id, username: user.username, displayName: user.displayName, plan: user.plan, level: user.level, xp: user.xp, weeklyScore: user.weeklyScore, balances: { wallet: user.wallet, coins: user.coins, hearts: user.hearts, tickets: user.tickets } };
}
