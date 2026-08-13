/* THE WEEKLY LEAGUE.
 *
 * The week's cup board decides who gets in. The operator sets the rank ranges —
 * 1..15 gold, 16..30 silver, 31..45 bronze by default, all editable — and when
 * the week closes, everyone inside a range is given ONE entry ticket for that
 * tier. Those tickets exist only here: they are not for sale, and buying one
 * must be impossible rather than merely absent from the shop, because the whole
 * point of the ladder is that a place in it is played for.
 *
 * The matches are played at a FIXED kickoff, everyone at once. Whoever is not
 * there is out — that is the operator's decision and it is the only rule that
 * never deadlocks: a bracket that waits for absentees waits forever.
 *
 * A tier bigger than one room is split into rooms of `roomSize`, the winners of
 * those rooms meet in the next round, and so on until one player is left. With
 * 100 qualifiers and rooms of 10 that is ten rooms, then a final of ten.
 *
 * WHAT IS NOT HERE: the match itself. «از کی بپرسم» has never had a server side
 * — it is a local simulation against bots — so this file takes the league up to
 * the point of play (who is in, in which room, at what time, for what prize)
 * and hands the room over. `reportRoomResult` is where the real game will plug
 * in, and it is already the thing that pays.
 */
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';
import { logger } from './logger.js';
import { isoWeekId, effectiveWeeklyScore } from './scoringConfig.js';
import { grantTickets } from './ticketService.js';
import { grantReward } from './rewardsService.js';
import { randomInt } from 'node:crypto';

export class LeagueError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'LeagueError'; }
}

/* ── configuration ─────────────────────────────────────────────────────── */

export interface LeagueTier {
  key: string;            // gold | silver | bronze — also the ticket tier
  label: string;
  emoji: string;
  /** Inclusive rank range on the weekly cup board. 1-based. */
  fromRank: number;
  toRank: number;
  /** What every player who turns up and plays receives, win or lose. */
  participationPrize: number;
  /** What the last one standing receives, on top of nothing else. */
  winnerPrize: number;
  /** Coins/cash — both prizes are paid in this. */
  prizeType: 'cash' | 'coins';
}

export interface LeagueConfig {
  enabled: boolean;
  /** Seats per room. A tier larger than this is split and played in rounds. */
  roomSize: number;
  tiers: LeagueTier[];
  /** Kickoff, in the operator's own clock. 0 = شنبه … 6 = جمعه. */
  kickoff: { dayOfWeek: number; hour: number; minute: number; tzOffsetMinutes: number };
  /** Gap between one round and the next, for the players who advanced. */
  roundGapMinutes: number;
}

export const LEAGUE_DEFAULTS: LeagueConfig = {
  enabled: true,
  roomSize: 15,
  tiers: [
    { key: 'gold',   label: 'لیگ طلایی',  emoji: '🥇', fromRank: 1,  toRank: 15, participationPrize: 50000, winnerPrize: 500000, prizeType: 'cash' },
    { key: 'silver', label: 'لیگ نقره‌ای', emoji: '🥈', fromRank: 16, toRank: 30, participationPrize: 25000, winnerPrize: 250000, prizeType: 'cash' },
    { key: 'bronze', label: 'لیگ برنزی',  emoji: '🥉', fromRank: 31, toRank: 45, participationPrize: 10000, winnerPrize: 100000, prizeType: 'cash' }
  ],
  kickoff: { dayOfWeek: 6, hour: 21, minute: 0, tzOffsetMinutes: 210 },   // جمعه ۲۱:۰۰ به وقت تهران
  roundGapMinutes: 20
};

const CFG_KEY = 'weekly_league';
let memCfg: Partial<LeagueConfig> | null = null;

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

function cleanTier(t: Partial<LeagueTier>, fallback: LeagueTier): LeagueTier {
  const from = Math.max(1, Math.round(Number(t.fromRank ?? fallback.fromRank)) || fallback.fromRank);
  const to = Math.max(from, Math.round(Number(t.toRank ?? fallback.toRank)) || fallback.toRank);
  return {
    key: String(t.key || fallback.key),
    label: String(t.label || fallback.label),
    emoji: String(t.emoji || fallback.emoji),
    fromRank: from,
    toRank: to,
    participationPrize: Math.max(0, Math.round(Number(t.participationPrize ?? fallback.participationPrize)) || 0),
    winnerPrize: Math.max(0, Math.round(Number(t.winnerPrize ?? fallback.winnerPrize)) || 0),
    prizeType: t.prizeType === 'coins' ? 'coins' : 'cash'
  };
}

