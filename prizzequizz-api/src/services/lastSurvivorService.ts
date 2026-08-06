/* LAST SURVIVOR — room + player state store and money integration.
 *
 * Server-authoritative. The live state lives in Postgres (so a server restart
 * or a player's dropped connection recovers cleanly) with a full in-memory
 * fallback for local/dev/test. Only ONE question is active per room at a time,
 * so the current round's data (question, secret correctIndex, phase, deadline)
 * lives on the room row and each player's answer/decision for the current round
 * lives on the player row — which keeps the orchestrator simple and atomic.
 *
 * Money: joining consumes ONE real ticket of the chosen colour and adds that
 * colour's configured VALUE to the room pot. Cash-outs and the final split pay
 * real toman through the wallet ledger (idempotent per room+user+round). */
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';
import { consumeTicket, refundTicket } from './ticketService.js';
import { postEntry } from './walletLedgerService.js';
import { logger } from './logger.js';
import { getConfig, isTopicPlayable, type LastSurvivorConfig } from './lastSurvivorConfig.js';
import { ticketValue, ticketUnits, buildPool, computeStats, cashoutShareFor, finalSplit, type PrizePlayer, ticketShields} from './lastSurvivorPrize.js';

export type RoomStatus = 'waiting' | 'running' | 'finished';
export type RoomPhase = 'waiting' | 'ready' | 'question' | 'elimination' | 'dashboard' | 'cashout' | 'finished';
export type PlayerStatus = 'waiting' | 'alive' | 'eliminated' | 'cashed_out';

export interface RoomRow {
  id: string;
  topic: string;
  status: RoomStatus;
  phase: RoomPhase;
  config: LastSurvivorConfig;   // snapshot taken at creation — admin edits never disturb a live room
  capacity: number;
  minUsers: number;
  waitSeconds: number;
  manualStartEnabled: boolean;
  startPct: number;
  totalRounds: number;
  round: number;                // current round number (1-based once running)
  grossPool: number;            // sum of ticket values that entered (net = gross - rake)
  rakePercent: number;
  questionId: string | null;
  correctIndex: number | null;  // SECRET — never sent to clients until they're eliminated
  phaseEndsAt: number | null;   // epoch ms deadline for the current phase
  createdAt: number;
  startsAt: number;             // waiting-room deadline
  startedAt: number | null;
  endedAt: number | null;
}

