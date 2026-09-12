/* ASKING THE MODEL FOR QUESTIONS AND ACTUALLY GETTING THEM INTO THE BANK.
 *
 * «باید همه کار رو در تولید سوال هوش مصنوعی انجام بده، فقط بعد از اتمام بگه n
 *  تعداد سوال طراحی شد و این سوالات به دیتابیس اضافه شد — ولی واقعا کار کنه.»
 *
 * What it used to do: ask the model, hand the drafts to the browser, and leave
 * them in a JavaScript variable for somebody to save one at a time. Changing
 * tab threw the lot away, because nothing had been written down.
 *
 * So the thing being tested is not «did the model answer» — it is «is it in the
 * bank afterwards», which is the only claim the operator is being given.
 *
 * The model is stubbed. A test that calls a real provider is a test that fails
 * when somebody's key runs out, and it could never be made to return the same
 * duplicate twice on purpose.
 *
 * Run: npx tsx src/tests/aiBatch.test.ts */
import assert from 'node:assert/strict';
import { aiRunBatch, BATCH_MAX, getMeta } from '../services/questionPipelineService.js';
import { repositories } from '../repositories/index.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

/* ── the model, played by the test ──────────────────────────────────────── */
const realFetch = globalThis.fetch;
let reply: (body: any) => any = () => ({ questions: [] });
let asked: any[] = [];
function serve(f: (body: any) => any): void {
  reply = f; asked = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    asked.push(body);
    const payload = reply(body);
    /* The shape the real API answers with — aiJson reads res.json() and joins
       the text blocks, so anything less is testing the stub, not the code. */
    const envelope = { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    return { ok: true, status: 200,
             json: async () => envelope,
             text: async () => JSON.stringify(envelope) } as any;
  }) as any;
}
/* QUESTIONS THAT ARE ACTUALLY DIFFERENT FROM EACH OTHER.
   The first draft of this file numbered one sentence — «سؤال شمارهٔ ۱ دربارهٔ
   تاریخ ایران چیست؟» — and every question was then a near-twin of every other.
   Dedup threw them out and the originality score dragged the quality gate down,
   which looked like the code failing and was the fixture being wrong. Each text
   is built from three unrelated words instead, so two of them share almost no
   trigrams; `n` alone decides the text, so the SAME n is deliberately the same
   question and that is what the duplicate tests lean on. */
const LET = 'ابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی';
function word(seed: number, len = 6): string {
  let s = '', x = (seed * 2654435761) % 2147483647;
  for (let i = 0; i < len; i++) { x = (x * 48271) % 2147483647; s += LET[x % LET.length]; }
  return s;
}
const qtext = (n: number) => `${word(n)} ${word(n + 7919)} ${word(n + 104729)} چیست؟`;
const q = (n: number, over: any = {}) => ({
  topic: 'تاریخ', difficulty: 'medium', question: qtext(n),
  options: [word(n + 11), word(n + 22), word(n + 33), word(n + 44)],
  correctAnswer: 0, explanation: 'توضیح ' + word(n + 55), ...over
});
/* A generator call asks for questions; reviewer and fact-checker are asked
   about one. They are told apart by what the prompt contains. */
function stage(body: any): 'gen' | 'review' | 'fact' {
  const user = String(body?.messages?.[0]?.content ?? '');
  if (user.startsWith('Create ')) return 'gen';
  if (user.startsWith('Fact-check')) return 'fact';
  return 'review';
}
const GOOD_REVIEW = { accuracy: 100, clarity: 100, grammar: 100, difficultyMatch: 100 };
const GOOD_FACT = { verified: true };

const KEEP = process.env.ANTHROPIC_API_KEY;