export async function getLeagueConfig(): Promise<LeagueConfig> {
  let raw: Partial<LeagueConfig> = memCfg ?? {};
  const pool = pg();
  if (pool) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS app_config (key VARCHAR(64) PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMP NOT NULL DEFAULT now(), updated_by VARCHAR(64))`);
      const { rows } = await pool.query(`SELECT value FROM app_config WHERE key=$1`, [CFG_KEY]);
      if (rows[0]?.value) raw = rows[0].value as Partial<LeagueConfig>;
    } catch (e) { logger.warn('league_config_read_failed', { message: (e as Error).message }); }
  }
  const tiers = (Array.isArray(raw.tiers) && raw.tiers.length ? raw.tiers : LEAGUE_DEFAULTS.tiers)
    .map((t, i) => cleanTier(t, LEAGUE_DEFAULTS.tiers[Math.min(i, LEAGUE_DEFAULTS.tiers.length - 1)]!));
  const k = raw.kickoff ?? LEAGUE_DEFAULTS.kickoff;
  const out: LeagueConfig = {
    enabled: raw.enabled !== false,
    /* A room of one is not a match, and the bracket would never narrow. */
    roomSize: Math.max(2, Math.min(100, Math.round(Number(raw.roomSize)) || LEAGUE_DEFAULTS.roomSize)),
    tiers,
    kickoff: {
      dayOfWeek: Math.max(0, Math.min(6, Math.round(Number(k.dayOfWeek ?? 6)))),
      hour: Math.max(0, Math.min(23, Math.round(Number(k.hour ?? 21)))),
      minute: Math.max(0, Math.min(59, Math.round(Number(k.minute ?? 0)))),
      tzOffsetMinutes: Math.max(-720, Math.min(840, Math.round(Number(k.tzOffsetMinutes ?? 210))))
    },
    roundGapMinutes: Math.max(1, Math.min(1440, Math.round(Number(raw.roundGapMinutes)) || LEAGUE_DEFAULTS.roundGapMinutes))
  };
  _ticketTierCache = new Set(out.tiers.map((t) => t.key));
  return out;
}

export async function setLeagueConfig(patch: Partial<LeagueConfig>): Promise<LeagueConfig> {
  const cur = await getLeagueConfig();
  const next: LeagueConfig = {
    enabled: patch.enabled != null ? !!patch.enabled : cur.enabled,
    roomSize: patch.roomSize != null ? Math.max(2, Math.min(100, Math.round(Number(patch.roomSize)) || cur.roomSize)) : cur.roomSize,
    tiers: Array.isArray(patch.tiers) && patch.tiers.length
      ? patch.tiers.map((t, i) => cleanTier(t, cur.tiers[Math.min(i, cur.tiers.length - 1)] ?? LEAGUE_DEFAULTS.tiers[0]!))
      : cur.tiers,
    kickoff: patch.kickoff ? { ...cur.kickoff, ...patch.kickoff } : cur.kickoff,
    roundGapMinutes: patch.roundGapMinutes != null ? Number(patch.roundGapMinutes) : cur.roundGapMinutes
  };
  memCfg = next;
  const pool = pg();
  if (pool) {
    try {
      await pool.query(`INSERT INTO app_config(key,value,updated_at) VALUES ($1,$2,now())
                        ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`, [CFG_KEY, JSON.stringify(next)]);
    } catch (e) { logger.warn('league_config_write_failed', { message: (e as Error).message }); }
  }
  return getLeagueConfig();
}

/** Test seam. */
export function _resetLeague(): void {
  memCfg = null; memQual.length = 0; memRooms.length = 0; memSeats.length = 0; _ready = false;
}

/* ── the cut lines ─────────────────────────────────────────────────────── */

export interface CutLine {
  key: string;
  label: string;
  emoji: string;
  /** The rank a player must reach to be inside this tier — its LAST place. */
  rank: number;
  /** The cup the player currently holding that rank has. */
  cup: number;
  /** False when the board is not that long yet and `cup` is the last place's. */
  exact: boolean;
}

/* Exported so a test can run the REAL string against a real Postgres.
 * It was `id NOT LIKE` — and `users.id` is a uuid column, which Postgres has no
 * NOT LIKE operator for. Every call threw «operator does not exist: uuid !~~
 * unknown», the board silently fell through to the in-memory path, and a warn
 * line was the only trace. A source-level check would not have caught it; only
 * running the SQL does. */
export const WEEKLY_BOARD_SQL =
  `SELECT id AS user_id, weekly_score AS cup FROM users
    WHERE weekly_week = $1 AND weekly_score > 0 AND id::text NOT LIKE 'bot\\_%'
    ORDER BY weekly_score DESC, id LIMIT $2`;

/** The weekly board as (userId, cup), best first. */
async function weeklyBoard(limit = 500): Promise<Array<{ userId: string; cup: number }>> {
  const pool = pg();
  if (pool) {
    try {
      const { rows } = await pool.query(WEEKLY_BOARD_SQL, [isoWeekId(), limit]);
      return rows.map((r: any) => ({ userId: String(r.user_id), cup: Number(r.cup) || 0 }));
    } catch (e) { logger.warn('league_board_failed', { message: (e as Error).message }); }
  }
  const users = await repositories.users.list(1000);
  return users
    .filter((u) => !u.id.startsWith('bot_'))
    .map((u) => ({ userId: u.id, cup: effectiveWeeklyScore(u) }))
    .filter((r) => r.cup > 0)
    .sort((a, b) => b.cup - a.cup || a.userId.localeCompare(b.userId))
    .slice(0, limit);
}

/**
 * What each tier's badge should say: the cup held by the player at that tier's
 * last qualifying place. That is the number a player has to beat to get in, and
 * it is the whole point of showing it — a fixed threshold told them nothing
 * about whether they were actually going to make it.
 *
 * When the board is shorter than the rank, the last player's cup is shown and
 * `exact` is false, so the screen can say so rather than pretending.
 */
export async function cutLines(): Promise<CutLine[]> {
  const cfg = await getLeagueConfig();
  const board = await weeklyBoard(Math.max(...cfg.tiers.map((t) => t.toRank), 50));
  return cfg.tiers.map((t) => {
    const wanted = t.toRank;
    const idx = Math.min(wanted, board.length) - 1;
    const row = idx >= 0 ? board[idx] : undefined;
    return {
      key: t.key, label: t.label, emoji: t.emoji,
      rank: wanted,
      cup: row ? row.cup : 0,
      exact: board.length >= wanted
    };
  });
}

/* ── storage ───────────────────────────────────────────────────────────── */

export type RoomStatus = 'scheduled' | 'playing' | 'finished';
export type SeatStatus = 'invited' | 'played' | 'absent' | 'won';

export interface Qualifier {
  seasonId: string;
  userId: string;
  rank: number;
  cup: number;
  tier: string;
}
export interface LeagueRoom {
  id: string;
  seasonId: string;
  tier: string;
  round: number;
  roomNo: number;
  status: RoomStatus;
  startsAt: number;
  winnerUserId: string | null;
}
export interface Seat {
  roomId: string;
  userId: string;
  status: SeatStatus;
  /** Whether the participation prize has been paid for this seat. */
  paid: boolean;
}

const memQual: Qualifier[] = [];
const memRooms: LeagueRoom[] = [];
const memSeats: Seat[] = [];

let _ready = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<boolean> {
  if (_ready) return true;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS league_qualifiers (
      season_id TEXT NOT NULL, user_id TEXT NOT NULL,
      rank INT NOT NULL, cup INT NOT NULL, tier TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (season_id, user_id))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS league_rooms (
      id TEXT PRIMARY KEY, season_id TEXT NOT NULL, tier TEXT NOT NULL,
      round INT NOT NULL, room_no INT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled',
      starts_at BIGINT NOT NULL, winner_user_id TEXT)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_league_rooms_season ON league_rooms(season_id, tier, round)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS league_seats (
      room_id TEXT NOT NULL, user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'invited', paid BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (room_id, user_id))`);
    _ready = true;
    return true;
  } catch (e) {
    logger.warn('league_schema_failed', { message: (e as Error).message });
    return false;
  }
}