export interface PlayerRow {
  roomId: string;
  userId: string;
  username: string;
  avatar: string | null;
  color: string;
  units: number;
  status: PlayerStatus;
  answerRound: number;          // last round this player answered
  answerIndex: number | null;
  answerCorrect: boolean | null;
  decisionRound: number;        // last round this player made a cashout/continue decision
  decision: 'cashout' | 'continue' | null;
  eliminatedRound: number | null;
  cashedOutRound: number | null;
  payoutCash: number;
  /* Extra lives left. Set from the ticket colour at join; a wrong answer spends
   * one before elimination is even considered. */
  shields: number;
  /* The round a shield was last spent, 0 for never. A player saved by a shield
   * stays 'alive', so nothing else on this row says they got the question
   * wrong — and without that the result screen congratulates them. */
  shieldRound: number;
  joinedAt: number;
  lastSeenAt: number;
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ls_rooms (
    id TEXT PRIMARY KEY, topic TEXT NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL,
    config JSONB NOT NULL, capacity INT NOT NULL, min_users INT NOT NULL, wait_seconds INT NOT NULL,
    manual_start_enabled BOOLEAN NOT NULL, start_pct INT NOT NULL, total_rounds INT NOT NULL,
    round INT NOT NULL DEFAULT 0, gross_pool BIGINT NOT NULL DEFAULT 0, rake_percent INT NOT NULL DEFAULT 0,
    question_id TEXT, correct_index INT, phase_ends_at BIGINT,
    created_at BIGINT NOT NULL, starts_at BIGINT NOT NULL, started_at BIGINT, ended_at BIGINT)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ls_rooms_status ON ls_rooms(status, topic)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ls_room_players (
    room_id TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT NOT NULL, avatar TEXT,
    color TEXT NOT NULL, units INT NOT NULL, status TEXT NOT NULL,
    answer_round INT NOT NULL DEFAULT 0, answer_index INT, answer_correct BOOLEAN,
    decision_round INT NOT NULL DEFAULT 0, decision TEXT,
    eliminated_round INT, cashed_out_round INT, payout_cash BIGINT NOT NULL DEFAULT 0,
    shields INT NOT NULL DEFAULT 0, shield_round INT NOT NULL DEFAULT 0,
    joined_at BIGINT NOT NULL, last_seen_at BIGINT NOT NULL,
    PRIMARY KEY (room_id, user_id))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ls_votes (room_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(room_id,user_id))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ls_chat (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT NOT NULL, body TEXT NOT NULL, created_at BIGINT NOT NULL)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ls_chat_room ON ls_chat(room_id, created_at)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ls_answers (room_id TEXT NOT NULL, round INT NOT NULL, user_id TEXT NOT NULL, selected_index INT NOT NULL, correct BOOLEAN NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(room_id,round,user_id))`);
  /* The table above already exists on every live server, so CREATE ... IF NOT
   * EXISTS will not add a new column to it. Rooms already in flight keep 0,
   * which is exactly the old behaviour: one wrong answer, out. */
  await pool.query(`ALTER TABLE ls_room_players ADD COLUMN IF NOT EXISTS shields INT NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE ls_room_players ADD COLUMN IF NOT EXISTS shield_round INT NOT NULL DEFAULT 0`);
  _schemaReady = true;
}

// ---------------- in-memory fallback ----------------
const memRooms = new Map<string, RoomRow>();
const memPlayers = new Map<string, PlayerRow>();       // key `${roomId}:${userId}`
const memVotes = new Set<string>();                    // `${roomId}:${userId}`
const memChat: Array<{ id: string; roomId: string; userId: string; username: string; body: string; createdAt: number }> = [];
const pkey = (roomId: string, userId: string) => `${roomId}:${userId}`;

function roomToRow(r: any): RoomRow {
  return {
    id: r.id, topic: r.topic, status: r.status, phase: r.phase, config: r.config,
    capacity: Number(r.capacity), minUsers: Number(r.min_users), waitSeconds: Number(r.wait_seconds),
    manualStartEnabled: r.manual_start_enabled !== false, startPct: Number(r.start_pct), totalRounds: Number(r.total_rounds),
    round: Number(r.round), grossPool: Number(r.gross_pool), rakePercent: Number(r.rake_percent),
    questionId: r.question_id ?? null, correctIndex: r.correct_index != null ? Number(r.correct_index) : null,
    phaseEndsAt: r.phase_ends_at != null ? Number(r.phase_ends_at) : null,
    createdAt: Number(r.created_at), startsAt: Number(r.starts_at),
    startedAt: r.started_at != null ? Number(r.started_at) : null, endedAt: r.ended_at != null ? Number(r.ended_at) : null
  };
}
function playerToRow(r: any): PlayerRow {
  return {
    roomId: r.room_id, userId: r.user_id, username: r.username, avatar: r.avatar ?? null,
    color: r.color, units: Number(r.units), status: r.status,
    answerRound: Number(r.answer_round), answerIndex: r.answer_index != null ? Number(r.answer_index) : null,
    answerCorrect: r.answer_correct == null ? null : !!r.answer_correct,
    decisionRound: Number(r.decision_round), decision: r.decision ?? null,
    eliminatedRound: r.eliminated_round != null ? Number(r.eliminated_round) : null,
    cashedOutRound: r.cashed_out_round != null ? Number(r.cashed_out_round) : null,
    payoutCash: Number(r.payout_cash), shields: Number(r.shields ?? 0), shieldRound: Number(r.shield_round ?? 0),
    joinedAt: Number(r.joined_at), lastSeenAt: Number(r.last_seen_at)
  };
}

// ---------------- room CRUD ----------------
export async function saveRoom(room: RoomRow): Promise<void> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO ls_rooms(id,topic,status,phase,config,capacity,min_users,wait_seconds,manual_start_enabled,start_pct,total_rounds,round,gross_pool,rake_percent,question_id,correct_index,phase_ends_at,created_at,starts_at,started_at,ended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (id) DO UPDATE SET status=$3,phase=$4,round=$12,gross_pool=$13,question_id=$15,correct_index=$16,phase_ends_at=$17,started_at=$20,ended_at=$21`,
      [room.id, room.topic, room.status, room.phase, JSON.stringify(room.config), room.capacity, room.minUsers, room.waitSeconds, room.manualStartEnabled, room.startPct, room.totalRounds, room.round, room.grossPool, room.rakePercent, room.questionId, room.correctIndex, room.phaseEndsAt, room.createdAt, room.startsAt, room.startedAt, room.endedAt]);
  } else {
    memRooms.set(room.id, { ...room });
  }
}

