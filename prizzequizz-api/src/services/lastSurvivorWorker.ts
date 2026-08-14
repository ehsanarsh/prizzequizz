/* LAST SURVIVOR — orchestrator.
 *
 * A single authoritative loop advances every active room's state machine on
 * real time (waiting → question → elimination → dashboard → cashout → …). Every
 * transition is persisted immediately, so a server restart or a player's dropped
 * connection recovers from the stored room/player rows. Each transition also
 * publishes to the realtime topic `ls:{roomId}` for instant client updates;
 * REST snapshot polling is the authoritative fallback. */
import { getConfig, isInRandomPool, isRandomTopic, randomPoolCategories } from './lastSurvivorConfig.js';
import { repositories } from '../repositories/index.js';
import { realtimeRooms } from '../realtime/roomRegistry.js';
import { logger } from './logger.js';
import {
  listActiveRooms, listPlayers, savePlayer, saveRoom, getRoom, snapshot,
  toPrizePlayers, payout, type RoomRow, type PlayerRow, sweepIdlePlayers,
  recordRound, recordAnswerAudit} from './lastSurvivorService.js';
import { buildPool, activeUnits, finalSplit } from './lastSurvivorPrize.js';
import { awardScoring } from './matchEngine.js';
import { PZ_SCORING } from './scoringConfig.js';
import { getQuestionDistribution, recordQuestionAnswer } from './questionStatsService.js';
import * as missions from './missionService.js';
import { bookHouseRevenue } from './houseRevenueService.js';

// Per-room set of already-served question ids (best-effort; avoids repeats within
// a match). Lost on restart, which at worst allows a repeat — never a crash.
const usedQuestions = new Map<string, Set<string>>();
/* XP earned per player, accumulated across the rounds so the end-of-match
 * mission report can state it. Keyed `${roomId}:${userId}` and dropped when the
 * room ends. Best-effort: a restart loses the running total and the missions
 * simply see the outcome XP, never a wrong number. */
const lsXp = new Map<string, number>();
const xpKey = (roomId: string, userId: string) => roomId + ':' + userId;

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

/* The same grace period the lobby endpoint uses, so a player is never dropped
 * by one code path while the other still counts them. */
const LOBBY_IDLE_MS = 45_000;

/** Advance a single room by one step if its deadline has passed. */
export async function advanceRoom(room: RoomRow, now = Date.now()): Promise<void> {
  if (room.status === 'waiting') { await maybeStart(room, now); return; }
  if (room.status === 'running' && room.phaseEndsAt != null && now >= room.phaseEndsAt) { await advancePhase(room, now); }
}