/* ── the season ────────────────────────────────────────────────────────── */

/** The season a set of standings belongs to: the ISO week they were earned in. */
export function currentSeasonId(): string { return isoWeekId(); }

/** How long before kickoff a room can be entered. Kept here so the screen and
 *  the worker cannot disagree about when the doors open. */
export const LEAGUE_DOORS_MINUTES = 10;

/**
 * Kickoff for a season: the configured weekday and time, in the operator's
 * clock, on or after the moment the week closed.
 */
export function kickoffFor(cfg: LeagueConfig, from = new Date()): number {
  const off = cfg.kickoff.tzOffsetMinutes * 60_000;
  /* Work in the operator's local clock, then convert back. */
  const local = new Date(from.getTime() + off);
  /* JS: 0=Sunday. The operator's week starts on شنبه, so 0=Saturday there. */
  const localDow = (local.getUTCDay() + 1) % 7;
  let deltaDays = (cfg.kickoff.dayOfWeek - localDow + 7) % 7;
  const at = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + deltaDays,
    cfg.kickoff.hour, cfg.kickoff.minute, 0, 0);
  let utc = at - off;
  /* Already past today's time → next week. */
  if (utc <= from.getTime()) {
    deltaDays += 7;
    utc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + deltaDays,
      cfg.kickoff.hour, cfg.kickoff.minute, 0, 0) - off;
  }
  return utc;
}