(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';

  await check('it asks, and what comes back is in the BANK, not in a variable', async () => {
    serve((b) => stage(b) === 'gen' ? { questions: [q(1), q(2), q(3)] } : stage(b) === 'fact' ? GOOD_FACT : GOOD_REVIEW);
    const r = await aiRunBatch({ topic: 'تاریخ', count: 3 });
    assert.equal(r.added, 3, 'three asked for, three added');
    assert.equal(r.questions.length, 3);
    for (const row of r.questions) {
      const saved = await repositories.questions.findById(row.id);
      assert.ok(saved, 'question ' + row.id + ' is not in the bank — the whole point');
      assert.equal(saved!.text, row.text);
    }
  });

  await check('and each one really went through every stage', async () => {
    serve((b) => stage(b) === 'gen' ? { questions: [q(10)] } : stage(b) === 'fact' ? GOOD_FACT : GOOD_REVIEW);
    const r = await aiRunBatch({ topic: 'تاریخ', count: 1 });
    const m = await getMeta(r.questions[0]!.id);
    assert.ok(m, 'no pipeline record at all');
    assert.ok(m!.aiReview, 'never reviewed');
    assert.ok(m!.factCheck, 'never fact-checked');
    assert.ok(m!.duplicate, 'never checked against the bank');
    assert.equal(m!.stage, 'approved');
  });

  await check('a question already in the bank is not added a second time', async () => {
    /* «خود هوش مصنوعی باید با دیتابیسمون چک کنه که این سوال وجود داره یا نه.» */
    serve((b) => stage(b) === 'gen' ? { questions: [q(20)] } : stage(b) === 'fact' ? GOOD_FACT : GOOD_REVIEW);
    const first = await aiRunBatch({ topic: 'تاریخ', count: 1 });
    assert.equal(first.added, 1);
    serve((b) => stage(b) === 'gen' ? { questions: [q(20)] } : stage(b) === 'fact' ? GOOD_FACT : GOOD_REVIEW);
    const again = await aiRunBatch({ topic: 'تاریخ', count: 1 });
    assert.equal(again.added, 0, 'it was added twice');
    assert.equal(again.skipped[0]?.reason, 'duplicate');
  });

  await check('and the duplicate is never WRITTEN, not merely unapproved', async () => {
    /* Checking after writing would leave the bank holding the very thing we
       decided not to keep. */
    const before = (await repositories.questions.listAll()).length;
    serve((b) => stage(b) === 'gen' ? { questions: [q(20)] } : stage(b) === 'fact' ? GOOD_FACT : GOOD_REVIEW);
    await aiRunBatch({ topic: 'تاریخ', count: 1 });
    assert.equal((await repositories.questions.listAll()).length, before, 'the bank grew anyway');
  });

  await check('a model that repeats itself inside ONE batch adds it once', async () => {
    serve((b) => stage(b) === 'gen' ? { questions: [q(30), q(30), q(30)] } : stage(b) === 'fact' ? GOOD_FACT : GOOD_REVIEW);
    const r = await aiRunBatch({ topic: 'تاریخ', count: 3 });
    assert.equal(r.added, 1, 'asked for three, the model said the same thing three times');
    /* It asks again when the order is short, so it meets the same repeat more
       than once. What matters is that it only ever kept one of them. */
    assert.ok(r.skipped.filter((s) => s.reason === 'duplicate').length >= 2, 'the repeats were not named');
  });

  await check('a question the fact-check will not stand behind is held, not added', async () => {
    serve((b) => stage(b) === 'gen' ? { questions: [q(40)] } : stage(b) === 'fact' ? { verified: false, reason: 'wrong' } : GOOD_REVIEW);
    const r = await aiRunBatch({ topic: 'تاریخ', count: 1 });
    assert.equal(r.added, 0, 'a money game must not quietly ship an answer nobody could verify');
    assert.equal(r.pending, 1, 'but it is kept so somebody can look at it');
    assert.match(String(r.questions[0]?.reason), /تأیید نشد/);
  });

  await check('and so is one that scores too low', async () => {
    serve((b) => stage(b) === 'gen' ? { questions: [q(50)] } : stage(b) === 'fact' ? GOOD_FACT
      : { accuracy: 10, clarity: 10, grammar: 10, difficultyMatch: 10 });
    const r = await aiRunBatch({ topic: 'تاریخ', count: 1 });
    assert.equal(r.added, 0);
    assert.match(String(r.questions[0]?.reason), /کیفیت/);
  });

  await check('a malformed question is dropped and named, not written', async () => {
    serve((b) => stage(b) === 'gen'
      ? { questions: [q(60), { ...q(61), options: ['فقط', 'دو'] }, { ...q(62), correctAnswer: 9 }] }
      : stage(b) === 'fact' ? GOOD_FACT : GOOD_REVIEW);
    const r = await aiRunBatch({ topic: 'تاریخ', count: 3 });
    assert.equal(r.added, 1, 'only the whole one');
    assert.ok(r.skipped.filter((s) => s.reason === 'malformed').length >= 2,
      'the broken ones have to be named, not silently dropped');
    assert.equal(r.questions.length, 1, 'and only the whole one was written');
  });

  await check('asking for more than the model returns at once still fills the order', async () => {
    let n = 100;
    serve((b) => stage(b) === 'gen' ? { questions: [q(n++), q(n++)] } : stage(b) === 'fact' ? GOOD_FACT : GOOD_REVIEW);
    const r = await aiRunBatch({ topic: 'تاریخ', count: 6 });
    assert.equal(r.added, 6, 'the model gave two at a time; it should have been asked again');
  });

  await check('and a model that keeps giving nothing does not hang the run', async () => {
    serve((b) => stage(b) === 'gen' ? { questions: [] } : stage(b) === 'fact' ? GOOD_FACT : GOOD_REVIEW);
    const r = await aiRunBatch({ topic: 'تاریخ', count: 5 });
    assert.equal(r.added, 0);
    assert.ok(asked.length <= 6, 'it kept asking forever: ' + asked.length + ' calls');
  });

  await check('the order is capped, however many are asked for', async () => {
    let n = 200;
    serve((b) => stage(b) === 'gen' ? { questions: Array.from({ length: 10 }, () => q(n++)) } : stage(b) === 'fact' ? GOOD_FACT : GOOD_REVIEW);
    const r = await aiRunBatch({ topic: 'تاریخ', count: 9999 });
    assert.equal(r.requested, BATCH_MAX, 'an unbounded run is real money at the provider');
    assert.ok(r.added <= BATCH_MAX);
  });

  await check('with autoApprove off, nothing is approved but everything is kept', async () => {
    let n = 300;
    serve((b) => stage(b) === 'gen' ? { questions: [q(n++), q(n++)] } : stage(b) === 'fact' ? GOOD_FACT : GOOD_REVIEW);
    const r = await aiRunBatch({ topic: 'تاریخ', count: 2, autoApprove: false });
    assert.equal(r.added, 0);
    assert.equal(r.pending, 2);
    for (const row of r.questions) assert.ok(await repositories.questions.findById(row.id), 'still has to be saved');
  });

  await check('every question it reports can be found and deleted', async () => {
    /* «بتونیم سوالات رو ببینیم و حذف کنیم» — the id is what makes that possible,
       so it has to be a real one. */
    let n = 400;
    serve((b) => stage(b) === 'gen' ? { questions: [q(n++)] } : stage(b) === 'fact' ? GOOD_FACT : GOOD_REVIEW);
    const r = await aiRunBatch({ topic: 'تاریخ', count: 1 });
    const idq = r.questions[0]!.id;
    assert.ok(await repositories.questions.findById(idq));
    await repositories.questions.remove(idq);
    assert.equal(await repositories.questions.findById(idq), null);
  });

  /* ── WHAT MODELS ACTUALLY SEND BACK ────────────────────────────────
   * «تولید سوال کار نمیکنه، مینویسه ۰ سوال تولید شد.» The reader demanded one
   * exact shape and dropped everything else in silence — so a model that had
   * answered perfectly well, in slightly different clothes, produced a zero
   * with no reason attached. A zero that cannot say why is the same message
   * whether the key is wrong, the model id does not exist, or the answers came
   * back keyed differently, and those need three different fixes. */

  await check('an answer index sent as a STRING is still an answer', async () => {
    let n = 500;
    serve((b) => stage(b) === 'gen' ? { questions: [{ ...q(n++), correctAnswer: '2' }] } : stage(b) === 'fact' ? GOOD_FACT : GOOD_REVIEW);
    const r = await aiRunBatch({ topic: 'تاریخ', count: 1 });
    assert.equal(r.added, 1, 'a quotation mark is not a broken question');
  });

  await check('and so is one under a snake_case key', async () => {
    let n = 510;
    serve((b) => { if (stage(b) !== 'gen') return stage(b) === 'fact' ? GOOD_FACT : GOOD_REVIEW;
      const d: any = q(n++); const idx = d.correctAnswer; delete d.correctAnswer; d.correct_answer = idx; return { questions: [d] }; });
    const r = await aiRunBatch({ topic: 'تاریخ', count: 1 });
    assert.equal(r.added, 1);
  });

  await check('a lettered answer is read as the option it points at', async () => {
    let n = 520;
    serve((b) => stage(b) === 'gen' ? { questions: [{ ...q(n++), correctAnswer: 'C' }] } : stage(b) === 'fact' ? GOOD_FACT : GOOD_REVIEW);
    const r = await aiRunBatch({ topic: 'تاریخ', count: 1 });
    assert.equal(r.added, 1);
  });

  await check('and so is one given as the correct option’s own words', async () => {
    let n = 530;
    serve((b) => { if (stage(b) !== 'gen') return stage(b) === 'fact' ? GOOD_FACT : GOOD_REVIEW;
      const d: any = q(n++); d.correctAnswer = d.options[1]; return { questions: [d] }; });
    const r = await aiRunBatch({ topic: 'تاریخ', count: 1 });
    assert.equal(r.added, 1);
  });

  await check('options given as {a,b,c,d} are options', async () => {
    let n = 540;
    serve((b) => { if (stage(b) !== 'gen') return stage(b) === 'fact' ? GOOD_FACT : GOOD_REVIEW;
      const d: any = q(n++); const o = d.options;
      d.options = { a: o[0], b: o[1], c: o[2], d: o[3] }; return { questions: [d] }; });
    const r = await aiRunBatch({ topic: 'تاریخ', count: 1 });
    assert.equal(r.added, 1);
  });

  await check('a one-based answer is not read as the wrong option', async () => {
    /* 4 with four options can only be the fourth. Reading it as an index would
       silently make every such question wrong — worse than refusing it. */
    let n = 550;
    serve((b) => stage(b) === 'gen' ? { questions: [{ ...q(n++), correctAnswer: 4 }] } : stage(b) === 'fact' ? GOOD_FACT : GOOD_REVIEW);
    const r = await aiRunBatch({ topic: 'تاریخ', count: 1 });
    assert.equal(r.added, 1);
    const saved = await repositories.questions.findById(r.questions[0]!.id);
    assert.equal(saved!.correctIndex, 3, 'it must point at the LAST option, not past the end');
  });

  await check('A ZERO IS NEVER BARE — it says what the model sent', async () => {
    serve((b) => stage(b) === 'gen' ? { questions: [{ question: 'سؤالی بدون گزینه' }] } : stage(b) === 'fact' ? GOOD_FACT : GOOD_REVIEW);
    const r = await aiRunBatch({ topic: 'تاریخ', count: 1 });
    assert.equal(r.added, 0);
    assert.ok(r.error, 'a zero with no reason is indistinguishable from a broken key');
    assert.match(String(r.error), /گزینه/, 'and the reason has to name the actual problem: ' + r.error);
    assert.ok(r.skipped.length >= 1, 'the thing the model sent has to be shown');
  });

  await check('and an unreadable answer says THAT, not something else', async () => {
    let n = 560;
    serve((b) => stage(b) === 'gen' ? { questions: [{ ...q(n++), correctAnswer: 'شاید' }] } : stage(b) === 'fact' ? GOOD_FACT : GOOD_REVIEW);
    const r = await aiRunBatch({ topic: 'تاریخ', count: 1 });
    assert.equal(r.added, 0);
    assert.match(String(r.error), /جواب درست/, r.error || '');
  });

  await check('with no key it says so instead of pretending', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await aiRunBatch({ topic: 'تاریخ', count: 3 });
    assert.equal(r.configured, false);
    assert.equal(r.added, 0);
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  globalThis.fetch = realFetch;
  if (KEEP === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = KEEP;
  console.log(`[aiBatch] ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
