import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { createMatch, getMatch, startMatch, submitAnswer } from '../../services/matchEngine.js';
import { validateAnswer } from '../../services/questionEngine.js';
import { repositories } from '../../repositories/index.js';
import type { GameModeId, PlanType } from '../../types/domain.js';

// Deterministic string hash so both players in a match derive the SAME
// question list from the same matchId — no shared state required.
function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function registerMatchRoutes(router: Router, base: string): void {
  router.add('POST', `${base}/matches`, async (ctx) => {
    const body = ctx.body as any;
    const match = await createMatch(ctx.userId ?? 'u1', body.modeId as GameModeId, body.economyType as PlanType, body.entry?.coinStake);
    json(ctx.res, 201, { matchId: match.id, status: match.phase, configVersion: match.configVersion });
  });

  // Same question for the same (matchId, round) for BOTH players. Callable
  // repeatedly (idempotent) so polling clients always see identical content.
  router.add('GET', `${base}/matches/:id/question`, async (ctx) => {
    const round = Math.max(0, Math.floor(Number(ctx.query.get('round') ?? 0)) || 0);
    const questions = await repositories.questions.listApproved();
    if (!questions.length) return error(ctx.res, 404, 'NO_QUESTIONS', 'No approved questions available');
    const ordered = [...questions].sort((a, b) => a.id.localeCompare(b.id));
    const start = hashString(ctx.params.id!) % ordered.length;
    const q = ordered[(start + round) % ordered.length]!;
    json(ctx.res, 200, { id: q.id, text: q.text, options: q.options, correctIndex: q.correctIndex, category: q.category });
  });

  router.add('GET', `${base}/matches/:id`, async (ctx) => json(ctx.res, 200, toSnapshot(await getMatch(ctx.params.id!))));
  router.add('POST', `${base}/matches/:id/start`, async (ctx) => json(ctx.res, 200, toSnapshot(await startMatch(ctx.params.id!))));
  router.add('POST', `${base}/matches/:id/continue`, async (ctx) => json(ctx.res, 200, toSnapshot(await startMatch(ctx.params.id!))));
  router.add('POST', `${base}/matches/:id/exit`, async (ctx) => { const m = await getMatch(ctx.params.id!); m.phase = 'finished'; json(ctx.res, 200, toSnapshot(m)); });

  router.add('POST', `${base}/matches/:id/answer`, async (ctx) => {
    const body = ctx.body as any;
    const validation = await validateAnswer(body.questionId, body.selectedIndex);
    const { match, duplicate } = await submitAnswer({
      matchId: ctx.params.id!,
      userId: ctx.userId ?? 'u1',
      questionId: body.questionId,
      selectedIndex: Number(body.selectedIndex),
      round: body.round === undefined ? undefined : Number(body.round),
      correct: validation.correct,
      answerTimeMs: Number(body.answerTimeMs ?? 0),
      idempotencyKey: String(body.idempotencyKey ?? `${ctx.params.id}:${ctx.userId ?? 'u1'}:${body.round ?? body.questionId}:${body.selectedIndex}`)
    });
    json(ctx.res, 200, { correct: validation.correct, selectedIndex: body.selectedIndex, correctIndex: validation.correctIndex, score: match.players.find((p) => p.userId === (ctx.userId ?? 'u1'))?.score ?? 0, phase: match.phase, duplicate, events: [] });
  });
}

function toSnapshot(match: any) {
  return { matchId: match.id, modeId: match.modeId, phase: match.phase, round: match.round, timerSeconds: 10, players: match.players, rewardPreview: match.rewardPreview };
}
