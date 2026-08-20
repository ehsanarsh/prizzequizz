/* «از کی بپرسم؟» — THE STUDIO, SERVER-SIDE.
 *
 * The game has always existed in the browser only: fifteen bot names, three
 * lamps each, and a coin flip deciding whether the "opponent" got it right.
 * Nothing left the phone. A league final decides real money, so the rules have
 * to live where the players cannot reach them.
 *
 * The rules, unchanged from the screen everyone already knows:
 *
 *   — everyone starts with three lives.
 *   — one player has the turn and gets a question on a timer.
 *   — answer it right and you choose WHO answers next. That is the game's name.
 *   — answer it wrong, or let the clock run out, and you lose a life; the turn
 *     passes to the next player still standing.
 *   — at zero lives you are out. The last one standing wins.
 *
 * WHAT IS AUTHORITATIVE HERE: whose turn it is, what the question is, whether
 * an answer was right, and who is out. The correct index is never sent to a
 * client while the question is open — a client that knew it could win every
 * turn, and in a league final that is money.
 *
 * Absentees: the league kicks off at a fixed time and whoever is not there is
 * out. A player who never joins is simply not seated, and a player who stops
 * answering runs out of lives on the clock like anyone else. Neither can stall
 * the room.
 *
 * The live state of a match is in memory. If the server restarts mid-match the
 * room is lost — the RESULT is what is persisted, the moment there is one, and
 * a room that never produced one can be filed by hand from the panel. That is a
 * deliberate trade: a durable turn-by-turn state machine is a great deal more
 * machinery than a five-minute match needs, and the money only moves at the end.
 */
import { withAuthor } from './questionAuthorService.js';
import { repositories } from '../repositories/index.js';
import { logger } from './logger.js';
import { randomInt } from 'node:crypto';
import { reportRoomResult, listSeats, type LeagueRoom } from './leagueService.js';
import { realtimeRooms } from '../realtime/roomRegistry.js';
import type { Question } from '../types/domain.js';

export class WtaError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'WtaError'; }
}

export const WTA_LIVES = 3;
export const WTA_ANSWER_SECONDS = 15;
export const WTA_PICK_SECONDS = 10;

export type WtaPhase = 'lobby' | 'turn' | 'picking' | 'finished';

export interface WtaPlayer {
  userId: string;
  username: string;
  lives: number;
  out: boolean;
  /** Never took their seat before kickoff. Out from the start, and paid nothing. */
  absent: boolean;
  /** Questions they answered correctly — the tie-break if a room ever needs one. */
  correct: number;
}

export interface WtaRoom {
  id: string;
  /** The league room this is playing out, when it belongs to one. */
  leagueRoomId: string | null;
  phase: WtaPhase;
  players: WtaPlayer[];
  /** Whose turn it is — a userId, or null before the first question. */
  turnUserId: string | null;
  questionId: string | null;
  correctIndex: number | null;
  /** Deadline for whatever the phase is waiting on. */
  endsAt: number;
  asked: string[];
  startedAt: number;
  endedAt: number | null;
  winnerUserId: string | null;
  /** Guards the one thing that must happen exactly once. */
  reported: boolean;
}

const rooms = new Map<string, WtaRoom>();

/** Test seam. */
export function _resetWta(): void { rooms.clear(); }
export function _room(id: string): WtaRoom | undefined { return rooms.get(id); }

function publish(roomId: string, type: string, payload: unknown): void {
  try { realtimeRooms.broadcastTopic(`wta:${roomId}`, { type, payload } as any); } catch { /* realtime is optional */ }
}

/* ── questions ─────────────────────────────────────────────────────────── */

async function pickQuestion(room: WtaRoom): Promise<Question | null> {
  const all = await repositories.questions.listApproved();
  if (!all.length) return null;
  let pool = all.filter((q) => !room.asked.includes(q.id));
  if (!pool.length) { room.asked = []; pool = all; }
  return pool[randomInt(pool.length)] ?? null;
}

/* ── opening the room ──────────────────────────────────────────────────── */

/**
 * Seat a league room. Everyone on the seat list is invited; nobody is playing
 * until they join, and at kickoff whoever has not is out.
 */