export async function getRoom(roomId: string): Promise<RoomRow | null> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); const { rows } = await pool.query(`SELECT * FROM ls_rooms WHERE id=$1`, [roomId]); return rows[0] ? roomToRow(rows[0]) : null; }
  return memRooms.get(roomId) ?? null;
}

export async function listActiveRooms(): Promise<RoomRow[]> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); const { rows } = await pool.query(`SELECT * FROM ls_rooms WHERE status IN ('waiting','running') ORDER BY created_at`); return rows.map(roomToRow); }
  return [...memRooms.values()].filter((r) => r.status !== 'finished');
}

export async function listAllRooms(limit = 100): Promise<RoomRow[]> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); const { rows } = await pool.query(`SELECT * FROM ls_rooms ORDER BY created_at DESC LIMIT $1`, [limit]); return rows.map(roomToRow); }
  return [...memRooms.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

// ---------------- player CRUD ----------------
export async function listPlayers(roomId: string): Promise<PlayerRow[]> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); const { rows } = await pool.query(`SELECT * FROM ls_room_players WHERE room_id=$1 ORDER BY joined_at`, [roomId]); return rows.map(playerToRow); }
  return [...memPlayers.values()].filter((p) => p.roomId === roomId).sort((a, b) => a.joinedAt - b.joinedAt);
}

export async function getPlayer(roomId: string, userId: string): Promise<PlayerRow | null> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); const { rows } = await pool.query(`SELECT * FROM ls_room_players WHERE room_id=$1 AND user_id=$2`, [roomId, userId]); return rows[0] ? playerToRow(rows[0]) : null; }
  return memPlayers.get(pkey(roomId, userId)) ?? null;
}

export async function savePlayer(p: PlayerRow): Promise<void> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO ls_room_players(room_id,user_id,username,avatar,color,units,status,answer_round,answer_index,answer_correct,decision_round,decision,eliminated_round,cashed_out_round,payout_cash,joined_at,last_seen_at,shields,shield_round)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (room_id,user_id) DO UPDATE SET status=$7,answer_round=$8,answer_index=$9,answer_correct=$10,decision_round=$11,decision=$12,eliminated_round=$13,cashed_out_round=$14,payout_cash=$15,last_seen_at=$17,shields=$18,shield_round=$19`,
      [p.roomId, p.userId, p.username, p.avatar, p.color, p.units, p.status, p.answerRound, p.answerIndex, p.answerCorrect, p.decisionRound, p.decision, p.eliminatedRound, p.cashedOutRound, p.payoutCash, p.joinedAt, p.lastSeenAt, p.shields ?? 0, p.shieldRound ?? 0]);
  } else {
    memPlayers.set(pkey(p.roomId, p.userId), { ...p });
  }
}

// ---------------- votes / chat ----------------
export async function addVote(roomId: string, userId: string): Promise<number> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); await pool.query(`INSERT INTO ls_votes(room_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [roomId, userId]); const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ls_votes WHERE room_id=$1`, [roomId]); return Number(rows[0].n); }
  memVotes.add(pkey(roomId, userId));
  return [...memVotes].filter((k) => k.startsWith(roomId + ':')).length;
}
export async function countVotes(roomId: string): Promise<number> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ls_votes WHERE room_id=$1`, [roomId]); return Number(rows[0].n); }
  return [...memVotes].filter((k) => k.startsWith(roomId + ':')).length;
}