async function maybeStart(room: RoomRow, now: number): Promise<void> {
  /* Drop anyone who walked away BEFORE counting heads. A player who closed the
   * app used to keep their seat, so a room could reach minUsers — and start —
   * on people who were not there, with their stake in the pot and no chance of
   * them answering. Their ticket goes back inside leaveRoom. */
  await sweepIdlePlayers(room.id, LOBBY_IDLE_MS).catch(() => undefined);
  const fresh = await getRoom(room.id);
  if (!fresh || fresh.status !== 'waiting') return;   // swept to empty, or started
  room = fresh;

  const players = await listPlayers(room.id);
  const count = players.length;
  /* An empty waiting room is closed AT ONCE, not two minutes later. While it
   * lived, findOrCreateRoom would hand it to the next player to pick this
   * topic — with the countdown it was created with, which by then had already
   * expired. A player who walks in has to start a clock, not inherit one. */
  if (count === 0) { room.status = 'finished'; room.phase = 'finished'; room.endedAt = now; await saveRoom(room); logger.info('ls_room_closed_empty', { roomId: room.id, via: 'tick' }); return; }

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

/* THE ORDER PLAYERS GO OUT IN.
 *
 * Eliminations are graded all at once, but they are SHOWN one at a time — and
 * when everybody goes out together, the last one out is the only one who gets
 * paid. That makes the order money, not decoration, so it cannot be decided by
 * the animation: it is decided here, sent with the elimination event, and
 * recomputed identically when the room settles.
 *
 * It is derived from the room, the round and the user id rather than stored, so
 * the two computations cannot drift and no column has to be added. Same inputs,
 * same order, every time — and unguessable before the round is graded, because
 * the room id is a uuid.
 */
export function eliminationOrder(roomId: string, round: number, userIds: string[]): string[] {
  const key = (u: string) => {
    let h = 0x811c9dc5;
    const src = `${roomId}:${round}:${u}`;
    for (let i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h;
  };
  return userIds.slice().sort((a, b) => (key(a) - key(b)) || (a < b ? -1 : a > b ? 1 : 0));
}

/* Exported as a test seam. Which questions a topic is allowed to draw is the
 * whole point of the random pool, and driving a full room to find out would
 * test the room rather than the rule. */
export async function pickQuestion(topic: string, roomId: string, round = 1, totalRounds = 12): Promise<{ id: string; correctIndex: number; text: string; options: string[]; difficulty?: string } | null> {
  const all = await repositories.questions.listApproved();
  /* «تصادفی» is not a category — it is every category. Filtering by name would
   * match nothing and the room would stall on an empty bank, so the whole
   * approved pool is the pool. It is also what makes the mode work at all
   * early on: one category rarely has enough questions for twelve rounds
   * across four difficulty tiers, the union always does. */
  let pool = isRandomTopic(topic) ? all : all.filter((q) => q.category === topic);
  /* «تصادفی» is every category by default, but an operator can name the ones it
   * is allowed to use — some topics are simply not wanted in the random mix.
   * If that narrowing leaves nothing, the whole bank is used anyway and it is
   * logged: a paid match stalling on an empty pool is worse than a round drawn
   * from a category the operator would rather not have seen. */
  if (isRandomTopic(topic)) {
    const cfg = await getConfig();
    const picked = randomPoolCategories(cfg);
    if (picked.length) {
      const narrowed = all.filter((q) => isInRandomPool(cfg, q.category));
      if (narrowed.length) pool = narrowed;
      else logger.warn('ls_random_pool_empty', { roomId, categories: picked });
    }
  }
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
  /* Keep WHAT this round asked. The room row is about to be overwritten by the
   * next round, and without this the match cannot be reviewed afterwards. */
  if (q) await recordRound(room.id, roundNo, q.id, q.correctIndex).catch(() => undefined);
  /* The TEXT and OPTIONS ride the push, never the correct index.
   *
   * They used to be reachable only through the snapshot, so every client had to
   * fetch one the moment a round opened — all of them at once, on the same
   * second. Whatever went wrong with any of those fetches (a slow phone, a
   * dropped request, a rate-limited one) left that player looking at a card
   * with no question in it while the clock ran, and the grader took their
   * shield for it. Carrying the question on the broadcast that ANNOUNCES the
   * round removes the extra round-trip from the path entirely. */
  publish(room.id, 'ls:ready', { round: roundNo, questionId: q?.id, difficulty: q?.difficulty, text: q?.text, options: q?.options, endsAt: room.phaseEndsAt, serverNow: now });
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
  let qq: { text?: string; options?: string[]; difficulty?: string } = {};
  if (room.questionId) {
    try { const q = await repositories.questions.findById(room.questionId); if (q) qq = { text: q.text, options: q.options, difficulty: q.difficulty }; }
    catch { /* the snapshot still carries it */ }
  }
  publish(room.id, 'ls:question', { round: room.round, questionId: room.questionId, ...qq, endsAt: room.phaseEndsAt, serverNow: now });
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
    /* Who lost a shield this round rather than their place — the client needs
     * this to show the shield breaking instead of an elimination. */
    const shielded: Array<{ userId: string; left: number }> = [];
    if (room.correctIndex != null) {
      // Same per-question XP/cup as the duel (by difficulty, paid multiplier),
      // so Last Survivor feeds XP, level and the weekly cup identically.
      const tier = difficultyForRound(room.round, room.totalRounds);
      const pq = PZ_SCORING.perQuestion[tier] || PZ_SCORING.perQuestion.easy!;
      const mult = PZ_SCORING.paidMultiplier;
      for (const p of players) {
        if (p.status !== 'alive') continue;
        const answered = p.answerRound === room.round;
        const correct = answered && p.answerCorrect === true;
        const pts = correct ? { xp: pq.xp * mult, cup: pq.cup * mult } : { xp: PZ_SCORING.perQuestion.wrong!.xp * mult, cup: PZ_SCORING.perQuestion.wrong!.cup * mult };
        try { await awardScoring(p.userId, pts.xp, pts.cup); } catch (e) { logger.warn('ls_award_failed', { userId: p.userId, message: (e as Error).message }); }
        /* Last Survivor answers count towards the same missions the duel feeds.
         * A player only reaches round N by answering the first N-1 correctly,
         * so the round number IS their correct-answer run. */
        await missions.recordAnswer(p.userId, correct, correct ? room.round : 0);
        /* Track XP for the end-of-match mission report while it is known. */
        const xk = xpKey(room.id, p.userId);
        lsXp.set(xk, (lsXp.get(xk) ?? 0) + pts.xp);
        if (!correct) {
          /* A shield is spent BEFORE elimination is considered, so a red ticket
           * (two shields) survives two wrong answers and goes out on the third.
           * Green has none and behaves exactly as it always did. */
          if ((p.shields ?? 0) > 0) {
            p.shields = (p.shields ?? 0) - 1;
            /* Stamp the round so the player's own snapshot can say "your shield
             * took this one" — alive alone reads as a correct answer. */
            p.shieldRound = room.round;
            await savePlayer(p);
            shielded.push({ userId: p.userId, left: p.shields });
          } else {
            p.status = 'eliminated'; p.eliminatedRound = room.round;
            await savePlayer(p);
            eliminated.push(p.userId);
          }
        }
      }
    }
    room.phase = 'elimination';
    /* THE PHASE HAS TO OUTLAST THE ANIMATION IT ASKS FOR.
       Players are stamped out one at a time, a second apart, so a fixed three
       seconds would cut the sequence off after the third name — and with it the
       moment a player is shown their own elimination. The phase is the base
       length plus a second per player going out, capped so a mass wipe-out in a
       big room cannot stall the match; past the cap the client tightens its own
       spacing to fit whatever time this leaves. */
    const elimBase = Math.max(3, Number(room.config.timings.eliminationSeconds) || 3) * 1000;
    room.phaseEndsAt = now + Math.min(20_000, elimBase + eliminated.length * 1000);
    await saveRoom(room);
    // Public: who was eliminated (for the Squid-Game animation). The correct
    // answer is delivered privately in each eliminated player's own snapshot.
    /* The order the client plays them out in — and, when the round wipes the
       room, the order that decides who the last one out is. */
    const order = eliminationOrder(room.id, room.round, eliminated);
    publish(room.id, 'ls:elimination', { round: room.round, eliminated: order, shielded, correctIndex: room.correctIndex, questionId: room.questionId });
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
  const survivors = players.filter((p) => p.status === 'alive');
  const split = finalSplit(toPrizePlayers(players), remaining);
  for (const p of players) {
    if (p.status !== 'alive') continue;
    const amount = split[p.userId] ?? 0;
    if (amount > 0) { try { await payout(p.userId, amount, room.id, room.round, 'final'); } catch (e) { logger.error('ls_final_payout_failed', { roomId: room.id, userId: p.userId, message: (e as Error).message }); } }
    p.payoutCash += amount; p.cashedOutRound = p.cashedOutRound ?? room.round; p.lastSeenAt = now;
    await savePlayer(p);
  }

  /* NOBODY SURVIVED. The last two or three players all answered wrongly, so
   * finalSplit has nobody to pay and the remaining pot is not distributed.
   * Until this was written the money simply stopped being mentioned anywhere:
   * it stayed with the company (it entered as ticket sales and no payout left),
   * but no record said so and no screen could show it. Now the forfeited pot is
   * booked to the house with the room, the round and the head count, so it can
   * be audited afterwards instead of being inferred. The rake is booked the same
   * way — it was equally invisible before. */
  const rake = Math.max(0, pool.gross - pool.net);
  if (rake > 0) {
    await bookHouseRevenue({
      key: 'ls_rake:' + room.id, source: 'ls_rake', amount: rake,
      refType: 'ls_room', refId: room.id,
      description: 'کارمزد پلتفرم — آخرین بازمانده',
      metadata: { topic: room.topic, grossPool: pool.gross, netPool: pool.net, players: players.length }
    }).catch((e) => { logger.error('ls_rake_book_failed', { roomId: room.id, detail: (e as Error).message }); return false; });
  }
  /* NOBODY SURVIVED — WHO GETS THE MONEY.
   *
   * The whole room went out on the same question, so there is no winner to pay
   * and, until now, the entire remaining pot simply stayed with the house. The
   * rule the operator wants is kinder and still simple: the pot is divided
   * among the players who were still standing at the start of that last round
   * — the ones who have just been wiped out — but only ONE of those shares is
   * actually paid: the share of the LAST player to go out. The rest stays with
   * the house, booked as forfeited exactly as before.
   *
   * "Last to go out" is not the animation's opinion: it is the last id in
   * eliminationOrder for that round, the same order the client was told to play
   * and the same one recomputed here. */
  let wipeout: { lastUserId: string; share: number; splitAmong: number } | null = null;
  let paidFromWipeout = 0;
  if (survivors.length === 0 && remaining > 0) {
    const lastRound = players.filter((p) => p.status === 'eliminated' && p.eliminatedRound === room.round);
    if (lastRound.length > 0) {
      const order = eliminationOrder(room.id, room.round, lastRound.map((p) => p.userId));
      const lastId = order[order.length - 1]!;
      /* Split by units among everyone who was still in, exactly as a normal
       * final split would have done — so the figure the player receives is the
       * share they would have had, not an invented consolation. */
      const asAlive = lastRound.map((p) => ({ userId: p.userId, color: p.color, units: p.units, status: 'alive' as const, payoutCash: p.payoutCash }));
      const split = finalSplit(asAlive, remaining);
      const share = Math.max(0, split[lastId] ?? 0);
      const winner = lastRound.find((p) => p.userId === lastId);
      if (winner && share > 0) {
        try {
          await payout(winner.userId, share, room.id, room.round, 'final');
          winner.payoutCash += share; winner.lastSeenAt = now;
          await savePlayer(winner);
          paidFromWipeout = share;
          wipeout = { lastUserId: lastId, share, splitAmong: lastRound.length };
          logger.info('ls_wipeout_last_paid', { roomId: room.id, round: room.round, userId: lastId, share, splitAmong: lastRound.length });
        } catch (e) {
          logger.error('ls_wipeout_payout_failed', { roomId: room.id, userId: lastId, message: (e as Error).message });
        }
      }
    }
  }

  const forfeited = survivors.length === 0 ? Math.max(0, remaining - paidFromWipeout) : 0;
  if (forfeited > 0) {
    await bookHouseRevenue({
      key: 'ls_forfeit:' + room.id, source: 'ls_forfeited_pot', amount: forfeited,
      refType: 'ls_room', refId: room.id,
      description: 'پات بدون برنده — همهٔ بازیکنان حذف شدند',
      metadata: {
        topic: room.topic, round: room.round, totalRounds: room.totalRounds,
        players: players.length, eliminated: players.filter((p) => p.status === 'eliminated').length,
        cashedOut: players.filter((p) => p.status === 'cashed_out').length,
        grossPool: pool.gross, netPool: pool.net, alreadyPaidOut: paidOut
      }
    }).catch((e) => { logger.error('ls_forfeit_book_failed', { roomId: room.id, detail: (e as Error).message }); return false; });
    logger.info('ls_pot_forfeited', { roomId: room.id, topic: room.topic, round: room.round, amount: forfeited, players: players.length });
  }

  // End-of-match outcome XP/cup, same table the duel uses: survivors get the
  // win reward, everyone else the loss reward (so they still climb the league).
  const winMult = PZ_SCORING.paidMultiplier;
  for (const p of players) {
    const res = p.status === 'alive' ? PZ_SCORING.result.win! : PZ_SCORING.result.loss!;
    try { await awardScoring(p.userId, res.xp * winMult, res.cup * winMult); } catch (e) { logger.warn('ls_result_award_failed', { userId: p.userId, message: (e as Error).message }); }
    /* Missions. A Last Survivor room is one topic, one entry ticket, and a win
     * is surviving to the end — cashing out early is not a win but the money
     * still counts. Same reporter the duel uses, so every mission that works
     * for one works for the other. */
    const xk = xpKey(room.id, p.userId);
    await missions.recordMatch({
      userId: p.userId,
      won: p.status === 'alive',
      paid: true,
      categories: [room.topic],
      xp: (lsXp.get(xk) ?? 0) + res.xp * winMult,
      cashPrize: p.payoutCash,
      ticketsUsed: 1,
      /* Surviving every round means never answering wrongly. */
      flawless: p.status === 'alive',
      at: now
    });
    lsXp.delete(xk);
  }
  room.status = 'finished'; room.phase = 'finished'; room.phaseEndsAt = null; room.endedAt = now;
  await saveRoom(room);
  usedQuestions.delete(room.id);
  /* `forfeited` tells the client why the end screen has no winner, so it can say
   * so plainly instead of showing an empty podium. */
  publish(room.id, 'ls:ended', {
    round: room.round, forfeited, wipeout,
    winners: survivors.map((p) => ({ userId: p.userId, amount: (split[p.userId] ?? 0) }))
  });
  await broadcastState(room.id);
  logger.info('ls_finished', { roomId: room.id, round: room.round, survivors: survivors.length, forfeited });
}

// ---- player actions (called from HTTP/WS) ----
/* LIFELINES. The correct index is a server secret, so 50:50 must be resolved
 * here: we return two WRONG option indexes to grey out (which never reveals
 * which of the remaining two is right). "Second chance" is armed per
 * room+round+user in memory; submitAnswer then allows exactly one overwrite of
 * a wrong first answer. */
const secondChanceArmed = new Set<string>();       // `${roomId}:${round}:${userId}`
const secondChanceUsed = new Set<string>();
const scKey = (roomId: string, round: number, userId: string) => `${roomId}:${round}:${userId}`;

/* USING A HELP IN A ROOM.
 *
 * `charge` is what actually takes the help off the player's stock. It is called
 * ONLY after this function has decided the help can be used and has worked out
 * what it delivers — never before.
 *
 * That ordering is the whole point. The client used to debit the stock first
 * and then ask the room to act; every rejection here (wrong phase, already
 * answered, no question yet) therefore cost the player a help they had bought
 * and gave them nothing, and because the debit also claims a once-per-round
 * slot, tapping again answered «قبلاً استفاده کرده‌ای». Deciding first and
 * charging second makes a refused help free, which is the only honest way for
 * it to fail.
 */
export async function useLifeline(
  roomId: string,
  userId: string,
  type: string,
  charge?: (round: number) => Promise<{ remaining: number }>
): Promise<{ ok: boolean; reason?: string; removeIndexes?: number[]; armed?: boolean; percents?: number[]; sample?: number; remaining?: number; charged?: boolean }> {
  const room = await getRoom(roomId);
  // Usable during the ready gate too, so a player can plan before the timer runs.
  if (!room || room.status !== 'running' || (room.phase !== 'question' && room.phase !== 'ready')) return { ok: false, reason: 'NOT_IN_QUESTION' };
  const p = (await listPlayers(roomId)).find((x) => x.userId === userId);
  if (!p || p.status !== 'alive') return { ok: false, reason: 'NOT_ALIVE' };
  if (p.answerRound === room.round) return { ok: false, reason: 'ALREADY_ANSWERED' };
  const take = async (): Promise<number | undefined> =>
    charge ? (await charge(room.round)).remaining : undefined;

  if (type === '5050') {
    if (room.correctIndex == null || !room.questionId) return { ok: false, reason: 'NO_QUESTION' };
    let optionCount = 4;
    try { const q = await repositories.questions.findById(room.questionId); if (q?.options?.length) optionCount = q.options.length; } catch { /* default 4 */ }
    const wrong: number[] = [];
    for (let i = 0; i < optionCount; i++) if (i !== room.correctIndex) wrong.push(i);
    // Remove two of the wrong ones (random), leaving the correct one + one wrong.
    for (let i = wrong.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [wrong[i], wrong[j]] = [wrong[j]!, wrong[i]!]; }
    const remaining = await take();
    return { ok: true, removeIndexes: wrong.slice(0, Math.max(0, optionCount - 2)), remaining, charged: true };
  }
  if (type === 'second') {
    const k = scKey(roomId, room.round, userId);
    if (secondChanceUsed.has(k)) return { ok: false, reason: 'ALREADY_USED' };
    if (secondChanceArmed.has(k)) return { ok: false, reason: 'ALREADY_ARMED' };
    const remaining = await take();
    secondChanceArmed.add(k);
    return { ok: true, armed: true, remaining, charged: true };
  }
  if (type === 'stats') {
    // GLOBAL distribution: how EVERY player who has ever answered this question
    // — in any mode, any match — chose. Percentages only; never reveals which
    // option is correct.
    if (!room.questionId) return { ok: false, reason: 'NO_QUESTION' };
    let optionCount = 4;
    try { const q = await repositories.questions.findById(room.questionId); if (q?.options?.length) optionCount = q.options.length; } catch { /* default 4 */ }
    const { percents, sample } = await getQuestionDistribution(room.questionId, optionCount);
    /* Nobody has answered this question yet, so there is nothing to show. Four
     * bars reading ۰٪ is not a hint, and charging for it is charging for
     * nothing — so the help stays in the player's pocket. */
    if (!sample) return { ok: true, percents, sample: 0, charged: false };
    const remaining = await take();
    return { ok: true, percents, sample, remaining, charged: true };
  }
  return { ok: false, reason: 'UNKNOWN_LIFELINE' };
}

export async function submitAnswer(roomId: string, userId: string, round: number, selectedIndex: number): Promise<{ accepted: boolean; reason?: string; secondChance?: boolean; retry?: boolean }> {
  const room = await getRoom(roomId);
  if (!room || room.status !== 'running' || room.phase !== 'question') return { accepted: false, reason: 'NOT_IN_QUESTION' };
  if (round !== room.round) return { accepted: false, reason: 'WRONG_ROUND' };
  /* The window is CLOSED once the deadline passes, even though the phase is
   * still 'question' until the orchestrator gets to it. Grading reads the
   * players it fetched when it started, so an answer accepted during that gap
   * is written and then overwritten by the grader's own save — recorded in the
   * audit the review reads, invisible to the grading that costs a shield. That
   * is the same contradiction the heartbeat produced, by a narrower path.
   * A grace of one second absorbs ordinary clock skew between phone and
   * server; anything later genuinely missed the deadline. */
  if (room.phaseEndsAt != null && Date.now() > room.phaseEndsAt + 1000) {
    return { accepted: false, reason: 'TOO_LATE' };
  }
  const players = await listPlayers(roomId);
  const p = players.find((x) => x.userId === userId);
  if (!p || p.status !== 'alive') return { accepted: false, reason: 'NOT_ALIVE' };
  if (p.answerRound === room.round) {
    // Second chance: one overwrite of a WRONG first answer, if it was armed.
    const k = scKey(roomId, room.round, userId);
    if (p.answerCorrect === false && secondChanceArmed.has(k) && !secondChanceUsed.has(k) && p.answerIndex === selectedIndex) {
      // Re-sending the SAME wrong pick doesn't burn the retry.
      return { accepted: true, retry: true };
    }
    if (p.answerCorrect === false && secondChanceArmed.has(k) && !secondChanceUsed.has(k)) {
      secondChanceArmed.delete(k); secondChanceUsed.add(k);
      const correct2 = room.correctIndex != null && selectedIndex === room.correctIndex;
      p.answerIndex = selectedIndex; p.answerCorrect = correct2; p.lastSeenAt = Date.now();
      await savePlayer(p);
      /* The second chance REPLACES the first pick, so the audit has to be
       * replaced too — otherwise the review would show a player the wrong
       * answer they were allowed to take back. */
      await recordAnswerAudit(roomId, room.round, userId, selectedIndex, correct2, true).catch(() => undefined);
      return { accepted: true, secondChance: true };
    }
    return { accepted: true };                        // idempotent — first answer stands
  }
  const correct = room.correctIndex != null && selectedIndex === room.correctIndex;
  p.answerRound = room.round; p.answerIndex = selectedIndex; p.answerCorrect = correct; p.lastSeenAt = Date.now();
  await savePlayer(p);
  /* The player row keeps only the LAST answer, so it cannot say what was picked
   * in round 3 once round 4 has been answered. This per-round audit is what the
   * post-match review reads — the table existed but nothing ever wrote to it. */
  await recordAnswerAudit(roomId, room.round, userId, selectedIndex, correct).catch(() => undefined);
  void recordQuestionAnswer(room.questionId ?? '', selectedIndex);   // global per-question tally
  // If the player armed "second chance" and this first pick is WRONG, tell them
  // to pick again — that IS the lifeline. (It reveals only that this option was
  // wrong, never which one is right.)
  const k2 = scKey(roomId, room.round, userId);
  if (!correct && secondChanceArmed.has(k2) && !secondChanceUsed.has(k2)) return { accepted: true, retry: true };
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
