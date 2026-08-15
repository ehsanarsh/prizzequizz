/* WHO IS ACTUALLY IN THIS MATCH, ANSWERABLE OVER PLAIN HTTP.
 *
 * Before a duel starts, each client waits for proof that the opponent is really
 * in the room — a matched player who crashed or quit must not be played
 * against, and the entry has to be refundable. That proof only ever arrived on
 * the websocket (`server:presence`). On a network that drops websockets the
 * proof therefore never arrived, and after fifteen seconds every duel ended the
 * same way: «حریف به بازی متصل نشد», ticket refunded, back to the home screen,
 * no match. Last Survivor was unaffected because it never needed the socket.
 *
 * So presence is recorded here instead, from the requests a player makes
 * anyway: reading the match, fetching its questions, starting it, answering.
 * Both roads — socket and HTTP — write to the same place, so a player is
 * "present" if they showed up by EITHER, and the client can ask for it with an
 * ordinary GET.
 *
 * In memory on purpose: the active match state this sits beside
 * (activeMatchState) is in memory too, so nothing here is more fragile than
 * the match it describes. If the API is ever run as more than one process,
 * both need the same treatment together.
 */

/** How long a sighting counts for. Long enough to cover a slow question
 *  prefetch on a bad connection, short enough that a player who left is not
 *  still "in the room" when the next match is being decided. */
export const MATCH_PRESENCE_TTL_MS = 30_000;

const seen = new Map<string, Map<string, number>>();

/** Record that this player was heard from inside this match, just now. */
export function touchMatchPresence(matchId: string, userId: string, at = Date.now()): void {
  if (!matchId || !userId) return;
  let room = seen.get(matchId);
  if (!room) { room = new Map(); seen.set(matchId, room); }
  room.set(userId, at);
  if (seen.size > 5000) prune(at);
}

/** The players heard from inside this match recently, newest sighting first. */
export function presentInMatch(matchId: string, now = Date.now()): string[] {
  const room = seen.get(matchId);
  if (!room) return [];
  return [...room.entries()]
    .filter(([, at]) => now - at <= MATCH_PRESENCE_TTL_MS)
    .sort((a, b) => b[1] - a[1])
    .map(([userId]) => userId);
}

/** Milliseconds since this player was last heard from, or null if never. */
export function lastSeenInMatch(matchId: string, userId: string, now = Date.now()): number | null {
  const at = seen.get(matchId)?.get(userId);
  return at === undefined ? null : now - at;
}

/** Drop rooms nobody has been seen in for a while. */
export function prune(now = Date.now()): void {
  for (const [matchId, room] of seen) {
    for (const [userId, at] of room) if (now - at > MATCH_PRESENCE_TTL_MS * 10) room.delete(userId);
    if (room.size === 0) seen.delete(matchId);
  }
}

/** Tests only. */
export function _resetMatchPresence(): void { seen.clear(); }