export async function openForLeagueRoom(room: LeagueRoom): Promise<WtaRoom> {
  const existing = rooms.get(room.id);
  if (existing) {
    /* SEATS TAKEN AFTER THE ROOM OPENED STILL COUNT.
     *
     * The draw seats everybody before anyone arrives, so returning the room
     * untouched was right when this was written. «شروع مسابقه لیگ» fills a
     * room one player at a time, and the first arrival is what opens it — so
     * every later arrival was seated in the league's books and missing from
     * the room itself, and their join was refused with «تو در این اتاق نیستی».
     * While the room is still in the lobby, its player list is caught up with
     * the seats. Once it has started, the door is shut and nothing is added. */
    if (existing.phase === 'lobby') {
      for (const s of await listSeats(room.id)) {
        if (existing.players.some((p) => p.userId === s.userId)) continue;
        const u = await repositories.users.findById(s.userId).catch(() => null);
        existing.players.push({ userId: s.userId, username: u?.username ?? 'بازیکن', lives: WTA_LIVES, out: false, absent: true, correct: 0 });
      }
      /* A room that filled early had its kickoff brought forward; the open
       * room has to hear about it or it would sit in the lobby until the
       * original time. */
      existing.endsAt = room.startsAt;
    }
    return existing;
  }
  const seats = await listSeats(room.id);
  const players: WtaPlayer[] = [];
  for (const s of seats) {
    const u = await repositories.users.findById(s.userId).catch(() => null);
    players.push({ userId: s.userId, username: u?.username ?? 'بازیکن', lives: WTA_LIVES, out: false, absent: true, correct: 0 });
  }
  const wta: WtaRoom = {
    id: room.id, leagueRoomId: room.id, phase: 'lobby', players,
    turnUserId: null, questionId: null, correctIndex: null,
    endsAt: room.startsAt, asked: [], startedAt: 0, endedAt: null, winnerUserId: null, reported: false
  };
  rooms.set(wta.id, wta);
  return wta;
}

/** Take your seat. Only before the room starts — after that the door is shut. */
export function join(roomId: string, userId: string): WtaRoom {
  const room = rooms.get(roomId);
  if (!room) throw new WtaError('ROOM_NOT_FOUND', 'این اتاق پیدا نشد.');
  if (room.phase !== 'lobby') throw new WtaError('ALREADY_STARTED', 'مسابقه شروع شده است.');
  const p = room.players.find((x) => x.userId === userId);
  if (!p) throw new WtaError('NOT_INVITED', 'تو در این اتاق نیستی.');
  p.absent = false;
  publish(room.id, 'wta:joined', { userId });
  return room;
}

/** Kickoff. Whoever did not take their seat is out before the first question. */
export async function start(roomId: string, now = Date.now()): Promise<WtaRoom> {
  const room = rooms.get(roomId);
  if (!room) throw new WtaError('ROOM_NOT_FOUND', 'این اتاق پیدا نشد.');
  if (room.phase !== 'lobby') return room;

  for (const p of room.players) if (p.absent) { p.out = true; p.lives = 0; }
  const alive = room.players.filter((p) => !p.out);
  room.startedAt = now;

  /* Nobody came, or only one did: there is no match to play. One player alone
   * is a walkover — and they still have to have TURNED UP to get it, which is
   * what stops an empty room paying anybody. */
  if (alive.length <= 1) {
    room.phase = 'finished';
    room.endedAt = now;
    room.winnerUserId = alive[0]?.userId ?? null;
    await settle(room);
    return room;
  }

  room.turnUserId = alive[randomInt(alive.length)]!.userId;
  await openQuestion(room, now);
  return room;
}

async function openQuestion(room: WtaRoom, now: number): Promise<void> {
  const q = await pickQuestion(room);
  if (!q) {
    /* An empty question bank cannot be played around. Ending is the honest
     * outcome; the room is settled on who is still standing. */
    room.phase = 'finished';
    room.endedAt = now;
    room.winnerUserId = leader(room);
    await settle(room);
    return;
  }
  room.questionId = q.id;
  room.correctIndex = q.correctIndex;
  room.asked.push(q.id);
  room.phase = 'turn';
  room.endsAt = now + WTA_ANSWER_SECONDS * 1000;
  publish(room.id, 'wta:question', await withAuthor({
    turnUserId: room.turnUserId, questionId: q.id, text: q.text, options: q.options,
    category: q.category, difficulty: q.difficulty, endsAt: room.endsAt, serverNow: now
  }, q));
}

/** Whoever is best placed to be called the winner when a room ends early. */
function leader(room: WtaRoom): string | null {
  const alive = room.players.filter((p) => !p.out);
  if (!alive.length) return null;
  const best = alive.slice().sort((a, b) => b.correct - a.correct || b.lives - a.lives)[0]!;
  return best.userId;
}

