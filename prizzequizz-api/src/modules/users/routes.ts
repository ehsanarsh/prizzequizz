import type { Router } from '../../http/router.js';
import { json } from '../../http/response.js';
import { repositories } from '../../repositories/index.js';

export function registerUserRoutes(router: Router, base: string): void {
  router.add('GET', `${base}/users/me`, async (ctx) => {
    const user = (await repositories.users.findById(ctx.userId ?? 'u1')) ?? (await repositories.users.findById('u1'))!;
    json(ctx.res, 200, toDto(user));
  });
  router.add('GET', `${base}/users/:id/profile`, (ctx) => {
    json(ctx.res, 200, { id: ctx.params.id, username: 'Opponent', displayName: 'حریف', avatar: '🦊', level: 5, league: 'Bronze', winRate: 62, totalPrize: 1250000 });
  });
}

function toDto(user: any) {
  return { id: user.id, username: user.username, displayName: user.displayName, plan: user.plan, level: user.level, xp: user.xp, weeklyScore: user.weeklyScore, balances: { wallet: user.wallet, coins: user.coins, hearts: user.hearts, tickets: user.tickets } };
}
