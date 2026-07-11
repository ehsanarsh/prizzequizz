import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { leaderboards, type LeaderboardKind } from '../../services/leaderboardService.js';

const kinds: LeaderboardKind[] = ['weekly', 'overall', 'winnings'];

export function registerLeaderboardRoutes(router: Router, base: string): void {
  router.add('GET', `${base}/leaderboards/weekly`, async (ctx) => {
    json(ctx.res, 200, await leaderboards.get('weekly', readLimit(ctx.query), ctx.userId));
  });

  router.add('GET', `${base}/leaderboards/overall`, async (ctx) => {
    json(ctx.res, 200, await leaderboards.get('overall', readLimit(ctx.query), ctx.userId));
  });

  router.add('GET', `${base}/leaderboards/winnings`, async (ctx) => {
    json(ctx.res, 200, await leaderboards.get('winnings', readLimit(ctx.query), ctx.userId));
  });

  router.add('GET', `${base}/leaderboards/:kind`, async (ctx) => {
    const kind = ctx.params.kind as LeaderboardKind;
    if (!kinds.includes(kind)) return error(ctx.res, 404, 'LEADERBOARD_NOT_FOUND', 'Leaderboard not found.');
    json(ctx.res, 200, await leaderboards.get(kind, readLimit(ctx.query), ctx.userId));
  });
}

function readLimit(query: URLSearchParams): number {
  return Number(query.get('limit') ?? 50);
}