/* ── qualifying ────────────────────────────────────────────────────────── */

export interface CloseResult {
  seasonId: string;
  qualifiers: Qualifier[];
  ticketsGranted: number;
  kickoffAt: number;
}

/**
 * Freeze the week's standings, record who qualified, and give each of them the
 * one ticket that lets them in. Running it twice for the same season must not
 * hand out a second ticket — an operator pressing the button again, or a cron
 * that fires twice, is not a reason to double the prize pool.
 */
export async function closeSeason(seasonId = currentSeasonId()): Promise<CloseResult> {
  const cfg = await getLeagueConfig();
  if (!cfg.enabled) throw new LeagueError('LEAGUE_OFF', 'لیگ هفتگی خاموش است.');

  const existing = await listQualifiers(seasonId);
  if (existing.length) {
    return { seasonId, qualifiers: existing, ticketsGranted: 0, kickoffAt: kickoffFor(cfg) };
  }

  const maxRank = Math.max(...cfg.tiers.map((t) => t.toRank));
  const board = await weeklyBoard(maxRank);
  const quals: Qualifier[] = [];
  board.forEach((row, i) => {
    const rank = i + 1;
    const tier = cfg.tiers.find((t) => rank >= t.fromRank && rank <= t.toRank);
    if (!tier) return;
    quals.push({ seasonId, userId: row.userId, rank, cup: row.cup, tier: tier.key });
  });

  await saveQualifiers(quals);

  /* The ticket is granted AFTER the row is stored, so a crash between the two
   * leaves a player without a ticket rather than with one nobody recorded —
   * and the operator can re-run against the stored rows. */
  let granted = 0;
  for (const q of quals) {
    try { await grantTickets(q.userId, q.tier, 1); granted++; }
    catch (e) { logger.warn('league_ticket_failed', { userId: q.userId, message: (e as Error).message }); }
  }
  logger.info('league_season_closed', { seasonId, qualifiers: quals.length, granted });
  return { seasonId, qualifiers: quals, ticketsGranted: granted, kickoffAt: kickoffFor(cfg) };
}

async function saveQualifiers(quals: Qualifier[]): Promise<void> {
  const pool = pg();
  if (pool && await ensureSchema(pool)) {
    for (const q of quals) {
      await pool.query(
        `INSERT INTO league_qualifiers(season_id,user_id,rank,cup,tier) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (season_id,user_id) DO NOTHING`,
        [q.seasonId, q.userId, q.rank, q.cup, q.tier]);
    }
    return;
  }
  for (const q of quals) {
    if (!memQual.some((x) => x.seasonId === q.seasonId && x.userId === q.userId)) memQual.push(q);
  }
}

export async function listQualifiers(seasonId: string, tier?: string): Promise<Qualifier[]> {
  const pool = pg();
  if (pool && await ensureSchema(pool)) {
    try {
      const { rows } = tier
        ? await pool.query(`SELECT * FROM league_qualifiers WHERE season_id=$1 AND tier=$2 ORDER BY rank`, [seasonId, tier])
        : await pool.query(`SELECT * FROM league_qualifiers WHERE season_id=$1 ORDER BY rank`, [seasonId]);
      return rows.map((r: any) => ({ seasonId: String(r.season_id), userId: String(r.user_id), rank: Number(r.rank), cup: Number(r.cup), tier: String(r.tier) }));
    } catch (e) { logger.warn('league_qualifiers_read_failed', { message: (e as Error).message }); }
  }
  return memQual.filter((q) => q.seasonId === seasonId && (!tier || q.tier === tier)).sort((a, b) => a.rank - b.rank);
}

