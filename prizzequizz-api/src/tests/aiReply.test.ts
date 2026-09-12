/* WHAT THE MODEL ACTUALLY SENDS BACK — AND WHY «۰ سؤال تولید شد» KEPT HAPPENING.
 *
 * «همه مدل‌ها وصل می‌شن ولی وقتی می‌زنم تولید سوال می‌گه صفر سوال تولید شد.»
 *
 * That combination is the whole clue: the connection test asks for
 * {"ok":true} with a 32-token cap and every model passes it, so the key, the
 * host, the endpoint and the model id are all fine. Everything that breaks
 * breaks between «the model answered» and «here are the questions», and the
 * run reported a zero with no reason — which is the one outcome nobody can act
 * on. Each case below is a real answer shape that produced that silent zero.
 *
 * The model is stubbed: a test that calls a real provider fails when somebody's
 * key runs out and can never be made to truncate a reply on purpose.
 *
 * Run: npx tsx src/tests/aiReply.test.ts */
import assert from 'node:assert/strict';
import { aiJson, wasTruncated } from '../services/aiClient.js';
import { aiRunBatch, findDrafts } from '../services/questionPipelineService.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const realFetch = globalThis.fetch;
let asked: any[] = [];

/** Answer every call with this exact HTTP body, whatever was asked. */
function serveRaw(make: (body: any) => any): void {
  asked = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    asked.push(body);
    const envelope = make(body);
    return { ok: true, status: 200, json: async () => envelope, text: async () => JSON.stringify(envelope) } as any;
  }) as any;
}
/** The Anthropic answer shape, carrying `text` and stopping for `stop`. */
const anth = (text: string, stop = 'end_turn') => () => ({ content: [{ type: 'text', text }], stop_reason: stop });
/** The OpenAI Chat Completions answer shape. */
const oai = (content: any, finish = 'stop') => () => ({ choices: [{ message: { content }, finish_reason: finish }] });

const LET = 'ابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی';
function word(seed: number, len = 6): string {
  let s = '', x = (seed * 2654435761) % 2147483647;
  for (let i = 0; i < len; i++) { x = (x * 48271) % 2147483647; s += LET[x % LET.length]; }
  return s;
}
const q = (n: number) => ({
  topic: 'تاریخ', difficulty: 'medium', question: `${word(n)} ${word(n + 7919)} ${word(n + 104729)} چیست؟`,
  options: [word(n + 11), word(n + 22), word(n + 33), word(n + 44)],
  correctAnswer: 0, explanation: 'توضیح ' + word(n + 55)
});
function stage(body: any): 'gen' | 'review' | 'fact' {
  const user = String(body?.messages?.[0]?.content ?? '');
  if (user.startsWith('Create ')) return 'gen';
  if (user.startsWith('Fact-check')) return 'fact';
  return 'review';
}
const GOOD_REVIEW = { accuracy: 100, clarity: 100, grammar: 100, difficultyMatch: 100 };
const GOOD_FACT = { verified: true };
/** A generator that answers with `payload`, and passes every later stage. */
function generatorSays(payload: unknown, stop = 'end_turn'): void {
  serveRaw((b) => {
    const s = stage(b);
    const out = s === 'gen' ? payload : s === 'fact' ? GOOD_FACT : GOOD_REVIEW;
    return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }],
             stop_reason: s === 'gen' ? stop : 'end_turn' };
  });
}

const KEEP = process.env.ANTHROPIC_API_KEY;

