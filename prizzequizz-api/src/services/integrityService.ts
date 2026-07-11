import { repositories } from '../repositories/index.js';
import type { AnswerSubmission, IntegritySeverity, IntegritySignal, IntegritySignalType, IntegrityStatus, Match } from '../types/domain.js';
import { id } from '../utils/id.js';
import { logger } from './logger.js';

export interface InspectAnswerInput {
  match: Match;
  userId: string;
  questionId: string;
  selectedIndex: number;
  correct: boolean;
  answerTimeMs: number;
  idempotencyKey: string;
}

export interface IntegrityDiagnostics {
  totalSignals: number;
  openSignals: number;
  criticalSignals: number;
  reviewingSignals: number;
  confirmedSignals: number;
  dismissedSignals: number;
  avgRiskScore: number;
  topSignalTypes: Array<{ type: IntegritySignalType; count: number }>;
  topRiskUsers: Array<{ userId: string; riskScore: number; signals: number }>;
}

export class IntegrityService {
  async inspectAnswer(input: InspectAnswerInput): Promise<IntegritySignal[]> {
    if (input.userId.startsWith('bot_')) return [];
    const signals: IntegritySignal[] = [];
    const previous = await repositories.answers.listByMatch(input.match.id);
    const userPrevious = previous.filter((answer) => answer.userId === input.userId);

    if (input.answerTimeMs < 250) {
      signals.push(this.build(input, 'IMPOSSIBLE_ANSWER_TIME', 'critical', 90, { thresholdMs: 250, answerTimeMs: input.answerTimeMs }));
    } else if (input.correct && input.answerTimeMs < 800) {
      signals.push(this.build(input, 'FAST_CORRECT_ANSWER', 'warn', 45, { thresholdMs: 800, answerTimeMs: input.answerTimeMs }));
    }

    if (userPrevious.some((answer) => answer.questionId === input.questionId)) {
      signals.push(this.build(input, 'REPEATED_QUESTION_ANSWER', 'warn', 35, { questionId: input.questionId, previousAnswers: userPrevious.filter((a) => a.questionId === input.questionId).length }));
    }

    const now = Date.now();
    const burstWindow = userPrevious.filter((answer) => now - new Date(answer.createdAt).getTime() < 7_000);
    if (burstWindow.length >= 2) {
      signals.push(this.build(input, 'ANSWER_BURST', 'critical', 75, { windowMs: 7000, previousAnswersInWindow: burstWindow.length, answerTimeMs: input.answerTimeMs }));
    }

    await Promise.all(signals.map((signal) => this.save(signal)));
    return signals;
  }

  async recordReplay(input: { matchId: string; userId: string; questionId?: string; idempotencyKey: string }): Promise<IntegritySignal> {
    const signal: IntegritySignal = {
      id: id(),
      matchId: input.matchId,
      userId: input.userId,
      questionId: input.questionId,
      type: 'IDEMPOTENCY_REPLAY',
      severity: 'info',
      riskScore: 20,
      status: 'open',
      evidence: { idempotencyKey: input.idempotencyKey },
      createdAt: new Date().toISOString()
    };
    await this.save(signal);
    return signal;
  }

  async inspectMatchFinished(match: Match): Promise<IntegritySignal[]> {
    const signals: IntegritySignal[] = [];
    const answers = await repositories.answers.listByMatch(match.id);
    for (const player of match.players) {
      if (player.userId.startsWith('bot_')) continue;
      const userAnswers = answers.filter((a) => a.userId === player.userId);
      const correctAnswers = userAnswers.filter((a) => a.correct);
      const avgMs = average(userAnswers.map((a) => a.answerTimeMs));
      if (userAnswers.length >= 4 && correctAnswers.length === userAnswers.length && avgMs > 0 && avgMs < 1200) {
        signals.push({
          id: id(),
          matchId: match.id,
          userId: player.userId,
          type: 'PERFECT_FAST_MATCH',
          severity: 'critical',
          riskScore: 85,
          status: 'open',
          evidence: { answers: userAnswers.length, correctAnswers: correctAnswers.length, avgAnswerTimeMs: Math.round(avgMs), score: player.score },
          createdAt: new Date().toISOString()
        });
      }
      if (player.score > match.round || player.correctAnswers > match.round) {
        signals.push({
          id: id(),
          matchId: match.id,
          userId: player.userId,
          type: 'SCORE_ANOMALY',
          severity: 'critical',
          riskScore: 95,
          status: 'open',
          evidence: { score: player.score, correctAnswers: player.correctAnswers, matchRound: match.round },
          createdAt: new Date().toISOString()
        });
      }
    }
    await Promise.all(signals.map((signal) => this.save(signal)));
    return signals;
  }

  async list(filter: { userId?: string; matchId?: string; status?: IntegrityStatus; severity?: IntegritySeverity; limit?: number } = {}): Promise<IntegritySignal[]> {
    return repositories.integrity.list(filter);
  }

  async updateStatus(id: string, status: IntegrityStatus, reviewedBy: string): Promise<IntegritySignal | null> {
    return repositories.integrity.updateStatus(id, status, reviewedBy);
  }

  async diagnostics(): Promise<IntegrityDiagnostics> {
    const signals = await repositories.integrity.list({ limit: 500 });
    const avgRiskScore = signals.length ? Math.round(signals.reduce((sum, signal) => sum + signal.riskScore, 0) / signals.length) : 0;
    return {
      totalSignals: signals.length,
      openSignals: signals.filter((s) => s.status === 'open').length,
      criticalSignals: signals.filter((s) => s.severity === 'critical').length,
      reviewingSignals: signals.filter((s) => s.status === 'reviewing').length,
      confirmedSignals: signals.filter((s) => s.status === 'confirmed').length,
      dismissedSignals: signals.filter((s) => s.status === 'dismissed').length,
      avgRiskScore,
      topSignalTypes: topCounts(signals.map((s) => s.type)).map(([type, count]) => ({ type: type as IntegritySignalType, count })),
      topRiskUsers: topRiskUsers(signals)
    };
  }

  private build(input: InspectAnswerInput, type: IntegritySignalType, severity: IntegritySeverity, riskScore: number, evidence: Record<string, unknown>): IntegritySignal {
    return {
      id: id(),
      matchId: input.match.id,
      userId: input.userId,
      questionId: input.questionId,
      type,
      severity,
      riskScore,
      status: 'open',
      evidence: { ...evidence, selectedIndex: input.selectedIndex, correct: input.correct, round: input.match.round, idempotencyKey: input.idempotencyKey },
      createdAt: new Date().toISOString()
    };
  }

  private async save(signal: IntegritySignal): Promise<void> {
    await repositories.integrity.save(signal);
    logger.warn('integrity_signal', { id: signal.id, matchId: signal.matchId, userId: signal.userId, type: signal.type, severity: signal.severity, riskScore: signal.riskScore });
  }
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

function topCounts(values: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
}

function topRiskUsers(signals: IntegritySignal[]): Array<{ userId: string; riskScore: number; signals: number }> {
  const byUser = new Map<string, { riskScore: number; signals: number }>();
  for (const signal of signals) {
    const current = byUser.get(signal.userId) ?? { riskScore: 0, signals: 0 };
    current.riskScore += signal.riskScore;
    current.signals += 1;
    byUser.set(signal.userId, current);
  }
  return [...byUser.entries()].map(([userId, data]) => ({ userId, ...data })).sort((a, b) => b.riskScore - a.riskScore).slice(0, 10);
}

export const integrity = new IntegrityService();
