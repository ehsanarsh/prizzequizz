import { gameConfig } from '../core/config.js';
import { repositories } from '../repositories/index.js';
import { chargeEntry } from './economyEngine.js';
import { applyReward, calculateDuelReward } from './rewardEngine.js';
import { activeMatchState } from './matchStateStore.js';
import { updateSkillAfterMatch } from './skillRating.js';
import { notifications } from './notificationService.js';
import { integrity } from './integrityService.js';
import type { GameModeId, Match, MatchEvent, MatchPlayer, PlanType } from '../types/domain.js';
import { id } from '../utils/id.js';

export async function createMatch(userId: string, modeId: GameModeId, economyType: PlanType, coinStake?: number): Promise<Match> {
  return createMatchForPlayers(userId, 'op1', modeId, economyType, coinStake, true);
}

export async function createMatchForPlayers(userId: string, opponentUserId: string, modeId: GameModeId, economyType: PlanType, coinStake?: number, opponentIsBot = false, botProfile?: { username?: string; avatar?: string; skill?: number }): Promise<Match> {
  const user = await repositories.users.findById(userId);
  if (!user) throw new Error('USER_NOT_FOUND');
  await chargeEntry(user, modeId, economyType, coinStake);

  let opponentUser = await repositories.users.findById(opponentUserId);
  if (!opponentUser) {
    opponentUser = { id: opponentUserId, phone: `mock-${opponentUserId}`, username: opponentIsBot ? (botProfile?.username ?? 'Bot Rival') : 'Opponent', displayName: opponentIsBot ? (botProfile?.username ?? 'ربات تمرینی') : 'حریف', plan: economyType, level: 3, xp: 0, weeklyScore: 0, wallet: 0, coins: 0, hearts: 0, tickets: { bronze: 0, silver: 0, gold: 0 } };
    await repositories.users.save(opponentUser);
  } else if (!opponentIsBot) {
    try { await chargeEntry(opponentUser, modeId, economyType, coinStake); } catch { /* Keep matchmaking resilient in mock/dev mode. */ }
  }

  const opponent: MatchPlayer = { userId: opponentUser.id, username: opponentUser.displayName || opponentUser.username, avatar: opponentIsBot ? (botProfile?.avatar ?? '🤖') : '🦊', score: 0, correctAnswers: 0, wrongAnswers: 0 };
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

const DUEL_BASE_ROUNDS = 5;      // fixed-length portion of a duel
const DUEL_MAX_ROUNDS = 15;      // hard cap so a tie can never loop forever

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
    const user = await repositories.users.findById(input.userId);
    if (user && match.winnerUserId === input.userId) await applyReward(user, calculateDuelReward(match, user), match.id);
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
