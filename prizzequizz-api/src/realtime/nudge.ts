/* «چیزی برایت رسید» — THE SHORTEST POSSIBLE MESSAGE.
 *
 * «وقتی دعوت به بازی رو میفرستی هیچ دعوتی نمیره و اگه بره هم با خیلی تاخیر.»
 *
 * An invite lives sixty seconds. It was only ever found by a poll running every
 * twelve — so on a good day it arrived halfway through its own life, and on a
 * bad one it expired unseen. The person who sent it had no way to tell the
 * difference between «they said no» and «they were never asked».
 *
 * This is the other half: the server says, over the socket that is already
 * open, that something is waiting. It deliberately carries NOTHING but the
 * kind. The client then reads the invite through the same endpoint it always
 * used, so there stays exactly one place that decides what an invite is and
 * what it looks like on screen. A nudge that carried the invite itself would be
 * a second such place, and the two would drift.
 *
 * It is also best-effort by design: the poll stays as the floor. A player whose
 * socket is closed — asleep, on the underground, on a browser that dropped it —
 * still gets the invite the old way. The push makes it fast; the poll is what
 * makes it certain.
 */
import { realtimeRooms } from './roomRegistry.js';

export type NudgeKind = 'invite' | 'duel_call';

/** The topic a player listens on: their own id, and nobody else's. */
export function userTopic(userId: string): string { return 'user:' + userId; }

/**
 * Tell one player that something of `kind` is waiting for them.
 * Never throws and never blocks the thing that triggered it: an invite that
 * failed to SEND because the notification failed is worse than a late one.
 */
export function nudgeUser(userId: string, kind: NudgeKind, data: Record<string, unknown> = {}): void {
  if (!userId) return;
  try {
    realtimeRooms.broadcastTopic(userTopic(userId), { type: 'server:nudge', payload: { kind, ...data } });
  } catch { /* the poll is the floor; this is only the fast path */ }
}
