import type { Router } from '../../http/router.js';
import { json } from '../../http/response.js';
import { nextQuestion } from '../../services/questionEngine.js';
import { repositories } from '../../repositories/index.js';

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
}
