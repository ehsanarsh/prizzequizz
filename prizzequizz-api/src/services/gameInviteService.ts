/* PLAYER-TO-PLAYER GAME INVITES.
 *
 * «در قسمت افراد آنلاین باید کاربر بتونه درخواست بازی بده» — and from the
 * friends list, and from a Last Survivor waiting room. One invite, three places
 * it can be sent from, three modes it can be for.
 *
 * THE RULE THAT SHAPES THIS FILE is the one about being invited by half a room
 * at once: «وقتی اولین درخواست از اون روم بهش رفت، افراد دیگر نتونن بهش
 * درخواست بدن — چون چند درخواست پشت سر هم به یک نفر میره». So an invite is not
 * just a message: while one is pending, the person it was sent to is SPOKEN
 * FOR, and everybody else is told to wait. The claim lasts until they answer,
 * or sixty seconds, whichever comes first — long enough to read and decide,
 * short enough that somebody who put their phone down does not stay locked away
 * from everyone else.
 *
 * Nothing here touches tickets, rooms or money. An accepted invite tells the
 * client where to go; the player then walks in through the ordinary door and
 * pays the ordinary entry, exactly as if they had chosen the game themselves.
 * That is deliberate — it is the one way to add this without putting a second,
 * half-tested path in front of the parts that handle money.
 */
import { getPgPool } from '../database/postgres.js';
import { id } from '../utils/id.js';

export type InviteMode = 'duel' | 'ls' | 'wta';
export type InviteStatus = 'pending' | 'accepted' | 'rejected' | 'expired' | 'cancelled';

export interface GameInvite {
  id: string;
  fromUserId: string;
  fromName: string;
  toUserId: string;
  mode: InviteMode;
  /** Duel only: which tier both sides play at. Empty for the other modes. */
  ticketTier: string;
  /* THE FRIENDLY SECTION HAS NO TICKETS.
   *
   * «در قسمت دوستانه فقط درخواست دوئل میتونی بدی اونم نه با بلیط بلکه با سکهٔ
   * انتخابی کاربر که بتونه حتی تعداد سکه رو بنویسه و یک قلب.» So a friendly
   * duel is arranged for a NUMBER OF COINS, written by the person sending it,
   * and the ticket tier stays empty. Zero means the ordinary, paid kind.
   *
   * Like the tier, this is carried and quoted back, never charged here — the
   * coins and the heart are spent by the ordinary entry on the other side. */
  coinStake: number;
  /** Last Survivor / all-or-nothing: the room being joined, when there is one. */
  roomId: string;
  /** The room's topic, carried so the invitee lands on the ticket screen FOR
   *  that room rather than being dropped on topic-selection to guess which one
   *  they were invited to. */
  roomTopic: string;
  /** Set for an invite sent from inside a room, so the room's OTHER members can
   *  be told the person is already spoken for. */
  fromRoomId: string;
  status: InviteStatus;
  createdAt: number;
  expiresAt: number;
}

/** How long one invite holds its claim on the person it was sent to. */
export const INVITE_TTL_MS = 60_000;

export class InviteError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

const mem = new Map<string, GameInvite>();

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS game_invites (
    id TEXT PRIMARY KEY,
    from_user_id TEXT NOT NULL,
    from_name TEXT NOT NULL DEFAULT '',
    to_user_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'duel',
    ticket_tier TEXT NOT NULL DEFAULT '',
    coin_stake INT NOT NULL DEFAULT 0,
    room_id TEXT NOT NULL DEFAULT '',
    room_topic TEXT NOT NULL DEFAULT '',
    from_room_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL)`);
  /* THE TABLE ABOVE IS ONLY EVER CREATED ONCE.
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing at all to a table that is already
   * there — it does not compare the columns. So the day `room_topic` was added
   * here, every server that had already created the table went on without it,
   * and every INSERT died with «column room_topic does not exist»: no invite
   * could be sent from anywhere in the game.
   *
   * Each column added after the first release therefore needs saying twice:
   * once for a fresh database, and once for the ones already out there. These
   * are cheap no-ops when the column is present, so they can simply stay. */
  for (const col of [
    `from_name TEXT NOT NULL DEFAULT ''`,
    `mode TEXT NOT NULL DEFAULT 'duel'`,
    `ticket_tier TEXT NOT NULL DEFAULT ''`,
    `coin_stake INT NOT NULL DEFAULT 0`,
    `room_id TEXT NOT NULL DEFAULT ''`,
    `room_topic TEXT NOT NULL DEFAULT ''`,
    `from_room_id TEXT NOT NULL DEFAULT ''`,
    `status TEXT NOT NULL DEFAULT 'pending'`
  ]) {
    await pool.query(`ALTER TABLE game_invites ADD COLUMN IF NOT EXISTS ${col}`);
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS game_invites_to ON game_invites(to_user_id, status, expires_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS game_invites_from ON game_invites(from_user_id, status)`);
  _schemaReady = true;
}

