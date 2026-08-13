import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { recordAdmin } from '../../services/adminAuditService.js';
import {
  getLeagueConfig, setLeagueConfig, cutLines, myLeague, closeSeason, drawRound,
  listQualifiers, listRooms, listSeats, reportRoomResult, currentSeasonId,
  LeagueError
} from '../../services/leagueService.js';

export function registerLeagueRoutes(router: Router, base: string): void {
  /* ── what a player sees ───────────────────────────────────────────── */

  /* The badges on the home screen's cup rail. Public: the numbers are simply
   * where the cut lines are this week, and every player needs them to know what
   * they are chasing. */
  router.add('GET', `${base}/leagues/cutlines`, async (ctx) => {
    json(ctx.res, 200, { season: currentSeasonId(), lines: await cutLines() });
  });

  router.add('GET', `${base}/leagues/me`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    json(ctx.res, 200, await myLeague(ctx.userId));
  });

  /* ── the operator ─────────────────────────────────────────────────── */

  router.add('GET', `${base}/admin/leagues/config`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'leagues' })) return;
    const season = currentSeasonId();
    json(ctx.res, 200, {
      config: await getLeagueConfig(),
      cutLines: await cutLines(),
      season,
      qualifiers: await listQualifiers(season),
      rooms: await listRooms(season)
    });
  });

  router.add('PUT', `${base}/admin/leagues/config`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'leagues' })) return;
    const next = await setLeagueConfig((ctx.body ?? {}) as any);
    await recordAdmin({ action: 'league_config', meta: next as any });
    json(ctx.res, 200, next);
  });

  /* Freeze the week and hand out the entry tickets. Idempotent by season, so
   * pressing it twice cannot double the tickets. */
  router.add('POST', `${base}/admin/leagues/close`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'leagues' })) return;
    const seasonId = String((ctx.body as any)?.season || currentSeasonId());
    try {
      const r = await closeSeason(seasonId);
      await recordAdmin({ action: 'league_close', meta: { season: r.seasonId, qualifiers: r.qualifiers.length, tickets: r.ticketsGranted } });
      json(ctx.res, 200, r);
    } catch (e) {
      if (e instanceof LeagueError) return error(ctx.res, 409, e.code, e.message);
      throw e;
    }
  });

  /* Build the rooms for a round. Round 1 seats the qualifiers; later rounds
   * seat the winners of the round before. */
  router.add('POST', `${base}/admin/leagues/draw`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'leagues' })) return;
    const b = (ctx.body ?? {}) as any;
    const seasonId = String(b.season || currentSeasonId());
    const round = Math.max(1, Math.round(Number(b.round) || 1));
    const rooms = await drawRound(seasonId, round);
    await recordAdmin({ action: 'league_draw', meta: { season: seasonId, round, rooms: rooms.length } });
    const withSeats = await Promise.all(rooms.map(async (r) => ({ ...r, seats: (await listSeats(r.id)).map((s) => s.userId) })));
    json(ctx.res, 200, { season: seasonId, round, rooms: withSeats });
  });

  router.add('GET', `${base}/admin/leagues/rooms`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'leagues' })) return;
    const seasonId = String(ctx.query.get('season') || currentSeasonId());
    const rooms = await listRooms(seasonId);
    json(ctx.res, 200, {
      season: seasonId,
      rooms: await Promise.all(rooms.map(async (r) => ({ ...r, seats: await listSeats(r.id) })))
    });
  });

  /* The result of a room. Today the operator can file it by hand; when the real
   * «از کی بپرسم» room exists it will call the same service function, so the
   * money only ever moves through one place. */
  router.add('POST', `${base}/admin/leagues/rooms/:id/result`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'leagues' })) return;
    const b = (ctx.body ?? {}) as any;
    const played = Array.isArray(b.played) ? b.played.map(String) : [];
    try {
      const r = await reportRoomResult({ roomId: String(ctx.params.id), played, winnerUserId: b.winnerUserId ? String(b.winnerUserId) : null });
      await recordAdmin({ action: 'league_room_result', meta: { roomId: r.room.id, payouts: r.payouts.length } });
      json(ctx.res, 200, r);
    } catch (e) {
      if (e instanceof LeagueError) return error(ctx.res, 404, e.code, e.message);
      throw e;
    }
  });
}