export async function addChat(roomId: string, userId: string, username: string, body: string): Promise<void> {
  const clean = String(body).slice(0, 240).trim();
  if (!clean) return;
  const pool = pg();
  if (pool) { await ensureSchema(pool); await pool.query(`INSERT INTO ls_chat(id,room_id,user_id,username,body,created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [id(), roomId, userId, username, clean, Date.now()]); }
  else memChat.push({ id: id(), roomId, userId, username, body: clean, createdAt: Date.now() });
}
export async function listChat(roomId: string, limit = 60): Promise<Array<{ userId: string; username: string; body: string; createdAt: number }>> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); const { rows } = await pool.query(`SELECT user_id,username,body,created_at FROM ls_chat WHERE room_id=$1 ORDER BY created_at DESC LIMIT $2`, [roomId, limit]); return rows.map((r: any) => ({ userId: r.user_id, username: r.username, body: r.body, createdAt: Number(r.created_at) })).reverse(); }
  return memChat.filter((c) => c.roomId === roomId).slice(-limit).map((c) => ({ userId: c.userId, username: c.username, body: c.body, createdAt: c.createdAt }));
}

export async function recordAnswerAudit(roomId: string, round: number, userId: string, index: number, correct: boolean): Promise<void> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); await pool.query(`INSERT INTO ls_answers(room_id,round,user_id,selected_index,correct,created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [roomId, round, userId, index, correct, Date.now()]); }
}

// ---------------- join / matchmaking ----------------
export class LastSurvivorError extends Error { constructor(public code: string, message: string) { super(message); } }

export async function findOrCreateRoom(topic: string, cfg: LastSurvivorConfig): Promise<RoomRow> {
  // Reuse an open waiting room for this topic that still has space and hasn't
  // passed its start deadline; otherwise open a fresh one.
  const active = await listActiveRooms();
  for (const r of active) {
    if (r.topic === topic && r.status === 'waiting') {
      const count = (await listPlayers(r.id)).length;
      if (count < r.capacity) return r;
    }
  }
  const now = Date.now();
  const topicMin = cfg.topics?.[topic]?.minUsers;
  const room: RoomRow = {
    id: id(), topic, status: 'waiting', phase: 'waiting', config: cfg,
    capacity: cfg.room.capacity, minUsers: topicMin != null ? topicMin : cfg.room.minUsers, waitSeconds: cfg.room.waitSeconds,
    manualStartEnabled: cfg.room.manualStartEnabled, startPct: cfg.room.startPct, totalRounds: cfg.match.totalRounds,
    round: 0, grossPool: 0, rakePercent: cfg.economy.rakePercent, questionId: null, correctIndex: null, phaseEndsAt: null,
    createdAt: now, startsAt: now + cfg.room.waitSeconds * 1000, startedAt: null, endedAt: null
  };
  await saveRoom(room);
  return room;
}

/**
 * Join Last Survivor for a topic with a ticket colour. Consumes ONE real ticket
 * and adds its value to the room pot. Returns the room the player landed in.
 */
export async function joinTopic(user: { id: string; username: string; avatar?: string | null; character?: { id: string; name: string; image: string; kind: 'normal' | 'vip' } | null }, topic: string, color: string): Promise<{ room: RoomRow; player: PlayerRow }> {
  const cfg = await getConfig();
  if (!isTopicPlayable(cfg, topic)) throw new LastSurvivorError('TOPIC_LOCKED', 'این موضوع فعلاً فعال نیست (به‌زودی).');
  if (!cfg.economy.tickets[color]) throw new LastSurvivorError('TICKET_COLOR_INVALID', 'نوع بلیط نامعتبر است.');

  // Consume the ticket up front (atomic). If anything else fails, refund it.
  await consumeTicket(user.id, color);
  try {
    const room = await findOrCreateRoom(topic, cfg);
    const existing = await getPlayer(room.id, user.id);
    if (existing) { await refundTicket(user.id, color); return { room, player: existing }; } // already in — don't double-charge
    const now = Date.now();
    const player: PlayerRow = {
      roomId: room.id, userId: user.id, username: user.username || 'بازیکن', avatar: user.avatar ?? null,
      color, units: ticketUnits(cfg, color), shields: ticketShields(cfg, color), shieldRound: 0, status: 'waiting',
      answerRound: 0, answerIndex: null, answerCorrect: null, decisionRound: 0, decision: null,
      eliminatedRound: null, cashedOutRound: null, payoutCash: 0, joinedAt: now, lastSeenAt: now
    };
    await savePlayer(player);
    room.grossPool += ticketValue(cfg, color);
    await saveRoom(room);
    logger.info('ls_join', { roomId: room.id, userId: user.id, color, pool: room.grossPool });
    return { room, player };
  } catch (e) {
    await refundTicket(user.id, color).catch(() => undefined);
    throw e;
  }
}

// ---------------- leaving a room before it starts ----------------

export async function removePlayer(roomId: string, userId: string): Promise<void> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(`DELETE FROM ls_room_players WHERE room_id=$1 AND user_id=$2`, [roomId, userId]);
    await pool.query(`DELETE FROM ls_votes WHERE room_id=$1 AND user_id=$2`, [roomId, userId]);
  } else {
    memPlayers.delete(pkey(roomId, userId));
    memVotes.delete(pkey(roomId, userId));
  }
}