/* ── the draw ──────────────────────────────────────────────────────────── */

/**
 * How a tier's players are split into rooms.
 *
 * The last room must never be left with one player — a room of one is not a
 * match and its "winner" would advance without playing. When the remainder is a
 * single person, the rooms are levelled instead: 16 players into rooms of 15
 * become 8 and 8, not 15 and 1.
 */
export function splitRooms(count: number, roomSize: number): number[] {
  const size = Math.max(2, Math.floor(roomSize));
  if (count <= 0) return [];
  if (count <= size) return [count];
  const rooms = Math.ceil(count / size);
  const base = Math.floor(count / rooms);
  const extra = count % rooms;
  return Array.from({ length: rooms }, (_, i) => base + (i < extra ? 1 : 0));
}

function shuffle<T>(a: T[]): T[] {
  const out = a.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = randomInt(i + 1); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
}

let _roomSeq = 0;
function roomId(seasonId: string, tier: string, round: number, no: number): string {
  return `${seasonId}:${tier}:r${round}:${no}:${Date.now().toString(36)}${(_roomSeq++).toString(36)}`;
}

/** Build the first round of rooms for every tier that has qualifiers. */
export async function drawRound(seasonId: string, round = 1): Promise<LeagueRoom[]> {
  const cfg = await getLeagueConfig();
  const made: LeagueRoom[] = [];
  for (const tier of cfg.tiers) {
    const players = round === 1
      ? (await listQualifiers(seasonId, tier.key)).map((q) => q.userId)
      : (await listRooms(seasonId, tier.key, round - 1)).map((r) => r.winnerUserId).filter((x): x is string => !!x);
    if (players.length < 2) continue;                 // nothing to play

    const existing = await listRooms(seasonId, tier.key, round);
    if (existing.length) { made.push(...existing); continue; }

    const startsAt = round === 1
      ? kickoffFor(cfg)
      : kickoffFor(cfg) + (round - 1) * cfg.roundGapMinutes * 60_000;
    const sizes = splitRooms(players.length, cfg.roomSize);
    const order = shuffle(players);
    let at = 0;
    for (let i = 0; i < sizes.length; i++) {
      const seatCount = sizes[i]!;
      const room: LeagueRoom = {
        id: roomId(seasonId, tier.key, round, i + 1),
        seasonId, tier: tier.key, round, roomNo: i + 1,
        status: 'scheduled', startsAt, winnerUserId: null
      };
      await saveRoom(room);
      for (const uid of order.slice(at, at + seatCount)) await saveSeat({ roomId: room.id, userId: uid, status: 'invited', paid: false });
      at += seatCount;
      made.push(room);
    }
  }
  return made;
}

async function saveRoom(room: LeagueRoom): Promise<void> {
  const pool = pg();
  if (pool && await ensureSchema(pool)) {
    await pool.query(
      `INSERT INTO league_rooms(id,season_id,tier,round,room_no,status,starts_at,winner_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET status=$6, winner_user_id=$8`,
      [room.id, room.seasonId, room.tier, room.round, room.roomNo, room.status, room.startsAt, room.winnerUserId]);
    return;
  }
  const i = memRooms.findIndex((r) => r.id === room.id);
  if (i >= 0) memRooms[i] = room; else memRooms.push(room);
}

async function saveSeat(seat: Seat): Promise<void> {
  const pool = pg();
  if (pool && await ensureSchema(pool)) {
    await pool.query(
      `INSERT INTO league_seats(room_id,user_id,status,paid) VALUES ($1,$2,$3,$4)
       ON CONFLICT (room_id,user_id) DO UPDATE SET status=$3, paid=$4`,
      [seat.roomId, seat.userId, seat.status, seat.paid]);
    return;
  }
  const i = memSeats.findIndex((s) => s.roomId === seat.roomId && s.userId === seat.userId);
  if (i >= 0) memSeats[i] = seat; else memSeats.push(seat);
}

