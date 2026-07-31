import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { nextQuestion } from '../../services/questionEngine.js';
import { recordFeedback } from '../../services/questionPipelineService.js';
import { createReport, REPORT_REASONS } from '../../services/questionReportService.js';
import { repositories } from '../../repositories/index.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { getQuestionCounts, getQuestionDistribution } from '../../services/questionStatsService.js';

export function registerQuestionRoutes(router: Router, base: string): void {
  // Distinct categories actually present in the approved question bank, with a
  // count each, most-stocked first. The topic-pick screen shows a random subset
  // of these plus a "popular" (mixed) option, so every listed topic really has
  // questions behind it.
  router.add('GET', `${base}/questions/categories`, async (ctx) => {
    const questions = await repositories.questions.listApproved();
    const counts = new Map<string, number>();
    for (const q of questions) {
      const c = (q.category ?? '').trim();
      if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const categories = [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);
    json(ctx.res, 200, categories);
  });

  router.add('GET', `${base}/questions/next`, async (ctx) => {
    const q = await nextQuestion();
    json(ctx.res, 200, { id: q.id, category: q.category, difficulty: q.difficulty, text: q.text, options: q.options, correctIndex: q.correctIndex });
  });
  router.add('POST', `${base}/questions/submit`, (ctx) => {
    json(ctx.res, 201, { status: 'pending', received: true });
  });

  // Player feedback on a question (too hard/easy, wrong answer, duplicate,
  // report). Feeds the pipeline; a question crossing the report threshold is
  // auto-retired from the live bank for review.
  router.add('POST', `${base}/questions/:id/feedback`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'Login required.');
    const type = String((ctx.body as any)?.type ?? '');
    try {
      const r = await recordFeedback(ctx.params.id!, type as any);
      json(ctx.res, 200, r);
    } catch (e) {
      return error(ctx.res, 400, 'FEEDBACK_INVALID', e instanceof Error ? e.message : 'invalid');
    }
  });

  // The preset reasons the report sheet offers (code + Persian label). The client
  // renders these so labels stay server-driven and in sync with the admin queue.
  router.add('GET', `${base}/questions/report-reasons`, async (ctx) => {
    json(ctx.res, 200, REPORT_REASONS.map((r) => ({ code: r.code, label: r.label })));
  });

  // A player reports a problem with a question they saw in a match. Stored as an
  // individual report that lands in the admin review queue AND bumps the pipeline
  // feedback counter (auto-retire) via the service.
  /* ADMIN: real answer statistics for ONE question — the lifetime distribution
   * across EVERY game mode (duel, arena, all-or-nothing, last survivor). */
  router.add('GET', `${base}/admin/questions/:id/stats`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'questions' })) return;
    const q = await repositories.questions.findById(ctx.params.id!);
    if (!q) return error(ctx.res, 404, 'QUESTION_NOT_FOUND', 'سوال یافت نشد.');
    const { percents, sample } = await getQuestionDistribution(q.id, q.options.length);
    const counts = await getQuestionCounts(q.id, q.options.length);
    const correctCount = counts[q.correctIndex] ?? 0;
    json(ctx.res, 200, {
      id: q.id, text: q.text, options: q.options, correctIndex: q.correctIndex,
      category: q.category, difficulty: q.difficulty,
      counts, percents, sample,
      correctPercent: sample > 0 ? Math.round((correctCount / sample) * 100) : null
    });
  });

  /* ADMIN: bulk stats so the questions table can show real «استفاده» and
   * «٪ صحیح» columns without one request per row. */
  router.add('GET', `${base}/admin/questions/stats`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'questions' })) return;
    const all = await repositories.questions.listAll();
    const limit = Math.min(1000, Math.max(1, Number(ctx.query.get('limit') ?? 500)));
    const rows = [];
    for (const q of all.slice(0, limit)) {
      const counts = await getQuestionCounts(q.id, q.options.length);
      const sample = counts.reduce((s, c) => s + c, 0);
      rows.push({ id: q.id, sample, correctPercent: sample > 0 ? Math.round(((counts[q.correctIndex] ?? 0) / sample) * 100) : null });
    }
    json(ctx.res, 200, { rows });
  });

  router.add('POST', `${base}/questions/:id/report`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'Login required.');
    const body = (ctx.body as any) ?? {};
    try {
      const r = await createReport({
        questionId: ctx.params.id!,
        matchId: body.matchId ? String(body.matchId) : undefined,
        userId: ctx.userId,
        reason: String(body.reason ?? ''),
        note: body.note ? String(body.note) : undefined
      });
      json(ctx.res, 201, { id: r.id, status: r.status, reason: r.reason });
    } catch (e) {
      return error(ctx.res, 400, 'REPORT_INVALID', e instanceof Error ? e.message : 'invalid');
    }
  });
}
