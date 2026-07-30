/* LAST SURVIVOR — orchestrator.
 *
 * A single authoritative loop advances every active room's state machine on
 * real time (waiting → question → elimination → dashboard → cashout → …). Every
 * transition is persisted immediately, so a server restart or a player's dropped
 * connection recovers from the stored room/player rows. Each transition also
 * publishes to the realtime topic `ls:{roomId}` for instant client updates;
 * REST snapshot polling is the authoritative fallback. */
import { repositories } from '../repositories/index.js';
import { realtimeRooms } from '../realtime/roomRegistry.js';
import { logger } from './logger.js';
import {
  listActiveRooms, listPlayers, savePlayer, saveRoom, getRoom, snapshot,
  toPrizePlayers, payout, type RoomRow, type PlayerRow
} from './lastSurvivorService.js';
import { buildPool, activeUnits, finalSplit } from './lastSurvivorPrize.js';

// Per-room set of already-served question ids (best-effort; avoids repeats within
// a match). Lost on restart, which at worst allows a repeat — never a crash.
const usedQuestions = new Map<string, Set<string>>();

let timer: ReturnType<typeof setInterval> | null = null;
export function startLastSurvivorWorker(intervalMs = 1000): void {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  logger.info('ls_worker_started', { intervalMs });
}
export function stopLastSurvivorWorker(): void { if (timer) { clearInterval(timer); timer = null; } }

export async function tick(now = Date.now()): Promise<void> {
  let rooms: RoomRow[] = [];
  try { rooms = await listActiveRooms(); } catch (e) { logger.warn('ls_tick_list_failed', { message: (e as Error).message }); return; }
  for (const room of rooms) {
    try { await advanceRoom(room, now); } catch (e) { logger.warn('ls_advance_failed', { roomId: room.id, message: (e as Error).message }); }
  }
}

function publish(roomId: string, type: string, payload: any): void {
  // Broadcast to everyone subscribed to this room's realtime topic. LS uses its
  // own `ls:*` event names; the type is cast since it's forwarded verbatim.
  try { realtimeRooms.broadcastTopic(`ls:${roomId}`, { type, payload } as any); } catch { /* realtime optional */ }
}
async function broadcastState(roomId: string): Promise<void> {
  const snap = await snapshot(roomId);
  if (snap) publish(roomId, 'ls:state', snap);
}

/** Advance a single room by one step if its deadline has passed. */
export async function advanceRoom(room: RoomRow, now = Date.now()): Promise<void> {
  if (room.status === 'waiting') { await maybeStart(room, now); return; }
  if (room.status === 'running' && room.phaseEndsAt != null && now >= room.phaseEndsAt) { await advancePhase(room, now); }
}

async function maybeStart(room: RoomRow, now: number): Promise<void> {
  const players = await listPlayers(room.id);
  const count = players.length;
  // Reap a room nobody joined well past its deadline.
  if (count === 0) { if (now > room.startsAt + 120_000) { room.status = 'finished'; room.phase = 'finished'; room.endedAt = now; await saveRoom(room); } return; }

  const cfg = room.config;
  const votes = await import('./lastSurvivorService.js').then((m) => m.countVotes(room.id));
  const capacityFull = count >= room.capacity;
  const deadlineHit = now >= room.startsAt;
  const votePassed = room.manualStartEnabled && count > 0 && (votes * 100) / count >= room.startPct;

  let start = false;
  if (capacityFull) start = true;                                   // full → start instantly (new joiners open a fresh room)
  else if (count >= room.minUsers && (deadlineHit || votePassed)) start = true;
  else if (deadlineHit && count < room.minUsers) { room.startsAt = now + room.waitSeconds * 1000; await saveRoom(room); return; } // below floor → keep waiting

  if (!start) return;

  for (const p of players) { if (p.status === 'waiting') { p.status = 'alive'; p.lastSeenAt = now; await savePlayer(p); } }
  room.status = 'running'; room.startedAt = now;
  await beginRound(room, 1, now);
  logger.info('ls_started', { roomId: room.id, players: count, pool: room.grossPool });
}

/**
 * Difficulty ladder: the match climbs easy → medium → hard → veryhard in EQUAL
 * blocks. With the default 12 rounds that is exactly 3+3+3+3 (as specified);
 * change totalRounds in the admin panel and the proportion is preserved
 * (e.g. 8 rounds → 2 each, 20 → 5 each). Rounds beyond the ladder stay at the
 * hardest tier.
 */
export function difficultyForRound(round: number, totalRounds: number): 'easy' | 'medium' | 'hard' | 'veryhard' {
  const tiers: Array<'easy' | 'medium' | 'hard' | 'veryhard'> = ['easy', 'medium', 'hard', 'veryhard'];
  const per = Math.max(1, Math.ceil(Math.max(1, totalRounds) / tiers.length));
  const idx = Math.min(tiers.length - 1, Math.floor((Math.max(1, round) - 1) / per));
  return tiers[idx]!;
}