/* Leaving a room that has not started yet.
 *
 * There was no way to do this at all: closing the app left the row in place, so
 * everyone else still saw the player in the lobby. Worse, a player who is not
 * there still counted towards minUsers and the start vote — a room could begin
 * with people who had walked away — and their ticket money sat in the pot.
 *
 * So this is not a delete. Joining spends a real ticket, so leaving gives it
 * back and takes its value out of the pot, and only while the room is still
 * waiting: once the match is running the stake is committed and the way out is
 * to cash out. */
export async function leaveRoom(roomId: string, userId: string): Promise<{ left: boolean; refunded: boolean }> {
  const room = await getRoom(roomId);
  if (!room) throw new LastSurvivorError('ROOM_NOT_FOUND', 'اتاق پیدا نشد.');
  const player = await getPlayer(roomId, userId);
  if (!player) return { left: false, refunded: false };
  if (room.status !== 'waiting') {
    throw new LastSurvivorError('ROOM_STARTED', 'مسابقه شروع شده — خروج ممکن نیست، باید برداشت کنی.');
  }

  await removePlayer(roomId, userId);
  /* Give the ticket back before touching the pot: if the refund throws, the
   * player is out of the lobby with their stake still counted, which is
   * recoverable. The reverse order would lose them a ticket. */
  let refunded = false;
  try { await refundTicket(userId, player.color); refunded = true; }
  catch { logger.warn('ls_leave_refund_failed', { roomId, userId, color: player.color }); }

  room.grossPool = Math.max(0, room.grossPool - ticketValue(room.config, player.color));
  await saveRoom(room);

  logger.info('ls_leave', { roomId, userId, color: player.color, pool: room.grossPool, refunded });
  return { left: true, refunded };
}

/* A player who closed the app never says goodbye, so the lobby has to notice on
 * its own. lastSeenAt was written on every action and read by nothing; this is
 * what reads it. Only waiting rooms are swept — once the match is running a
 * silent player is an eliminated player, not a departed one. */
export async function sweepIdlePlayers(roomId: string, idleMs: number): Promise<number> {
  const room = await getRoom(roomId);
  if (!room || room.status !== 'waiting') return 0;
  const cutoff = Date.now() - idleMs;
  let gone = 0;
  for (const p of await listPlayers(roomId)) {
    if (p.lastSeenAt > cutoff) continue;
    try { await leaveRoom(roomId, p.userId); gone++; }
    catch { /* room started under us — nothing to sweep */ }
  }
  if (gone) logger.info('ls_swept_idle', { roomId, gone });
  return gone;
}

/* Called on every read of a room the player is in, so simply having the screen
 * open counts as being there. */
export async function touchPlayer(roomId: string, userId: string): Promise<void> {
  const p = await getPlayer(roomId, userId);
  if (!p) return;
  p.lastSeenAt = Date.now();
  await savePlayer(p);
}

// ---------------- payouts ----------------
export async function payout(userId: string, amount: number, roomId: string, round: number, kind: 'cashout' | 'final'): Promise<void> {
  if (amount <= 0) return;
  await postEntry({
    userId, entryType: 'match_reward', kind: 'credit', amount,
    idempotencyKey: `ls_${kind}:${roomId}:${userId}:${round}`,
    refType: 'match', refId: roomId,
    description: kind === 'cashout' ? 'برداشت از آخرین بازمانده' : 'جایزهٔ نهایی آخرین بازمانده',
    metadata: { roomId, round, kind }
  });
}

// ---------------- snapshot for clients ----------------
export function toPrizePlayers(players: PlayerRow[]): PrizePlayer[] {
  return players.map((p) => ({ userId: p.userId, color: p.color, units: p.units, status: p.status, payoutCash: p.payoutCash }));
}

