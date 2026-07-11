import type { Router } from '../../http/router.js';
import { json } from '../../http/response.js';
import { nextQuestion } from '../../services/questionEngine.js';

export function registerQuestionRoutes(router: Router, base: string): void {
  router.add('GET', `${base}/questions/next`, async (ctx) => {
    const q = await nextQuestion();
    json(ctx.res, 200, { id: q.id, category: q.category, difficulty: q.difficulty, text: q.text, options: q.options, correctIndex: q.correctIndex });
  });
  router.add('POST', `${base}/questions/submit`, (ctx) => {
    json(ctx.res, 201, { status: 'pending', received: true });
  });
}
