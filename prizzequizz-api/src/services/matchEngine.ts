import { gameConfig } from '../core/config.js';
import { repositories } from '../repositories/index.js';
import { chargeEntry } from './economyEngine.js';
import { applyReward, calculateDuelReward, duelStake } from './rewardEngine.js';
import { postEntry } from './walletLedgerService.js';
import { activeMatchState } from './matchStateStore.js';
import { updateSkillAfterMatch } from './skillRating.js';
import { notifications } from './notificationService.js';
import { integrity } from './integrityService.js';
import { leaderboards } from './leaderboardService.js';
import { PZ_SCORING, isoWeekId, levelForXp } from './scoringConfig.js';
import { getPgPool } from '../database/postgres.js';
import type { GameModeId, Match, MatchEvent, MatchPlayer, PlanType } from '../types/domain.js';
import { id } from '../utils/id.js';

// Persist an XP + weekly-cup award to a user, resetting the weekly cup when the
// ISO week rolls over — done in ONE atomic UPDATE so concurrent match-ends can't
// lose-update. Falls back to the repository (dev/memory driver) if there is no
// Postgres pool. Returns the user's new totals.
let _scoringSchemaReady = false;
async function ensureScoringSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_scoringSchemaReady) return;
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_week VARCHAR(8) NOT NULL DEFAULT ''`);
  _scoringSchemaReady = true;
}
async function awardScoring(userId: string, xp: number, cup: number): Promise<{ xp: number; cup: number; level: number }> {
  const week = isoWeekId();
  try {
    const pool = getPgPool();
    await ensureScoringSchema(pool);
    const { rows } = await pool.query(
      `UPDATE users SET
         xp = xp + $2,
         weekly_score = CASE WHEN weekly_week = $4 THEN weekly_score + $3 ELSE $3 END,
         weekly_week = $4,
         level = GREATEST(1, floor(sqrt((xp + $2) / 100.0))::int + 1),
         updated_at = now()
       WHERE id = $1
       RETURNING xp, weekly_score, level`,
      [userId, xp, cup, week]
    );
    const r = rows[0];
    if (r) return { xp: Number(r.xp), cup: Number(r.weekly_score), level: Number(r.level) };
  } catch { /* no pg pool (memory driver) → fall back below */ }
  const u = await repositories.users.findById(userId);
  if (!u) return { xp, cup, level: 1 };
  u.xp = Number(u.xp ?? 0) + xp;
  u.weeklyScore = Number(u.weeklyScore ?? 0) + cup; // memory mode: no weekly reset
  u.level = levelForXp(u.xp);
  await repositories.users.save(u);
  return { xp: u.xp, cup: u.weeklyScore, level: u.level };
}

export async function createMatch(userId: string, modeId: GameModeId, economyType: PlanType, coinStake?: number): Promise<Match> {
  return createMatchForPlayers(userId, 'op1', modeId, economyType, coinStake, true);
}

export async function createMatchForPlayers(userId: string, opponentUserId: string, modeId: GameModeId, economyType: PlanType, coinStake?: number, opponentIsBot = false, botProfile?: { username?: string; avatar?: string; skill?: number }): Promise<Match> {
  const user = await repositories.users.findById(userId);
  if (!user) throw new Error('USER_NOT_FOUND');
  // The client already gates entry (hearts/wallet) before enqueue, so a
  // shortfall here must not crash matchmaking — free and paid both proceed.
  try { await chargeEntry(user, modeId, economyType, coinStake); } catch { /* client-gated entry */ }

  let opponentUser = await repositories.users.findById(opponentUserId);
  if (!opponentUser) {
    opponentUser = { id: opponentUserId, phone: `mock-${opponentUserId}`, username: opponentIsBot ? (botProfile?.username ?? 'Bot Rival') : 'Opponent', displayName: opponentIsBot ? (botProfile?.username ?? 'ربات تمرینی') : 'حریف', plan: economyType, level: 3, xp: 0, weeklyScore: 0, wallet: 0, coins: 0, hearts: 0, tickets: { bronze: 0, silver: 0, gold: 0 } };
    await repositories.users.save(opponentUser);
  } else if (!opponentIsBot) {
    try { await chargeEntry(opponentUser, modeId, economyType, coinStake); } catch { /* Keep matchmaking resilient in mock/dev mode. */ }
  }

  // Privacy: a player's PUBLIC handle (username) is what the other side sees —
  // never the real display name. Each client shows its own full name locally.
  const opponent: MatchPlayer = { userId: opponentUser.id, username: opponentIsBot ? (botProfile?.username || opponentUser.username) : opponentUser.username, avatar: opponentIsBot ? (botProfile?.avatar ?? '🤖') : '🦊', score: 0, correctAnswers: 0, wrongAnswers: 0 };
  const player: MatchPlayer = { userId: user.id, username: user.username, avatar: '🦁', score: 0, correctAnswers: 0, wrongAnswers: 0 };
  const now = new Date().toISOString();
  const match: Match = { id: id(), modeId, economyType, phase: 'matchmaking', round: 0, configVersion: gameConfig.version, players: [player, opponent], createdAt: now, updatedAt: now };
  await repositories.matches.save(match);
  await activeMatchState.set(match, 60 * 60);
  await appendMatchEvent(match.id, 'MATCH_CREATED', { modeId, economyType, opponentUserId: opponentUser.id, opponentIsBot });
  return match;
}

export async function getMatch(matchId: string): Promise<Match> {
  const match = (await activeMatchState.get(matchId)) ?? (await repositories.matches.findById(matchId));
  if (!match) throw new Error('MATCH_NOT_FOUND');
  return match;
}

export async function startMatch(matchId: string): Promise<Match> {
  const match = await getMatch(matchId);
  match.phase = 'question';
  match.updatedAt = new Date().toISOString();
  await repositories.matches.save(match);
  await activeMatchState.set(match, 60 * 60);
  await appendMatchEvent(match.id, 'MATCH_STARTED', { round: match.round });
  return match;
}

export interface SubmitAnswerInput {
  matchId: string;
  userId: string;
  questionId: string;
  selectedIndex: number;
  correct: boolean;
  answerTimeMs: number;
  idempotencyKey: string;
  /** Zero-based round this answer belongs to. If omitted it is derived from
   *  how many rounds this player has already answered. */
  round?: number;
}

const DUEL_BASE_ROUNDS = 10;     // two halves × 5 questions — the match must NOT
                                 // finish (and reject answers) after the first half
const DUEL_MAX_ROUNDS = 24;      // hard cap so a tie can never loop forever (base
                                 // 10 + up to 14 sudden-death/golden rounds)

// Serialize answer processing per match so two players submitting at nearly the
// same instant can't lose-update each other's scores (read-modify-write race).
const matchLocks = new Map<string, Promise<unknown>>();
function withMatchLock<T>(matchId: string, fn: () => Promise<T>): Promise<T> {
  const prev = matchLocks.get(matchId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  matchLocks.set(matchId, next.then(() => undefined, () => undefined));
  return next;
}

export function submitAnswer(input: SubmitAnswerInput): Promise<{ match: Match; duplicate: boolean }> {
  return withMatchLock(input.matchId, () => submitAnswerLocked(input));
}

async function submitAnswerLocked(input: SubmitAnswerInput): Promise<{ match: Match; duplicate: boolean }> {
  const existing = await repositories.answers.findByIdempotencyKey(input.idempotencyKey);
  if (existing) {
    await integrity.recordReplay({ matchId: input.matchId, userId: input.userId, questionId: input.questionId, idempotencyKey: input.idempotencyKey });
    return { match: await getMatch(input.matchId), duplicate: true };
  }

  const match = await getMatch(input.matchId);
  if (match.phase === 'result' || match.phase === 'finished') throw new Error('MATCH_NOT_ACCEPTING_ANSWERS');

  const integritySignals = await integrity.inspectAnswer({ match, userId: input.userId, questionId: input.questionId, selectedIndex: input.selectedIndex, correct: input.correct, answerTimeMs: input.answerTimeMs, idempotencyKey: input.idempotencyKey });

  if (!match.duelAnswers) match.duelAnswers = {};
  const player = match.players.find((p) => p.userId === input.userId) ?? match.players[0]!;

  // Resolve this answer's round: prefer the client-supplied round, else the
  // count of rounds this player has already answered (their next round).
  const answeredByPlayer = (uid: string): number => Object.keys(match.duelAnswers!).filter((k) => k.startsWith(`${uid}:`)).length;
  const round = Number.isInteger(input.round) ? Number(input.round) : answeredByPlayer(input.userId);
  const key = `${input.userId}:${round}`;

  // Score each player ONLY from their own answer, exactly once per (player, round).
  // No random/bot scoring for the opponent — their score comes from their own submits.
  if (!match.duelAnswers[key]) {
    match.duelAnswers[key] = { selectedIndex: input.selectedIndex, correct: input.correct };
    if (input.correct) { player.score += 1; player.correctAnswers += 1; } else player.wrongAnswers += 1;

    // --- Server-authoritative XP + 🏆cup accumulation (difficulty / streak / speed) ---
    if (!match.duelPoints) match.duelPoints = {};
    if (!match.duelStreak) match.duelStreak = {};
    if (!match.duelFirstCorrect) match.duelFirstCorrect = {};
    const mult = match.economyType === 'paid' ? PZ_SCORING.paidMultiplier : 1;
    const pts = match.duelPoints[input.userId] ?? { xp: 0, cup: 0 };
    if (input.correct) {
      const q = await repositories.questions.findById(input.questionId).catch(() => null);
      const diff = (q && q.difficulty) ? q.difficulty : 'medium';
      const pq = PZ_SCORING.perQuestion[diff] ?? PZ_SCORING.perQuestion.medium!;
      pts.xp += pq.xp * mult; pts.cup += pq.cup * mult;
      const s = (match.duelStreak[input.userId] ?? 0) + 1;
      match.duelStreak[input.userId] = s;
      const sb = PZ_SCORING.streak.find((x) => x.n === s);
      if (sb) { pts.xp += sb.xp * mult; pts.cup += sb.cup * mult; }
      const rk = String(round);
      if (!match.duelFirstCorrect[rk]) { match.duelFirstCorrect[rk] = input.userId; pts.xp += PZ_SCORING.speedFirstCorrect.xp * mult; pts.cup += PZ_SCORING.speedFirstCorrect.cup * mult; }
    } else {
      match.duelStreak[input.userId] = 0;
      pts.xp += PZ_SCORING.perQuestion.wrong!.xp * mult;
      pts.cup += PZ_SCORING.perQuestion.wrong!.cup * mult;
    }
    match.duelPoints[input.userId] = pts;
  }

  await repositories.answers.save({ id: id(), matchId: input.matchId, userId: input.userId, questionId: input.questionId, selectedIndex: input.selectedIndex, correct: input.correct, answerTimeMs: input.answerTimeMs, idempotencyKey: input.idempotencyKey, createdAt: new Date().toISOString() });

  // Completion is decided only when every player has answered the SAME number of
  // rounds (lockstep) and that number has reached the base length: the leader wins.
  // A tie keeps the match in 'question' phase → sudden-death continues on the next
  // shared round. A hard cap guarantees termination.
  const counts = match.players.map((p) => answeredByPlayer(p.userId));
  const minCount = counts.length ? Math.min(...counts) : 0;
  const allEqual = counts.every((c) => c === minCount);
  match.round = minCount;

  const sorted = [...match.players].sort((a, b) => b.score - a.score);
  const decisiveLeader = sorted.length >= 2 && sorted[0]!.score !== sorted[1]!.score;
  const finished = allEqual && minCount >= DUEL_BASE_ROUNDS && (decisiveLeader || minCount >= DUEL_MAX_ROUNDS);

  match.phase = finished ? 'result' : 'question';
  match.updatedAt = new Date().toISOString();

  if (finished && !match.duelSettled) {
    match.duelSettled = true;
    match.winnerUserId = decisiveLeader ? sorted[0]!.userId : undefined; // undefined => draw (only at hard cap)
    // Pay the WINNER (looked up directly — not only when the finishing submit
    // happens to be the winner's own), exactly once via the reward idempotency.
    if (match.winnerUserId && !match.winnerUserId.startsWith('bot_')) {
      const winner = await repositories.users.findById(match.winnerUserId);
      if (winner) {
        try { await applyReward(winner, calculateDuelReward(match, winner), match.id); }
        catch { /* reward failure must never break match end; ledger stays consistent */ }
      }
    }
    // Paid draw → both stakes go back (idempotent per player per match).
    if (!match.winnerUserId && /^v\d+$/.test(String(match.economyType))) {
      const stake = duelStake(match);
      for (const p of match.players) {
        if (p.userId.startsWith('bot_')) continue;
        try {
          await postEntry({ userId: p.userId, entryType: 'stake_refund', kind: 'credit', amount: stake, idempotencyKey: `stake_refund_draw:${match.id}:${p.userId}`, refType: 'match', refId: match.id, description: 'برگشت ورودی: نتیجه مساوی' });
        } catch { /* refund failure is auditable via ledger absence; never break match end */ }
      }
    }

    // Award XP + weekly 🏆cup to BOTH players (server-authoritative → real, cheat-proof
    // leaderboard). Add the win/draw/loss bonus on top of the per-question total, apply
    // atomically (with weekly reset), sync the leaderboard, and expose the breakdown.
    match.duelPointsFinal = {};
    const outcomeMult = match.economyType === 'paid' ? PZ_SCORING.paidMultiplier : 1;
    for (const p of match.players) {
      if (p.userId.startsWith('bot_')) continue;
      const base = match.duelPoints?.[p.userId] ?? { xp: 0, cup: 0 };
      const outcome = !match.winnerUserId ? 'draw' : (match.winnerUserId === p.userId ? 'win' : 'loss');
      const rb = PZ_SCORING.result[outcome]!;
      const gainXp = base.xp + rb.xp * outcomeMult;
      const gainCup = base.cup + rb.cup * outcomeMult;
      try {
        const applied = await awardScoring(p.userId, gainXp, gainCup);
        match.duelPointsFinal[p.userId] = { xp: gainXp, cup: gainCup, result: outcome, totalXp: applied.xp, totalCup: applied.cup, level: applied.level };
        const u = await repositories.users.findById(p.userId);
        if (u) await leaderboards.updateUser(u);
      } catch { /* never let scoring break the match end */ }
    }

    await integrity.inspectMatchFinished(match);
    await updateSkillAfterMatch(match);
    await Promise.all(match.players.filter((p) => !p.userId.startsWith('bot_')).map((p) => notifications.create({ userId: p.userId, type: 'match_update', title: p.userId === match.winnerUserId ? 'بردی! 🎉' : 'نتیجه دوئل آماده است', body: p.userId === match.winnerUserId ? 'نتیجه عالی بود؛ جایزه و امتیاز تو ثبت شد.' : 'دوئل تمام شد؛ نتیجه و امتیاز تو ثبت شد.', data: { matchId: match.id, winnerUserId: match.winnerUserId, url: '/result' }, push: true })));
    await appendMatchEvent(match.id, 'MATCH_FINISHED', { winnerUserId: match.winnerUserId });
  }

  await repositories.matches.save(match);
  await activeMatchState.set(match, 60 * 60);
  await appendMatchEvent(match.id, 'ANSWER_SUBMITTED', { userId: input.userId, questionId: input.questionId, round, correct: input.correct, duplicate: false, integritySignals: integritySignals.length });
  return { match, duplicate: false };
}

export async function appendMatchEvent(matchId: string, type: string, payload: Record<string, unknown>): Promise<MatchEvent> {
  const event: MatchEvent = { id: id(), matchId, type, payload, createdAt: new Date().toISOString() };
  await repositories.matchEvents.append(event);
  return event;
}