export async function snapshot(roomId: string, forUserId?: string): Promise<any> {
  const room = await getRoom(roomId);
  if (!room) return null;
  const players = await listPlayers(roomId);
  const prize = toPrizePlayers(players);
  const stats = computeStats(prize, room.grossPool);
  const pool = buildPool(room.config, players.map((p) => p.color));
  const netRemaining = Math.max(0, pool.net - stats.paidOut);
  const me = forUserId ? players.find((p) => p.userId === forUserId) : undefined;
  // The room-wide, non-secret view.
  const view: any = {
    room: {
      id: room.id, topic: room.topic, status: room.status, phase: room.phase, round: room.round, totalRounds: room.totalRounds,
      capacity: room.capacity, minUsers: room.minUsers, startPct: room.startPct, manualStartEnabled: room.manualStartEnabled,
      grossPool: room.grossPool, netPool: pool.net, phaseEndsAt: room.phaseEndsAt, startsAt: room.startsAt,
      serverNow: Date.now(), chatEnabled: room.config.features.chat, animationsEnabled: room.config.features.animations,
      /* A finished room with nobody left standing: the last players all answered
       * wrongly, so there is no winner and the pot went to nobody. Carried on the
       * snapshot as well as the ls:ended push so a client that reconnected, or
       * that is polling rather than on the socket, can still explain the ending
       * instead of showing an empty podium. */
      forfeited: room.status === 'finished' && stats.alive === 0 ? netRemaining : 0
    },
    stats: { ...stats, remainingPot: netRemaining },
    players: players.map((p) => ({ userId: p.userId, username: p.username, avatar: p.avatar, color: p.color, status: p.status, shields: p.shields ?? 0, payoutCash: p.payoutCash, eliminatedRound: p.eliminatedRound, cashedOutRound: p.cashedOutRound })),
    votes: await countVotes(roomId)
  };
  // Current question WITHOUT the correct index (never leaked live). The TEXT and
  // OPTIONS must be here — a reconnecting client (or one that missed the
  // ls:question push) otherwise renders an empty question, can't answer, and
  // gets eliminated at the deadline.
  if (room.status === 'running' && (room.phase === 'question' || room.phase === 'ready') && room.questionId) {
    view.question = { id: room.questionId, round: room.round };
    try {
      const q = await repositories.questions.findById(room.questionId);
      if (q) {
        // Difficulty is available during the READY gate so the client can show
        // the same «سطح سختی» badge the duel shows before each question.
        view.question.difficulty = q.difficulty;
        view.question.text = q.text; view.question.options = q.options;
      }
    } catch { /* text is best-effort; the id/round still drive the flow */ }
  }
  if (me) {
    const myShare = me.status === 'alive' ? cashoutShareFor(toPrizePlayers(players).find((x) => x.userId === me.userId)!, prize, netRemaining) : 0;
    /* This round's mistake cost a shield instead of their place. shieldRound is
     * stamped at grading time, never while the question is open, so this can
     * only become true once the round is over — the reveal below is safe. */
    const shieldBroke = room.round > 0 && me.shieldRound === room.round;
    view.me = {
      userId: me.userId, status: me.status, color: me.color, units: me.units, payoutCash: me.payoutCash,
      answeredThisRound: me.answerRound === room.round && room.round > 0,
      decisionThisRound: me.decisionRound === room.round ? me.decision : null,
      currentShare: myShare,
      eliminatedRound: me.eliminatedRound,
      /* Shields left, and whether one just broke. Without the second flag a
       * saved player is indistinguishable from one who answered correctly. */
      shields: me.shields ?? 0,
      shieldBroke
    };
    // Private reveal: ONLY a player whose CURRENT round ended badly — knocked
    // out, or saved by a shield — may see the correct answer, and only while
    // the room still holds that round's question. No other player ever
    // receives the correct index.
    const wentOut = me.status === 'eliminated' && me.eliminatedRound === room.round;
    if ((wentOut || shieldBroke) && room.questionId && room.correctIndex != null) {
      try {
        const q = await repositories.questions.findById(room.questionId);
        /* answerIndex is the player's LAST answer, whichever round it was for.
         * A player who answered round 3 and then let round 4 time out was shown
         * their round-3 pick as "your answer" on the question that knocked them
         * out — an option they never chose for it. Only this round's answer
         * counts; not having one is the whole point of a timeout. */
        const answeredThis = me.answerRound === room.round;
        if (q) view.me.reveal = {
          questionId: q.id, text: q.text, options: q.options,
          correctIndex: room.correctIndex,
          yourIndex: answeredThis ? me.answerIndex : null,
          timedOut: !answeredThis
        };
      } catch { /* reveal is best-effort */ }
    }
  }
  return view;
}
