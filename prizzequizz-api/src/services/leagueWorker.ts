/* THE THING THAT OPENS THE DOORS AT KICKOFF.
 *
 * The league's rooms are drawn ahead of time with a start time on them, and the
 * matches begin at a FIXED moment — whoever is not there is out. Something has
 * to be watching the clock, or a room drawn on Tuesday would sit there on
 * Friday night with fifteen players staring at a lobby.
 *
 * It opens each room a few minutes early so players can take their seats, and
 * starts it on the stroke. Everything else — the turns, the timers, the result
 * and the money — belongs to the match itself.
 */
import { logger } from './logger.js';
import {
  currentSeasonId, listRooms, listQualifiers, closeSeason, getLeagueConfig,
  weekResetAt, voidTicketsAfterKickoff, LEAGUE_CLOSE_LEAD_MS, LEAGUE_DOORS_MINUTES
} from './leagueService.js';
import { openForLeagueRoom, start as wtaStart, _room } from './wtaService.js';

/**
 * FREEZE THE WEEK BEFORE THE BOARD IS WIPED.
 *
 * The cup board is scoped to the ISO week: one second after the boundary every
 * weekly score reads as zero and there is nobody left to reward. So the last
 * few minutes of the week are when the standings are frozen and the tickets go
 * out — «در آخرین لحظه که می‌خواد ری‌استارت بشه». Closing is idempotent by
 * season, so a tick every five seconds through those minutes hands out one set
 * of tickets, not sixty.
 */
export async function closeTick(now = Date.now()): Promise<boolean> {
  let cfg;
  try { cfg = await getLeagueConfig(); } catch { return false; }
  if (!cfg.enabled) return false;
  if (now < weekResetAt(now) - LEAGUE_CLOSE_LEAD_MS) return false;

  const seasonId = currentSeasonId();
  try {
    if ((await listQualifiers(seasonId)).length) return false;   // already frozen
    const r = await closeSeason(seasonId);
    logger.info('league_auto_closed', {
      season: r.seasonId, qualifiers: r.qualifiers.length,
      tickets: r.ticketsGranted, voided: r.ticketsVoided
    });
    return true;
  } catch (e) {
    logger.warn('league_auto_close_failed', { season: seasonId, message: (e as Error).message });
    return false;
  }
}

export async function leagueTick(now = Date.now()): Promise<void> {
  await closeTick(now);
  /* The kickoff has been and gone: whoever did not turn up loses the seat they
   * were holding, rather than carrying it around until the week rolls over. */
  try { await voidTicketsAfterKickoff(now); }
  catch (e) { logger.warn('league_ticket_expiry_failed', { message: (e as Error).message }); }
  let rooms;
  try { rooms = await listRooms(currentSeasonId()); }
  catch (e) { logger.warn('league_tick_list_failed', { message: (e as Error).message }); return; }

  for (const room of rooms) {
    if (room.status === 'finished') continue;
    try {
      /* Doors open early; the match starts on time. */
      if (now >= room.startsAt - LEAGUE_DOORS_MINUTES * 60_000) await openForLeagueRoom(room);
      if (now >= room.startsAt) {
        const live = _room(room.id);
        if (live && live.phase === 'lobby') {
          await wtaStart(room.id, now);
          logger.info('league_room_started', { roomId: room.id, tier: room.tier, round: room.round });
        }
      }
    } catch (e) {
      logger.warn('league_room_open_failed', { roomId: room.id, message: (e as Error).message });
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startLeagueWorker(intervalMs = 5000): void {
  if (timer) return;
  timer = setInterval(() => { void leagueTick(); }, intervalMs);
  timer.unref?.();
  logger.info('league_worker_started', { intervalMs });
}
export function stopLeagueWorker(): void { if (timer) { clearInterval(timer); timer = null; } }