async function pickQuestion(topic: string, roomId: string, round = 1, totalRounds = 12): Promise<{ id: string; correctIndex: number; text: string; options: string[]; difficulty?: string } | null> {
  const all = await repositories.questions.listApproved();
  const pool = all.filter((q) => q.category === topic);
  if (!pool.length) return null;
  let used = usedQuestions.get(roomId); if (!used) { used = new Set(); usedQuestions.set(roomId, used); }
  const fresh = pool.filter((q) => !used!.has(q.id));
  const available = fresh.length ? fresh : (used.clear(), pool);

  // Prefer the tier this round should be; if the bank has none, walk outward to
  // the nearest tier so the match never stalls on a missing difficulty.
  const order: Array<'easy' | 'medium' | 'hard' | 'veryhard'> = ['easy', 'medium', 'hard', 'veryhard'];
  const want = difficultyForRound(round, totalRounds);
  const wantIdx = order.indexOf(want);
  let candidates = available.filter((q) => q.difficulty === want);
  if (!candidates.length) {
    for (let d = 1; d < order.length && !candidates.length; d++) {
      const near = [order[wantIdx - d], order[wantIdx + d]].filter(Boolean) as string[];
      candidates = available.filter((q) => near.includes(q.difficulty));
    }
  }
  if (!candidates.length) candidates = available;

  const q = candidates[Math.floor(Math.random() * candidates.length)]!;
  used.add(q.id);
  return { id: q.id, correctIndex: q.correctIndex, text: q.text, options: q.options, difficulty: q.difficulty };
}

/* Each round opens with a READY gate (exactly like the duel's «آماده‌ای؟»
 * countdown): the question is already picked so the client can show its
 * difficulty badge, but the answer window only starts when the gate ends — so
 * the countdown never eats into answering time. */
async function beginRound(room: RoomRow, roundNo: number, now: number): Promise<void> {
  const q = await pickQuestion(room.topic, room.id, roundNo, room.totalRounds);
  room.round = roundNo;
  room.phase = 'ready';
  room.questionId = q?.id ?? null;
  room.correctIndex = q?.correctIndex ?? null;
  room.phaseEndsAt = now + Math.max(3, Number(room.config.timings.readySeconds) || 5) * 1000;
  await saveRoom(room);
  publish(room.id, 'ls:ready', { round: roundNo, questionId: q?.id, difficulty: q?.difficulty, endsAt: room.phaseEndsAt, serverNow: now });
  await broadcastState(room.id);
}

/* Ready gate finished → open the answer window with the FULL configured time. */
async function openQuestion(room: RoomRow, now: number): Promise<void> {
  room.phase = 'question';
  // Floor the window so a low/0 admin value can't grade the round instantly
  // (which felt like "eliminated the moment the match starts").
  room.phaseEndsAt = now + Math.max(8, Number(room.config.timings.questionSeconds) || 8) * 1000;
  await saveRoom(room);
  // Send the question WITHOUT the correct index.
  publish(room.id, 'ls:question', { round: room.round, questionId: room.questionId, endsAt: room.phaseEndsAt, serverNow: now });
  await broadcastState(room.id);
}

async function advancePhase(room: RoomRow, now: number): Promise<void> {
  const players = await listPlayers(room.id);
  if (room.phase === 'ready') { await openQuestion(room, now); return; }
  if (room.phase === 'question') {
    // Grade: an alive player who didn't answer this round, or answered wrong, is
    // eliminated — UNLESS there was no valid question (empty topic), in which
    // case the round is void and nobody is eliminated.
    const eliminated: string[] = [];
    if (room.correctIndex != null) {
      for (const p of players) {
        if (p.status !== 'alive') continue;
        const answered = p.answerRound === room.round;
        const correct = answered && p.answerCorrect === true;
        if (!correct) { p.status = 'eliminated'; p.eliminatedRound = room.round; await savePlayer(p); eliminated.push(p.userId); }
      }
    }
    room.phase = 'elimination';
    room.phaseEndsAt = now + Math.max(3, Number(room.config.timings.eliminationSeconds) || 3) * 1000;
    await saveRoom(room);
    // Public: who was eliminated (for the Squid-Game animation). The correct
    // answer is delivered privately in each eliminated player's own snapshot.
    publish(room.id, 'ls:elimination', { round: room.round, eliminated, correctIndex: room.correctIndex, questionId: room.questionId });
    await broadcastState(room.id);
    return;
  }
  if (room.phase === 'elimination') {
    room.phase = 'dashboard';
    room.phaseEndsAt = now + Math.max(3, Number(room.config.timings.dashboardSeconds) || 3) * 1000;
    await saveRoom(room);
    await broadcastState(room.id);
    return;
  }
  if (room.phase === 'dashboard') {
    const alive = players.filter((p) => p.status === 'alive');
    if (alive.length <= room.config.match.minSurvivors || room.round >= room.totalRounds) { await finishRoom(room, now); return; }
    room.phase = 'cashout';
    room.phaseEndsAt = now + Math.max(4, Number(room.config.timings.cashoutSeconds) || 4) * 1000;
    await saveRoom(room);
    // Offer cash-out only to players still alive (they all answered correctly).
    publish(room.id, 'ls:cashout_offer', { round: room.round, eligible: alive.map((p) => p.userId) });
    await broadcastState(room.id);
    return;
  }
  if (room.phase === 'cashout') {
    await processCashouts(room, players, now);
    const stillAlive = (await listPlayers(room.id)).filter((p) => p.status === 'alive');
    if (stillAlive.length <= room.config.match.minSurvivors || room.round >= room.totalRounds) { await finishRoom(room, now); return; }
    await beginRound(room, room.round + 1, now);
    return;
  }
}

