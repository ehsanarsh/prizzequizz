import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { recordAdmin } from '../../services/adminAuditService.js';
import {
  getLeagueConfig, setLeagueConfig, cutLines, myLeague, closeSeason, drawRound,
  listQualifiers, listRooms, listSeats, reportRoomResult, currentSeasonId, enterLeague,
  LeagueError
} from '../../services/leagueService.js';
import {
  openForLeagueRoom, join as wtaJoin, answer as wtaAnswer, pick as wtaPick,
  snapshot as wtaSnapshot, start as wtaStart, WtaError
} from '../../services/wtaService.js';

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

  /* ── «شروع مسابقه لیگ» ────────────────────────────────────────────
   * One button, pressed at kickoff. The server decides which room has the
   * next free seat, so rooms fill one at a time and the player is simply told
   * where they are sitting. Pressing it twice is not two seats. */
  router.add('POST', `${base}/leagues/enter`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    try {
      const r = await enterLeague(ctx.userId);
      await openForLeagueRoom(r.room);
      /* Pressing the button IS taking the seat, so they are marked present
       * here rather than being left «absent» until a second request lands —
       * a player who is absent at kickoff is out before the first question. */
      try { wtaJoin(r.room.id, ctx.userId); } catch { /* already started */ }
      json(ctx.res, 200, {
        roomId: r.room.id, tier: r.room.tier, roomNo: r.room.roomNo, round: r.room.round,
        startsAt: r.room.startsAt, seats: r.seats, roomSize: r.roomSize, joined: r.joined, full: r.full,
        room: await wtaSnapshot(r.room.id, ctx.userId)
      });
    } catch (e) {
      if (e instanceof LeagueError) {
        return error(ctx.res, e.code === 'NOT_QUALIFIED' || e.code === 'NO_LEAGUE_TICKET' ? 403 : 409, e.code, e.message);
      }
      throw e;
    }
  });

  /* ── «از کی بپرسم؟» — the match itself ───────────────────────────── */

  /* A seat in a league room is an invitation; taking it is what makes you a
   * player. Opening the room here rather than on a timer means a player who
   * arrives early is seated whether or not anyone else has arrived yet. */
  router.add('POST', `${base}/leagues/rooms/:id/join`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const rooms = await listRooms(currentSeasonId());
    const room = rooms.find((r) => r.id === ctx.params.id);
    if (!room) return error(ctx.res, 404, 'ROOM_NOT_FOUND', 'این اتاق پیدا نشد.');
    await openForLeagueRoom(room);
    try {
      wtaJoin(room.id, ctx.userId);
      json(ctx.res, 200, await wtaSnapshot(room.id, ctx.userId));
    } catch (e) {
      if (e instanceof WtaError) return error(ctx.res, e.code === 'NOT_INVITED' ? 403 : 409, e.code, e.message);
      throw e;
    }
  });

  router.add('GET', `${base}/leagues/rooms/:id`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const snap = await wtaSnapshot(String(ctx.params.id), ctx.userId);
    if (!snap) return error(ctx.res, 404, 'ROOM_NOT_FOUND', 'این اتاق هنوز باز نشده است.');
    json(ctx.res, 200, snap);
  });

  router.add('POST', `${base}/leagues/rooms/:id/answer`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    try {
      const r = await wtaAnswer(String(ctx.params.id), ctx.userId, Number((ctx.body as any)?.selectedIndex));
      json(ctx.res, 200, { ...r, room: await wtaSnapshot(String(ctx.params.id), ctx.userId) });
    } catch (e) {
      if (e instanceof WtaError) return error(ctx.res, 409, e.code, e.message);
      throw e;
    }
  });

  router.add('POST', `${base}/leagues/rooms/:id/pick`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    try {
      await wtaPick(String(ctx.params.id), ctx.userId, String((ctx.body as any)?.userId || ''));
      json(ctx.res, 200, await wtaSnapshot(String(ctx.params.id), ctx.userId));
    } catch (e) {
      if (e instanceof WtaError) return error(ctx.res, 409, e.code, e.message);
      throw e;
    }
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

  /* Start a room by hand — for a rehearsal, or when a kickoff has to be moved
   * on the night. */
  router.add('POST', `${base}/admin/leagues/rooms/:id/start`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'leagues' })) return;
    const rooms = await listRooms(currentSeasonId());
    const room = rooms.find((r) => r.id === ctx.params.id);
    if (!room) return error(ctx.res, 404, 'ROOM_NOT_FOUND', 'این اتاق پیدا نشد.');
    await openForLeagueRoom(room);
    await wtaStart(room.id);
    await recordAdmin({ action: 'league_room_start', meta: { roomId: room.id } });
    json(ctx.res, 200, await wtaSnapshot(room.id));
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