export async function listRooms(seasonId: string, tier?: string, round?: number): Promise<LeagueRoom[]> {
  const pool = pg();
  if (pool && await ensureSchema(pool)) {
    try {
      const where = ['season_id=$1']; const args: any[] = [seasonId];
      if (tier) { args.push(tier); where.push('tier=$' + args.length); }
      if (round != null) { args.push(round); where.push('round=$' + args.length); }
      const { rows } = await pool.query(`SELECT * FROM league_rooms WHERE ${where.join(' AND ')} ORDER BY round, room_no`, args);
      return rows.map((r: any) => ({
        id: String(r.id), seasonId: String(r.season_id), tier: String(r.tier), round: Number(r.round),
        roomNo: Number(r.room_no), status: String(r.status) as RoomStatus, startsAt: Number(r.starts_at),
        winnerUserId: r.winner_user_id ? String(r.winner_user_id) : null
      }));
    } catch (e) { logger.warn('league_rooms_read_failed', { message: (e as Error).message }); }
  }
  return memRooms
    .filter((r) => r.seasonId === seasonId && (!tier || r.tier === tier) && (round == null || r.round === round))
    .sort((a, b) => a.round - b.round || a.roomNo - b.roomNo);
}

export async function listSeats(roomId: string): Promise<Seat[]> {
  const pool = pg();
  if (pool && await ensureSchema(pool)) {
    try {
      const { rows } = await pool.query(`SELECT * FROM league_seats WHERE room_id=$1`, [roomId]);
      return rows.map((r: any) => ({ roomId: String(r.room_id), userId: String(r.user_id), status: String(r.status) as SeatStatus, paid: !!r.paid }));
    } catch (e) { logger.warn('league_seats_read_failed', { message: (e as Error).message }); }
  }
  return memSeats.filter((s) => s.roomId === roomId);
}

/* ── the result, and the money ─────────────────────────────────────────── */

export interface RoomResult {
  roomId: string;
  /** Who actually played — everyone else in the room was absent. */
  played: string[];
  winnerUserId: string | null;
}
export interface PayoutLine { userId: string; kind: 'participation' | 'winner'; amount: number; type: string }

/**
 * The match is over. Everyone who PLAYED is paid the participation prize —
 * winning or losing does not change it — and the winner is paid the winner's
 * prize on top.
 *
 * "Played" is the guard against the obvious abuse: the participation prize is
 * real money and the room is scheduled for you whether you show up or not, so
 * paying for a seat rather than for playing would be an income for an account
 * that opens the app and puts it down. The caller reports who took part; a seat
 * that never did is marked absent and paid nothing.
 *
 * Paying twice for one room is the other way this loses money, so a seat that
 * has already been paid is skipped no matter how often this is called.
 */
export async function reportRoomResult(input: RoomResult): Promise<{ room: LeagueRoom; payouts: PayoutLine[] }> {
  const room = await findRoom(input.roomId);
  if (!room) throw new LeagueError('ROOM_NOT_FOUND', 'این اتاق لیگ پیدا نشد.');
  const cfg = await getLeagueConfig();
  const tier = cfg.tiers.find((t) => t.key === room.tier);
  if (!tier) throw new LeagueError('TIER_NOT_FOUND', 'این لیگ دیگر تعریف نشده است.');

  const seats = await listSeats(room.id);
  const playedSet = new Set(input.played.map(String));
  const winner = input.winnerUserId && playedSet.has(String(input.winnerUserId)) ? String(input.winnerUserId) : null;
  const payouts: PayoutLine[] = [];

  for (const seat of seats) {
    const played = playedSet.has(seat.userId);
    const status: SeatStatus = !played ? 'absent' : (seat.userId === winner ? 'won' : 'played');
    if (played && !seat.paid) {
      if (tier.participationPrize > 0) {
        await grantReward(seat.userId, { type: tier.prizeType, amount: tier.participationPrize, label: 'حضور در ' + tier.label, icon: '🎟️' } as any,
          `league:part:${room.id}:${seat.userId}`);
        payouts.push({ userId: seat.userId, kind: 'participation', amount: tier.participationPrize, type: tier.prizeType });
      }
      if (seat.userId === winner && tier.winnerPrize > 0) {
        await grantReward(seat.userId, { type: tier.prizeType, amount: tier.winnerPrize, label: 'قهرمانی ' + tier.label, icon: '🏆' } as any,
          `league:win:${room.id}:${seat.userId}`);
        payouts.push({ userId: seat.userId, kind: 'winner', amount: tier.winnerPrize, type: tier.prizeType });
      }
    }
    await saveSeat({ ...seat, status, paid: seat.paid || played });
  }

  room.status = 'finished';
  room.winnerUserId = winner;
  await saveRoom(room);
  logger.info('league_room_finished', { roomId: room.id, tier: room.tier, round: room.round, played: input.played.length, winner });
  return { room, payouts };
}