async function processCashouts(room: RoomRow, players: PlayerRow[], now: number): Promise<void> {
  const pool = buildPool(room.config, players.map((p) => p.color));
  const paidOut = players.filter((p) => p.status === 'cashed_out').reduce((s, p) => s + p.payoutCash, 0);
  const remaining = Math.max(0, pool.net - paidOut);
  const alive = players.filter((p) => p.status === 'alive');
  const au = activeUnits(toPrizePlayers(alive));
  // Compute all shares against the SAME pre-cashout snapshot so simultaneous
  // cash-outs are fair and never over-pay the pot.
  for (const p of alive) {
    const cashedOut = p.decisionRound === room.round && p.decision === 'cashout';
    if (!cashedOut) continue;
    const share = au > 0 ? Math.floor((remaining * p.units) / au) : 0;
    if (share > 0) { try { await payout(p.userId, share, room.id, room.round, 'cashout'); } catch (e) { logger.error('ls_cashout_payout_failed', { roomId: room.id, userId: p.userId, message: (e as Error).message }); continue; } }
    p.status = 'cashed_out'; p.cashedOutRound = room.round; p.payoutCash = share; p.lastSeenAt = now;
    await savePlayer(p);
    publish(room.id, 'ls:cashed_out', { userId: p.userId, amount: share, round: room.round });
  }
}

async function finishRoom(room: RoomRow, now: number): Promise<void> {
  const players = await listPlayers(room.id);
  const pool = buildPool(room.config, players.map((p) => p.color));
  const paidOut = players.filter((p) => p.status === 'cashed_out').reduce((s, p) => s + p.payoutCash, 0);
  const remaining = Math.max(0, pool.net - paidOut);
  const split = finalSplit(toPrizePlayers(players), remaining);
  for (const p of players) {
    if (p.status !== 'alive') continue;
    const amount = split[p.userId] ?? 0;
    if (amount > 0) { try { await payout(p.userId, amount, room.id, room.round, 'final'); } catch (e) { logger.error('ls_final_payout_failed', { roomId: room.id, userId: p.userId, message: (e as Error).message }); } }
    p.payoutCash += amount; p.cashedOutRound = p.cashedOutRound ?? room.round; p.lastSeenAt = now;
    await savePlayer(p);
  }
  room.status = 'finished'; room.phase = 'finished'; room.phaseEndsAt = null; room.endedAt = now;
  await saveRoom(room);
  usedQuestions.delete(room.id);
  publish(room.id, 'ls:ended', { round: room.round, winners: players.filter((p) => p.status === 'alive').map((p) => ({ userId: p.userId, amount: (split[p.userId] ?? 0) })) });
  await broadcastState(room.id);
  logger.info('ls_finished', { roomId: room.id, round: room.round });
}

// ---- player actions (called from HTTP/WS) ----
export async function submitAnswer(roomId: string, userId: string, round: number, selectedIndex: number): Promise<{ accepted: boolean; reason?: string }> {
  const room = await getRoom(roomId);
  if (!room || room.status !== 'running' || room.phase !== 'question') return { accepted: false, reason: 'NOT_IN_QUESTION' };
  if (round !== room.round) return { accepted: false, reason: 'WRONG_ROUND' };
  const players = await listPlayers(roomId);
  const p = players.find((x) => x.userId === userId);
  if (!p || p.status !== 'alive') return { accepted: false, reason: 'NOT_ALIVE' };
  if (p.answerRound === room.round) return { accepted: true }; // idempotent — first answer stands
  const correct = room.correctIndex != null && selectedIndex === room.correctIndex;
  p.answerRound = room.round; p.answerIndex = selectedIndex; p.answerCorrect = correct; p.lastSeenAt = Date.now();
  await savePlayer(p);
  return { accepted: true };
}

export async function submitDecision(roomId: string, userId: string, round: number, decision: 'cashout' | 'continue'): Promise<{ accepted: boolean; reason?: string }> {
  const room = await getRoom(roomId);
  if (!room || room.status !== 'running' || room.phase !== 'cashout') return { accepted: false, reason: 'NOT_IN_CASHOUT' };
  if (round !== room.round) return { accepted: false, reason: 'WRONG_ROUND' };
  const p = (await listPlayers(roomId)).find((x) => x.userId === userId);
  if (!p || p.status !== 'alive') return { accepted: false, reason: 'NOT_ALIVE' };
  p.decisionRound = room.round; p.decision = decision; p.lastSeenAt = Date.now();
  await savePlayer(p);
  return { accepted: true };
}