/* ── the turn ──────────────────────────────────────────────────────────── */

export interface AnswerResult {
  correct: boolean;
  correctIndex: number;
  /** Set when the answer was right: now they choose who goes next. */
  picking: boolean;
  eliminated: boolean;
  livesLeft: number;
}

export async function answer(roomId: string, userId: string, selectedIndex: number, now = Date.now()): Promise<AnswerResult> {
  const room = rooms.get(roomId);
  if (!room) throw new WtaError('ROOM_NOT_FOUND', 'این اتاق پیدا نشد.');
  if (room.phase !== 'turn') throw new WtaError('NOT_IN_QUESTION', 'الان سؤالی باز نیست.');
  /* Only the player being asked may answer. Without this every other player in
   * the studio could answer their question for them. */
  if (room.turnUserId !== userId) throw new WtaError('NOT_YOUR_TURN', 'نوبت تو نیست.');
  const p = room.players.find((x) => x.userId === userId);
  if (!p || p.out) throw new WtaError('NOT_PLAYING', 'تو در این مسابقه نیستی.');
  /* One second of grace for ordinary clock skew; later than that genuinely
   * missed the deadline and the tick has already taken the life. */
  if (now > room.endsAt + 1000) throw new WtaError('TOO_LATE', 'زمان تمام شد.');

  const correctIndex = room.correctIndex ?? -1;
  const correct = Number(selectedIndex) === correctIndex;
  return applyTurn(room, p, correct, now);
}

async function applyTurn(room: WtaRoom, p: WtaPlayer, correct: boolean, now: number): Promise<AnswerResult> {
  const correctIndex = room.correctIndex ?? -1;
  if (correct) {
    p.correct += 1;
    room.phase = 'picking';
    room.endsAt = now + WTA_PICK_SECONDS * 1000;
    publish(room.id, 'wta:correct', { userId: p.userId, correctIndex, pickBy: p.userId, endsAt: room.endsAt });
    return { correct: true, correctIndex, picking: true, eliminated: false, livesLeft: p.lives };
  }

  p.lives = Math.max(0, p.lives - 1);
  const eliminated = p.lives <= 0;
  if (eliminated) p.out = true;
  publish(room.id, 'wta:wrong', { userId: p.userId, correctIndex, livesLeft: p.lives, eliminated });

  await afterTurnLost(room, p, now);
  return { correct: false, correctIndex, picking: false, eliminated, livesLeft: p.lives };
}

/** A lost turn: the seat passes on, unless the room is over. */
async function afterTurnLost(room: WtaRoom, from: WtaPlayer, now: number): Promise<void> {
  const alive = room.players.filter((x) => !x.out);
  if (alive.length <= 1) {
    room.phase = 'finished';
    room.endedAt = now;
    room.winnerUserId = alive[0]?.userId ?? null;
    await settle(room);
    return;
  }
  room.turnUserId = nextAlive(room, from.userId);
  await openQuestion(room, now);
}

function nextAlive(room: WtaRoom, fromUserId: string): string {
  const order = room.players;
  const at = order.findIndex((p) => p.userId === fromUserId);
  for (let i = 1; i <= order.length; i++) {
    const cand = order[(at + i) % order.length]!;
    if (!cand.out) return cand.userId;
  }
  return fromUserId;
}

/** «از کی بپرسم؟» — the player who just answered names the next one. */
export async function pick(roomId: string, userId: string, targetUserId: string, now = Date.now()): Promise<WtaRoom> {
  const room = rooms.get(roomId);
  if (!room) throw new WtaError('ROOM_NOT_FOUND', 'این اتاق پیدا نشد.');
  if (room.phase !== 'picking') throw new WtaError('NOT_PICKING', 'الان نوبت انتخاب نیست.');
  if (room.turnUserId !== userId) throw new WtaError('NOT_YOUR_PICK', 'انتخاب با تو نیست.');
  const target = room.players.find((x) => x.userId === targetUserId);
  if (!target || target.out) throw new WtaError('TARGET_NOT_PLAYING', 'این بازیکن در مسابقه نیست.');
  /* Asking yourself would be a way to keep the turn for ever. */
  if (targetUserId === userId) throw new WtaError('TARGET_IS_SELF', 'نمی‌توانی خودت را انتخاب کنی.');

  room.turnUserId = targetUserId;
  publish(room.id, 'wta:passed', { from: userId, to: targetUserId });
  await openQuestion(room, now);
  return room;
}

