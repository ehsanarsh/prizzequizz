import type { Router } from '../../http/router.js';
import { submitQuestion, mySubmissions, UserQuestionError } from '../../services/userQuestionService.js';
import { error, json } from '../../http/response.js';
import { nextQuestion } from '../../services/questionEngine.js';
import { recordFeedback } from '../../services/questionPipelineService.js';
import { createReport, REPORT_REASONS } from '../../services/questionReportService.js';
import { repositories } from '../../repositories/index.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { getQuestionCounts, getQuestionDistribution } from '../../services/questionStatsService.js';
import { makerCategoryList } from '../../services/configService.js';
import { categoryImageUrls } from '../../services/categoryImageService.js';

export function registerQuestionRoutes(router: Router, base: string): void {
  /* A player writes a question. It goes into the same pipeline the panel
   * reviews — the screen used to show a success message and drop it. */
  router.add('POST', `${base}/questions/submit`, async (ctx) => {
    /* The author is paid when the question is approved, so an anonymous
     * submission has nobody to pay — and would land in the panel with no name
     * against it. */
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'برای ارسال سؤال باید وارد شوی.');
    const b = (ctx.body ?? {}) as any;
    try {
      const r = await submitQuestion({
        userId: ctx.userId,
        text: String(b.text ?? ''),
        options: Array.isArray(b.options) ? b.options : [],
        correctIndex: Number(b.correctIndex ?? 0),
        category: b.category ? String(b.category) : undefined,
        difficulty: b.difficulty ? String(b.difficulty) : undefined
      });
      json(ctx.res, 201, r);
    } catch (e) {
      if (e instanceof UserQuestionError) return error(ctx.res, 422, e.code, e.message);
      throw e;
    }
  });
  router.add('GET', `${base}/questions/mine`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'Login required.');
    json(ctx.res, 200, { rows: await mySubmissions(ctx.userId) });
  });

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

  /* THE LIST THE QUIZ MAKER OPENS ON.
   *
   * It used to read Last Survivor's topic list, which is a different question:
   * that one says which topics are RUNNING ROOMS today, and it hides everything
   * else — so a player could not write a question about most of the game. This
   * is the game's own topic list, minus «تصادفی» and the toss bank, minus
   * anything the operator has switched off for the maker.
   *
   * The count is how many approved questions each topic already has. It is not
   * a gate — a topic with none is exactly where a new question is worth most —
   * it is only shown so the player can see where the thin subjects are. */
  router.add('GET', `${base}/questions/maker-topics`, async (ctx) => {
    const approved = await repositories.questions.listApproved();
    const counts = new Map<string, number>();
    for (const q of approved) {
      const c = (q.category ?? '').trim();
      if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const art = await categoryImageUrls().catch(() => ({} as Record<string, string>));
    const topics = makerCategoryList().map((c) => ({
      name: c.name, icon: c.icon, image: art[c.name] ?? '', questionCount: counts.get(c.name) ?? 0
    }));
    json(ctx.res, 200, { topics });
  });

  router.add('GET', `${base}/questions/next`, async (ctx) => {
    const q = await nextQuestion();
    json(ctx.res, 200, { id: q.id, category: q.category, difficulty: q.difficulty, text: q.text, options: q.options, correctIndex: q.correctIndex });
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