const rowToInvite = (r: any): GameInvite => ({
  id: String(r.id), fromUserId: String(r.from_user_id), fromName: String(r.from_name || ''),
  toUserId: String(r.to_user_id), mode: String(r.mode) as InviteMode,
  ticketTier: String(r.ticket_tier || ''), coinStake: Number(r.coin_stake) || 0,
  roomId: String(r.room_id || ''),
  roomTopic: String(r.room_topic || ''),
  fromRoomId: String(r.from_room_id || ''), status: String(r.status) as InviteStatus,
  createdAt: Number(r.created_at), expiresAt: Number(r.expires_at)
});

async function save(inv: GameInvite): Promise<GameInvite> {
  const pool = pg();
  if (!pool) { mem.set(inv.id, { ...inv }); return inv; }
  await ensureSchema(pool);
  await pool.query(
    `INSERT INTO game_invites (id, from_user_id, from_name, to_user_id, mode, ticket_tier, coin_stake, room_id, room_topic, from_room_id, status, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (id) DO UPDATE SET status=$11, expires_at=$13`,
    [inv.id, inv.fromUserId, inv.fromName, inv.toUserId, inv.mode, inv.ticketTier, inv.coinStake, inv.roomId, inv.roomTopic, inv.fromRoomId, inv.status, inv.createdAt, inv.expiresAt]
  );
  return inv;
}

/** The live claim on somebody, if there is one. Expiry is applied on read, so
 *  a lapsed invite never keeps anyone locked just because no sweeper ran. */
export async function pendingFor(toUserId: string, now = Date.now()): Promise<GameInvite | null> {
  const pool = pg();
  if (!pool) {
    const rows = [...mem.values()].filter((i) => i.toUserId === toUserId && i.status === 'pending' && i.expiresAt > now);
    rows.sort((x, y) => y.createdAt - x.createdAt);
    return rows[0] ?? null;
  }
  await ensureSchema(pool);
  const { rows } = await pool.query(
    `SELECT * FROM game_invites WHERE to_user_id=$1 AND status='pending' AND expires_at > $2 ORDER BY created_at DESC LIMIT 1`,
    [toUserId, now]
  );
  return rows[0] ? rowToInvite(rows[0]) : null;
}

export async function getInvite(inviteId: string): Promise<GameInvite | null> {
  const pool = pg();
  if (!pool) return mem.get(inviteId) ?? null;
  await ensureSchema(pool);
  const { rows } = await pool.query(`SELECT * FROM game_invites WHERE id=$1`, [inviteId]);
  return rows[0] ? rowToInvite(rows[0]) : null;
}

/** Who, of these people, is already spoken for — so a list of players can grey
 *  out the ones nobody else should be inviting right now. */
export async function claimedAmong(userIds: string[], now = Date.now()): Promise<Set<string>> {
  const out = new Set<string>();
  if (!userIds.length) return out;
  const pool = pg();
  if (!pool) {
    for (const i of mem.values()) {
      if (i.status === 'pending' && i.expiresAt > now && userIds.includes(i.toUserId)) out.add(i.toUserId);
    }
    return out;
  }
  await ensureSchema(pool);
  const { rows } = await pool.query(
    `SELECT DISTINCT to_user_id FROM game_invites WHERE status='pending' AND expires_at > $1 AND to_user_id = ANY($2::text[])`,
    [now, userIds]
  );
  for (const r of rows) out.add(String(r.to_user_id));
  return out;
}

/* THE KEY TO A PRIVATE ROOM.
 *
 * Was this person asked into this room, and did they say yes? Deliberately NOT
 * bounded by the invite's sixty-second window: that window is how long they
 * have to ANSWER, not how long they have to pick a ticket and walk in. The room
 * closes long before this does, so the room is the real limit. */
const ROOM_KEY_TTL_MS = 2 * 60 * 60_000;
export async function acceptedForRoom(userId: string, roomId: string, now = Date.now()): Promise<boolean> {
  if (!userId || !roomId) return false;
  const since = now - ROOM_KEY_TTL_MS;
  const pool = pg();
  if (!pool) {
    for (const i of mem.values()) {
      if (i.toUserId === userId && i.roomId === roomId && i.status === 'accepted' && i.createdAt >= since) return true;
    }
    return false;
  }
  await ensureSchema(pool);
  const { rows } = await pool.query(
    `SELECT 1 FROM game_invites WHERE to_user_id=$1 AND room_id=$2 AND status='accepted' AND created_at >= $3 LIMIT 1`,
    [userId, roomId, since]
  );
  return rows.length > 0;
}