/* ── the clock ─────────────────────────────────────────────────────────── */

/** Advance every room whose deadline has passed. Never throws. */
export async function tick(now = Date.now()): Promise<void> {
  for (const room of [...rooms.values()]) {
    try {
      if (room.phase === 'finished') continue;
      if (now < room.endsAt) continue;
      if (room.phase === 'lobby') { await start(room.id, now); continue; }
      if (room.phase === 'turn') {
        /* The clock ran out. That is a wrong answer — the same cost, because
         * otherwise going quiet would be safer than guessing. */
        const p = room.players.find((x) => x.userId === room.turnUserId);
        if (p) { publish(room.id, 'wta:timeout', { userId: p.userId }); await applyTurn(room, p, false, now); }
        continue;
      }
      if (room.phase === 'picking') {
        /* They did not choose in time, so the studio chooses for them. Leaving
         * the room stuck because one player put their phone down is not an
         * option in a match with a prize on it. */
        const alive = room.players.filter((x) => !x.out && x.userId !== room.turnUserId);
        if (!alive.length) { room.phase = 'finished'; room.endedAt = now; room.winnerUserId = room.turnUserId; await settle(room); continue; }
        const target = alive[randomInt(alive.length)]!;
        publish(room.id, 'wta:passed', { from: room.turnUserId, to: target.userId, auto: true });
        room.turnUserId = target.userId;
        await openQuestion(room, now);
      }
    } catch (e) {
      logger.warn('wta_tick_failed', { roomId: room.id, message: (e as Error).message });
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startWtaWorker(intervalMs = 1000): void {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  logger.info('wta_worker_started', { intervalMs });
}
export function stopWtaWorker(): void { if (timer) { clearInterval(timer); timer = null; } }

/* ── the money ─────────────────────────────────────────────────────────── */

/**
 * The room is over. The league is told who played and who won, and IT is what
 * pays — one place where the money moves, whether the result came from a real
 * match or was filed by hand from the panel.
 *
 * Reported once. A tick and an answer can both finish a room in the same
 * millisecond, and paying a league final twice is the most expensive bug this
 * file could have.
 */
/** Test seam: the double-settle guard is only worth having if it is exercised. */
export async function _settle(room: WtaRoom): Promise<void> { return settle(room); }
async function settle(room: WtaRoom): Promise<void> {
  if (room.reported) return;
  room.reported = true;
  publish(room.id, 'wta:ended', { winnerUserId: room.winnerUserId });
  if (!room.leagueRoomId) return;
  /* Turning up is what earns the participation prize, so the absentees are not
   * on this list even though they held a seat. */
  const played = room.players.filter((p) => !p.absent).map((p) => p.userId);
  try {
    await reportRoomResult({ roomId: room.leagueRoomId, played, winnerUserId: room.winnerUserId });
  } catch (e) {
    /* The match really happened, so the result must not be lost with the error.
     * The room keeps its winner and the panel can file it. */
    room.reported = false;
    logger.error('wta_settle_failed', { roomId: room.id, message: (e as Error).message });
  }
}

/* ── what a client is allowed to see ───────────────────────────────────── */

export async function snapshot(roomId: string, forUserId?: string): Promise<any> {
  const room = rooms.get(roomId);
  if (!room) return null;
  const view: any = {
    id: room.id,
    phase: room.phase,
    turnUserId: room.turnUserId,
    endsAt: room.endsAt,
    serverNow: Date.now(),
    aliveCount: room.players.filter((p) => !p.out).length,
    winnerUserId: room.winnerUserId,
    players: room.players.map((p) => ({ userId: p.userId, username: p.username, lives: p.lives, out: p.out, absent: p.absent }))
  };
  /* The question WITHOUT its answer. The correct index is revealed only once
   * the turn is over, in the events, never here while it is open. */
  if (room.phase === 'turn' && room.questionId) {
    const q = await repositories.questions.findById(room.questionId).catch(() => null);
    if (q) view.question = await withAuthor({ id: q.id, text: q.text, options: q.options, category: q.category, difficulty: q.difficulty }, q);
  }
  if (forUserId) {
    const me = room.players.find((p) => p.userId === forUserId);
    view.me = me
      ? { userId: me.userId, lives: me.lives, out: me.out, absent: me.absent, myTurn: room.turnUserId === forUserId }
      : null;
  }
  return view;
}