async function findRoom(id: string): Promise<LeagueRoom | null> {
  const pool = pg();
  if (pool && await ensureSchema(pool)) {
    try {
      const { rows } = await pool.query(`SELECT * FROM league_rooms WHERE id=$1`, [id]);
      const r = rows[0];
      if (!r) return null;
      return {
        id: String(r.id), seasonId: String(r.season_id), tier: String(r.tier), round: Number(r.round),
        roomNo: Number(r.room_no), status: String(r.status) as RoomStatus, startsAt: Number(r.starts_at),
        winnerUserId: r.winner_user_id ? String(r.winner_user_id) : null
      };
    } catch (e) { logger.warn('league_room_read_failed', { message: (e as Error).message }); }
  }
  return memRooms.find((r) => r.id === id) ?? null;
}

/* ── what a player sees ────────────────────────────────────────────────── */

export interface MyLeague {
  enabled: boolean;
  seasonId: string;
  rank: number | null;
  cup: number;
  /** Every tier, with the real bands and the real prizes — so the screen can
   *  say what is on offer instead of repeating numbers typed into the markup. */
  tiers: LeagueTier[];
  roomSize: number;
  /** When the doors open, and when the first question is asked. */
  doorsOpenAt: number;
  /** The tier they are currently inside, by live rank. */
  tier: LeagueTier | null;
  /** The tier they hold a ticket for, once the season has closed. */
  qualifiedTier: string | null;
  tickets: Record<string, number>;
  cutLines: CutLine[];
  kickoffAt: number;
  room: { id: string; tier: string; round: number; roomNo: number; startsAt: number; seats: number } | null;
}

export async function myLeague(userId: string): Promise<MyLeague> {
  const cfg = await getLeagueConfig();
  const seasonId = currentSeasonId();
  const board = await weeklyBoard(Math.max(...cfg.tiers.map((t) => t.toRank), 200));
  const idx = board.findIndex((r) => r.userId === userId);
  const rank = idx >= 0 ? idx + 1 : null;
  const cup = idx >= 0 ? board[idx]!.cup : 0;
  const tier = rank ? cfg.tiers.find((t) => rank >= t.fromRank && rank <= t.toRank) ?? null : null;

  const quals = await listQualifiers(seasonId);
  const mine = quals.find((q) => q.userId === userId) ?? null;

  let room: MyLeague['room'] = null;
  for (const r of await listRooms(seasonId)) {
    if (r.status === 'finished') continue;
    const seats = await listSeats(r.id);
    if (seats.some((s) => s.userId === userId)) {
      room = { id: r.id, tier: r.tier, round: r.round, roomNo: r.roomNo, startsAt: r.startsAt, seats: seats.length };
      break;
    }
  }

  const user = await repositories.users.findById(userId);
  return {
    enabled: cfg.enabled,
    seasonId,
    tiers: cfg.tiers,
    roomSize: cfg.roomSize,
    doorsOpenAt: kickoffFor(cfg) - LEAGUE_DOORS_MINUTES * 60_000,
    rank, cup, tier,
    qualifiedTier: mine ? mine.tier : null,
    tickets: (user?.tickets as any) ?? {},
    cutLines: await cutLines(),
    kickoffAt: kickoffFor(cfg),
    room
  };
}

/* ── the tickets that are not for sale ─────────────────────────────────── */

/* A league ticket is the whole reward for a week of play. If it could also be
 * bought, the ladder would be a price list — so selling one is refused in code
 * rather than merely left out of the shop catalogue, which an operator can edit.
 *
 * The purchase paths are synchronous and hot, so the keys are cached here and
 * refreshed whenever the config is read or written. The default keys are in
 * place from the first moment, so the guard is never briefly open at boot. */
let _ticketTierCache = new Set(LEAGUE_DEFAULTS.tiers.map((t) => t.key));
export function isLeagueTicketTier(tier: string): boolean {
  return _ticketTierCache.has(String(tier || '').trim());
}
export async function leagueTicketTiers(): Promise<string[]> {
  const cfg = await getLeagueConfig();
  return cfg.tiers.map((t) => t.key);
}
