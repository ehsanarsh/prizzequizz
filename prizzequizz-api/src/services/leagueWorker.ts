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
import { currentSeasonId, listRooms } from './leagueService.js';
import { openForLeagueRoom, start as wtaStart, _room } from './wtaService.js';

/** How long before kickoff the doors open. */
export const LEAGUE_DOORS_MINUTES = 10;

export async function leagueTick(now = Date.now()): Promise<void> {
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
