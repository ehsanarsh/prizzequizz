/* RECORD MODE — endless run for a personal best, with its own ladders. */
import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import {
  RecordError, answerRun, answerStats, armSecondChance, fiftyFifty, leaderboard, overview, personalBest,
  quitRun, recordCategories, startRun,
  type RecordMode, type RecordPeriod
} from '../../services/recordModeService.js';
import { categoryImageUrls } from '../../services/categoryImageService.js';

function fail(res: any, e: unknown): boolean {
  if (e instanceof RecordError) {
    const status = e.code === 'INSUFFICIENT_HEARTS' || e.code === 'RUN_IN_PROGRESS' ? 409
      : e.code === 'RUN_NOT_FOUND' || e.code === 'QUESTION_NOT_FOUND' ? 404 : 422;
    error(res, status, e.code, e.message);
    return true;
  }
  return false;
}
const asMode = (v: unknown): RecordMode => (v === 'category' ? 'category' : 'global');
const asPeriod = (v: unknown): RecordPeriod =>
  (v === 'day' || v === 'week' || v === 'month' ? v : 'all');

export function registerRecordRoutes(router: Router, base: string): void {
  /* The pre-run screen: which topics have a table, the player's best on each,
   * the world best, and what entering costs. */
  router.add('GET', `${base}/record/overview`, async (ctx) => {
    json(ctx.res, 200, await overview(ctx.userId ?? 'u1'));
  });

  router.add('GET', `${base}/record/categories`, async (ctx) => {
    const art = await categoryImageUrls().catch(() => ({} as Record<string, string>));
    json(ctx.res, 200, {
      categories: recordCategories().map((c) => ({ ...c, image: art[c.name] ?? '' }))
    });
  });

  router.add('POST', `${base}/record/start`, async (ctx) => {
    const b = (ctx.body ?? {}) as any;
    try { json(ctx.res, 200, await startRun(ctx.userId ?? 'u1', asMode(b.mode), String(b.category ?? ''))); }
    catch (e) { if (!fail(ctx.res, e)) throw e; }
  });

  router.add('POST', `${base}/record/:runId/answer`, async (ctx) => {
    const b = (ctx.body ?? {}) as any;
    const idx = Number(b.selectedIndex);
    if (!Number.isInteger(idx) || idx < 0) return error(ctx.res, 422, 'BAD_ANSWER', 'گزینهٔ نامعتبر.');
    try { json(ctx.res, 200, await answerRun(ctx.params.runId!, ctx.userId ?? 'u1', idx)); }
    catch (e) { if (!fail(ctx.res, e)) throw e; }
  });

  /* Two wrong options for the 50/50 help. Only the server knows which they
   * are — sending the whole answer key to the client so it could work this out
   * itself would hand over every future answer too. */
  router.add('GET', `${base}/record/:runId/hint5050`, async (ctx) => {
    try { json(ctx.res, 200, await fiftyFifty(ctx.params.runId!, ctx.userId ?? 'u1')); }
    catch (e) { if (!fail(ctx.res, e)) throw e; }
  });

  /* «انتخاب دوم»: arm the retry. Nothing about the answer is revealed — the
   * help buys one wrong pick, it does not point at the right one. */
  router.add('POST', `${base}/record/:runId/second-chance`, async (ctx) => {
    try { json(ctx.res, 200, await armSecondChance(ctx.params.runId!, ctx.userId ?? 'u1')); }
    catch (e) { if (!fail(ctx.res, e)) throw e; }
  });

  /* «درصد بقیه»: the lifetime distribution for the question on screen.
   * Percentages only, and never which option is correct. */
  router.add('GET', `${base}/record/:runId/hintStats`, async (ctx) => {
    try { json(ctx.res, 200, await answerStats(ctx.params.runId!, ctx.userId ?? 'u1')); }
    catch (e) { if (!fail(ctx.res, e)) throw e; }
  });

  router.add('POST', `${base}/record/:runId/quit`, async (ctx) => {
    try { json(ctx.res, 200, await quitRun(ctx.params.runId!, ctx.userId ?? 'u1')); }
    catch (e) { if (!fail(ctx.res, e)) throw e; }
  });

  router.add('GET', `${base}/record/leaderboard`, async (ctx) => {
    const q = ctx.query;
    json(ctx.res, 200, await leaderboard({
      mode: asMode(q.get('mode')),
      category: q.get('category') ?? '',
      period: asPeriod(q.get('period')),
      limit: Math.min(200, Math.max(1, Number(q.get('limit')) || 100)),
      userId: ctx.userId ?? 'u1'
    }));
  });

  router.add('GET', `${base}/record/best`, async (ctx) => {
    const q = ctx.query;
    const mode = asMode(q.get('mode'));
    const category = q.get('category') ?? '';
    json(ctx.res, 200, { best: await personalBest(ctx.userId ?? 'u1', mode, category) });
  });
}