export interface CreateInviteInput {
  fromUserId: string;
  fromName: string;
  toUserId: string;
  mode: InviteMode;
  ticketTier?: string;
  coinStake?: number;
  roomId?: string;
  roomTopic?: string;
  fromRoomId?: string;
}

/** How many practice coins a friendly duel may be arranged for. A whole number
 *  of coins, never negative, and never a figure nobody could hold — the number
 *  is typed by hand, so a slipped key must not travel. */
export const MAX_COIN_STAKE = 10_000;
function coins(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_COIN_STAKE);
}

/** Send one. Refuses when the person is already spoken for — that refusal IS
 *  the feature, so it says so in words the client can show as it stands. */
export async function createInvite(input: CreateInviteInput, now = Date.now()): Promise<GameInvite> {
  if (!input.fromUserId || !input.toUserId) throw new InviteError('BAD_INVITE', 'دعوت ناقص است');
  if (input.fromUserId === input.toUserId) throw new InviteError('SELF_INVITE', 'نمی‌توانی خودت را دعوت کنی');

  /* A COIN STAKE IS A DUEL, AND ONLY A DUEL. The friendly section has no rooms
     and no ladders — «در قسمت دوستانه فقط درخواست دوئل میتونی بدی» — so an
     invite that carries coins for anything else is a bug on the way in, not a
     room somebody ends up standing in wondering what they paid. */
  const coinStake = coins(input.coinStake);
  if (coinStake > 0 && input.mode !== 'duel') {
    throw new InviteError('COINS_DUEL_ONLY', 'بازی دوستانه فقط به‌صورت دوئل است');
  }

  const held = await pendingFor(input.toUserId, now);
  if (held) {
    /* Re-sending to somebody YOU are already waiting on is not a queue-jump —
       it is the same invite, so hand back the one that is already live rather
       than refusing the person who sent it. */
    if (held.fromUserId === input.fromUserId) return held;
    throw new InviteError('ALREADY_INVITED', 'این بازیکن همین حالا یک دعوت دیگر دارد — کمی بعد دوباره امتحان کن');
  }

  const inv: GameInvite = {
    id: id(), fromUserId: input.fromUserId, fromName: String(input.fromName || 'بازیکن'),
    toUserId: input.toUserId, mode: input.mode,
    ticketTier: String(input.ticketTier || ''), coinStake,
    roomId: String(input.roomId || ''),
    roomTopic: String(input.roomTopic || ''),
    fromRoomId: String(input.fromRoomId || ''),
    status: 'pending', createdAt: now, expiresAt: now + INVITE_TTL_MS
  };
  return save(inv);
}

/** Everything still live for me to answer. */
export async function incomingFor(toUserId: string, now = Date.now()): Promise<GameInvite[]> {
  const pool = pg();
  if (!pool) {
    return [...mem.values()]
      .filter((i) => i.toUserId === toUserId && i.status === 'pending' && i.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  await ensureSchema(pool);
  const { rows } = await pool.query(
    `SELECT * FROM game_invites WHERE to_user_id=$1 AND status='pending' AND expires_at > $2 ORDER BY created_at DESC LIMIT 5`,
    [toUserId, now]
  );
  return rows.map(rowToInvite);
}

/** Answering it. Only the person it was sent to may, and only once. */
export async function respond(inviteId: string, userId: string, accept: boolean, now = Date.now()): Promise<GameInvite> {
  const inv = await getInvite(inviteId);
  if (!inv) throw new InviteError('INVITE_NOT_FOUND', 'این دعوت پیدا نشد');
  if (inv.toUserId !== userId) throw new InviteError('NOT_YOURS', 'این دعوت برای تو نیست');
  if (inv.status !== 'pending') throw new InviteError('ALREADY_ANSWERED', 'به این دعوت قبلاً جواب داده‌ای');
  if (inv.expiresAt <= now) { inv.status = 'expired'; await save(inv); throw new InviteError('INVITE_EXPIRED', 'وقت این دعوت تمام شد'); }
  /* Answered means the claim is over, whichever way it went — the next person
     may invite them immediately. The STATUS is what says so; every reader of a
     claim (pendingFor, claimedAmong, incomingFor) asks for 'pending' first, so
     the deadline is left as it was rather than kept in step with it. Two fields
     that must agree are two fields that can disagree. */
  inv.status = accept ? 'accepted' : 'rejected';
  return save(inv);
}

/** The sender giving up (left the room, closed the sheet). */
export async function cancelInvite(inviteId: string, fromUserId: string, now = Date.now()): Promise<void> {
  const inv = await getInvite(inviteId);
  if (!inv || inv.fromUserId !== fromUserId || inv.status !== 'pending') return;
  inv.status = 'cancelled';
  inv.expiresAt = now;
  await save(inv);
}

/** Tests only. */
export function _resetInvites(): void { mem.clear(); }