(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';

  /* ── READING THE REPLY ──────────────────────────────────────────────── */

  await check('a bare JSON array is JSON', async () => {
    /* «Return the questions» is reasonably answered with `[{…},{…}]`, and the
       reader only ever looked for `{` … `}`: the first brace is inside the
       first element, so the slice that came out was never valid and the whole
       reply was thrown away as «non-JSON». */
    serveRaw(anth('[{"question":"الف"},{"question":"ب"}]'));
    const r = await aiJson({ model: 'claude-sonnet-5', system: 's', user: 'u' });
    assert.ok(r.ok, 'a top-level array was refused: ' + r.error);
    assert.ok(Array.isArray(r.data), 'it did not come back as an array');
    assert.equal((r.data as any[]).length, 2);
  });

  await check('and an object still is', async () => {
    serveRaw(anth('{"questions":[{"question":"الف"}]}'));
    const r = await aiJson({ model: 'claude-sonnet-5', system: 's', user: 'u' });
    assert.ok(r.ok, String(r.error));
    assert.equal((r.data as any).questions.length, 1);
  });

  await check('prose wrapped around the JSON is stepped over', async () => {
    serveRaw(anth('البته! این هم سؤال‌ها:\n```json\n{"questions":[{"question":"الف"}]}\n```\nموفق باشی'));
    const r = await aiJson({ model: 'claude-sonnet-5', system: 's', user: 'u' });
    assert.ok(r.ok, String(r.error));
    assert.equal((r.data as any).questions.length, 1);
  });

  await check('a reply cut off at the token cap SAYS it was cut off', async () => {
    /* The one cause that cannot be guessed from a parse failure — and the fix
       is a number, not a key or a model. It used to read «AI returned
       non-JSON», which points at the model instead. */
    serveRaw(anth('{"questions":[{"question":"الف","options":["a","b","c"', 'max_tokens'));
    const r = await aiJson({ model: 'claude-sonnet-5', system: 's', user: 'u' });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /قطع شد|سقف توکن/, r.error || '');
    assert.ok(wasTruncated(r.stop), 'the stop reason was not carried out: ' + r.stop);
  });

  await check('an empty answer says THAT, which is a different fault', async () => {
    serveRaw(anth(''));
    const r = await aiJson({ model: 'claude-sonnet-5', system: 's', user: 'u' });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /خالی/, r.error || '');
  });

  await check('and prose with no JSON in it is quoted back', async () => {
    serveRaw(anth('متأسفم، نمی‌توانم در این مورد کمک کنم.'));
    const r = await aiJson({ model: 'claude-sonnet-5', system: 's', user: 'u' });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /نمی‌توانم/, 'the model’s own words are the answer: ' + r.error);
  });

  await check('the OpenAI answer shape is read too', async () => {
    serveRaw(oai('{"questions":[{"question":"الف"}]}'));
    const r = await aiJson({ model: 't-gpt-5.5', system: 's', user: 'u' });
    assert.ok(r.ok, String(r.error));
    assert.equal((r.data as any).questions.length, 1);
    assert.ok(asked[0]!.messages.length === 2, 'chat completions carries the system prompt as a message');
  });

  await check('including a reasoning model that leaves `content` empty', async () => {
    /* Its answer is in the thinking channel. Reading one field turned that into
       «the model said nothing», which is a different problem with a different
       fix — and there is nothing wrong with the model. */
    serveRaw(() => ({ choices: [{ message: { content: '', reasoning_content: '{"questions":[{"question":"الف"}]}' }, finish_reason: 'stop' }] }));
    const r = await aiJson({ model: 't-gpt-5.5', system: 's', user: 'u' });
    assert.ok(r.ok, String(r.error));
    assert.equal((r.data as any).questions.length, 1);
  });

  await check('and one that splits the content into parts', async () => {
    serveRaw(oai([{ type: 'text', text: '{"questions":' }, { type: 'text', text: '[{"question":"الف"}]}' }]));
    const r = await aiJson({ model: 't-gpt-5.5', system: 's', user: 'u' });
    assert.ok(r.ok, String(r.error));
    assert.equal((r.data as any).questions.length, 1);
  });

  /* ── FINDING THE LIST ───────────────────────────────────────────────── */

  await check('the list is found under the key it was asked for', () => {
    assert.equal(findDrafts({ questions: [q(1), q(2)] }).length, 2);
  });

  await check('and under a key the model chose for itself', () => {
    /* `{"quiz":[…]}` answers the question that was asked. Looking only at
       `questions` and `items` read it as «no questions at all» — no drafts,
       nothing dropped, no error, and a zero nobody could explain. */
    assert.equal(findDrafts({ quiz: [q(1)] }).length, 1);
    assert.equal(findDrafts({ result: { questions: [q(1), q(2)] } }).length, 2);
    assert.equal(findDrafts({ data: { items: [q(1)] } }).length, 1);
    assert.equal(findDrafts([q(1), q(2), q(3)]).length, 3);
  });

  await check('but something that is not a list of questions is not mistaken for one', () => {
    /* Searching the shape only helps if it can tell the difference. A list of
       OBJECTS that are not questions is the case that matters: taken for
       drafts, every one is then rejected as malformed and the run reports «the
       model sent N unusable questions» — a confident, wrong diagnosis, which is
       worse than the honest «there was no list of questions in the reply». */
    assert.equal(findDrafts({ ok: true }).length, 0);
    assert.equal(findDrafts({ topics: ['تاریخ', 'جغرافیا'] }).length, 0, 'a list of strings is not a list of questions');
    assert.equal(findDrafts({ topics: [{ name: 'تاریخ' }, { name: 'جغرافیا' }] }).length, 0,
      'a list of topics is not a list of questions');
    assert.equal(findDrafts({ choices: [{ message: { role: 'assistant', content: 'x' } }] }).length, 0,
      'the provider’s own envelope is not a list of questions');
    assert.equal(findDrafts({ usage: { tokens: [1, 2, 3] } }).length, 0);
    assert.equal(findDrafts(null).length, 0);
  });

  await check('but a question that simply lost its options is still a question', () => {
    /* The line between «not a list of questions» and «a bad question» is where
       the operator is sent next. A question with no options is the model's
       fault and readDraft can say exactly what was missing; reading it as «no
       list at all» hides the one fact that would have explained the zero. */
    const found = findDrafts({ questions: [{ question: 'سؤالی بدون گزینه' }] });
    assert.equal(found.length, 1, 'it was not even seen as an attempt at a question');
  });

  await check('and a well-formed list still wins over a half-formed one', () => {
    /* The half-formed one is deliberately under the key that is searched FIRST,
       so only the strict-then-loose order can get this right: a search that
       accepts anything question-shaped as it goes would stop at `questions`
       and never see the complete list at all. */
    const found = findDrafts({ questions: [{ question: 'بی‌گزینه' }], generated: [q(1), q(2)] });
    assert.equal(found.length, 2, 'the complete list must be preferred');
    assert.ok(found.every((x: any) => x.options), 'it took the half-formed list instead');
  });

  await check('and a run given one of those says there was no list, not «N bad questions»', async () => {
    generatorSays({ topics: [{ name: 'تاریخ' }, { name: 'جغرافیا' }] });
    const r = await aiRunBatch({ topic: 'تاریخ', count: 2 });
    assert.equal(r.added, 0);
    assert.match(String(r.error), /فهرست سؤالی/, 'it invented questions to reject: ' + r.error);
  });

  await check('a shape that refers to itself does not hang the run', () => {
    const loop: any = { a: {} }; loop.a.back = loop;
    assert.equal(findDrafts(loop).length, 0);
  });

  /* ── AND THE WHOLE RUN ──────────────────────────────────────────────── */

  await check('questions under an unexpected key still reach the bank', async () => {
    generatorSays({ quiz: [q(101), q(102)] });
    const r = await aiRunBatch({ topic: 'تاریخ', count: 2 });
    assert.equal(r.added, 2, 'the run found nothing: ' + (r.error || 'no reason given'));
  });

  await check('a bare array of questions reaches the bank too', async () => {
    generatorSays([q(111), q(112)]);
    const r = await aiRunBatch({ topic: 'تاریخ', count: 2 });
    assert.equal(r.added, 2, 'the run found nothing: ' + (r.error || 'no reason given'));
  });

  /* ── NO ZERO WITHOUT A REASON ───────────────────────────────────────── */

  await check('a reply with no questions in it explains itself', async () => {
    /* THE REPORTED BUG. The model answers, the JSON parses, and there is no
       list in it — every check fell through and the panel printed «۰ تولید شد»
       beside «۰ اصلاً نوشته نشد», which reads as «nothing went wrong». */
    generatorSays({ message: 'no questions today', model: 'x' });
    const r = await aiRunBatch({ topic: 'تاریخ', count: 3 });
    assert.equal(r.added, 0);
    assert.ok(r.error, 'a zero with no reason at all — the exact complaint');
    assert.match(String(r.error), /فهرست سؤالی/, String(r.error));
    assert.match(String(r.error), /message|model/, 'it does not say what the model actually sent: ' + r.error);
  });

  await check('a run cut off at the cap says so rather than blaming the model', async () => {
    generatorSays('{"questions":[{"question":"الف","options":["a","b"', 'max_tokens');
    const r = await aiRunBatch({ topic: 'تاریخ', count: 10 });
    assert.equal(r.added, 0);
    assert.match(String(r.error), /قطع شد|سقف توکن/, r.error || '(no reason at all)');
  });

  await check('and EVERY zero carries a reason, whatever the model said', async () => {
    /* The guarantee, rather than one case of it: there is no answer that
       produces «۰ سؤال تولید شد» with nothing beside it. */
    const answers: Array<[string, unknown, string]> = [
      ['an empty object', {}, 'end_turn'],
      ['an empty list', { questions: [] }, 'end_turn'],
      ['a refusal in prose', 'متأسفم، نمی‌توانم', 'end_turn'],
      ['nothing at all', '', 'end_turn'],
      ['someone else’s envelope', { id: 'x', object: 'chat.completion', usage: { total_tokens: 9 } }, 'end_turn'],
      ['questions with no options', { questions: [{ question: 'الف' }] }, 'end_turn'],
      ['a truncated reply', '{"questions":[{"question":"ال', 'max_tokens']
    ];
    for (const [what, payload, stop] of answers) {
      generatorSays(payload, stop);
      const r = await aiRunBatch({ topic: 'تاریخ', count: 2 });
      assert.equal(r.added, 0, what + ' somehow added something');
      const said = r.error || (r.skipped[0] && (r.skipped[0].detail || r.skipped[0].reason));
      assert.ok(said, `«${what}» produced a zero with no reason — that is the bug`);
    }
  });

  /* ── THE SIZE OF THE ASK ────────────────────────────────────────────── */

  await check('the token budget grows with the number of questions wanted', async () => {
    /* A flat 1600 is about four Persian questions with their explanations, so
       asking for ten guaranteed the reply was cut off mid-object — and a
       truncated reply does not parse, which is a zero. */
    generatorSays({ questions: [q(201)] });
    await aiRunBatch({ topic: 'تاریخ', count: 1 });
    const small = asked.find((b) => stage(b) === 'gen')!.max_tokens;

    generatorSays({ questions: [q(202)] });
    await aiRunBatch({ topic: 'تاریخ', count: 10 });
    const large = asked.find((b) => stage(b) === 'gen')!.max_tokens;

    assert.ok(large > small, `ten questions were given no more room than one (${small} vs ${large})`);
    assert.ok(large >= 5000, 'ten Persian questions do not fit in ' + large + ' tokens');
  });

  globalThis.fetch = realFetch;
  if (KEEP === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = KEEP;
  console.log(`[aiReply] ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
