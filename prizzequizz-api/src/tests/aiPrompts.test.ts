/* THE AI PROMPTS, AND WHOSE SERVER ANSWERS.
 *
 * «API هوش مصنوعی گرفتم — از کجا باید وارد کنم و پرامپتش را کجا بنویسم؟»
 *
 * Both were unanswerable. The three system prompts were literals inside
 * questionPipelineService, so tuning what the model is asked needed a deploy;
 * and the host was hardcoded to api.anthropic.com, which cannot be reached from
 * Iran — every provider that can is a proxy speaking the same protocol at a
 * different address.
 *
 * Run: npx tsx src/tests/aiPrompts.test.ts */
import assert from 'node:assert/strict';
import { gameConfig } from '../core/config.js';
import { aiPrompt, aiPromptDefaults } from '../services/questionPipelineService.js';
import { aiBaseUrl, aiEndpoint, aiConfigured } from '../services/aiClient.js';

let pass = 0, fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}
const setPipeline = (v: unknown) => { (gameConfig as any).questionPipeline = v; };
const setEnv = (k: string, v: string | undefined) => { if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v; };

const STAGES = ['generator', 'reviewer', 'factChecker'] as const;
/* Spread, not the returned object: if aiPromptDefaults ever handed back the
   live table, DEF would BE that table and every comparison below would be the
   table against itself — a baseline that moves with what it is checking. */
const DEF = { ...aiPromptDefaults() };

// ── the prompts ────────────────────────────────────────────────────────────
check('with nothing configured, the shipped prompt is used', () => {
  setPipeline(undefined);
  for (const st of STAGES) assert.equal(aiPrompt(st), DEF[st]);
});

check('each stage has its OWN prompt, not one shared string', () => {
  const seen = new Set(STAGES.map((st) => aiPrompt(st)));
  assert.equal(seen.size, 3, 'two stages are being given the same instructions');
});

check('the shipped prompts say what their stage is for', () => {
  assert.match(DEF.generator, /writer|write/i);
  assert.match(DEF.reviewer, /review/i);
  assert.match(DEF.factChecker, /fact/i);
  /* Persian is the product's language and the generator must be told so. */
  assert.match(DEF.generator, /Persian|Farsi/i);
});

check('an operator’s prompt replaces the default', () => {
  setPipeline({ prompts: { generator: 'فقط سؤال ریاضی بساز.' } });
  assert.equal(aiPrompt('generator'), 'فقط سؤال ریاضی بساز.');
  /* And only that one — the others must not follow it. */
  assert.equal(aiPrompt('reviewer'), DEF.reviewer);
  assert.equal(aiPrompt('factChecker'), DEF.factChecker);
});

check('an empty or blank box means «use the default», not «no instructions»', () => {
  for (const v of ['', '   ', '\n\t ']) {
    setPipeline({ prompts: { reviewer: v } });
    assert.equal(aiPrompt('reviewer'), DEF.reviewer, JSON.stringify(v) + ' should fall back');
  }
});

check('a non-string in the config cannot blank the instructions', () => {
  for (const v of [null, 0, 42, [], {}, true]) {
    setPipeline({ prompts: { reviewer: v } });
    assert.equal(aiPrompt('reviewer'), DEF.reviewer, JSON.stringify(v) + ' should fall back');
  }
});

check('surrounding whitespace is not sent to the model', () => {
  setPipeline({ prompts: { generator: '  بساز.  ' } });
  assert.equal(aiPrompt('generator'), 'بساز.');
});

check('the defaults handed to the panel are a copy, not the live object', () => {
  /* Snapshotted as a primitive first, so the check survives the very thing it
     is checking for. */
  setPipeline(undefined);                    // no operator prompt in the way
  const before = String(aiPromptDefaults().generator);
  const a = aiPromptDefaults();
  (a as any).generator = 'ruined';
  assert.equal(aiPromptDefaults().generator, before, 'the panel could overwrite the shipped defaults');
  assert.equal(aiPrompt('generator'), before, 'and with it, what every future request asks for');
});

// ── whose server ───────────────────────────────────────────────────────────
const KEEP_URL = process.env.ANTHROPIC_BASE_URL, KEEP_KEY = process.env.ANTHROPIC_API_KEY;

check('with nothing set it still goes to Anthropic', () => {
  setEnv('ANTHROPIC_BASE_URL', undefined);
  assert.equal(aiBaseUrl(), 'https://api.anthropic.com');
  assert.equal(aiEndpoint(), 'https://api.anthropic.com/v1/messages');
});

check('a proxy’s address is used instead', () => {
  setEnv('ANTHROPIC_BASE_URL', 'https://sinoxapi.com');
  assert.equal(aiEndpoint(), 'https://sinoxapi.com/v1/messages');
});

/* The documented trap: every such provider publishes its base URL without
   `/v1`, because the SDKs append `/v1/messages`. An operator who pastes the
   one with it would otherwise reach /v1/v1/messages and a 404. */
check('a pasted «/v1» does not become /v1/v1/messages', () => {
  for (const u of ['https://sinoxapi.com/v1', 'https://sinoxapi.com/v1/', 'https://sinoxapi.com/']) {
    setEnv('ANTHROPIC_BASE_URL', u);
    assert.equal(aiEndpoint(), 'https://sinoxapi.com/v1/messages', u + ' → ' + aiEndpoint());
  }
});

check('blank or whitespace falls back rather than building a broken URL', () => {
  for (const u of ['', '   ']) {
    setEnv('ANTHROPIC_BASE_URL', u);
    assert.equal(aiEndpoint(), 'https://api.anthropic.com/v1/messages');
  }
});

check('AI is off until a key is set, and on once it is', () => {
  setEnv('ANTHROPIC_API_KEY', undefined);
  assert.equal(aiConfigured(), false);
  setEnv('ANTHROPIC_API_KEY', '   ');
  assert.equal(aiConfigured(), false, 'whitespace is not a key');
  setEnv('ANTHROPIC_API_KEY', 'sk-test');
  assert.equal(aiConfigured(), true);
});

// ── and all of it actually reaches the request ─────────────────────────────
/* The tests above prove the helpers. This proves the WIRING: that the stage
   really sends its own prompt to the configured host. A stage that quietly
   went back to a literal would pass everything above. */
const realFetch = globalThis.fetch;
async function captureCall(fn: () => Promise<unknown>): Promise<{ url: string; body: any; headers: any }> {
  let seen: any = null;
  globalThis.fetch = (async (url: any, init: any) => {
    seen = { url: String(url), body: JSON.parse(String(init?.body || '{}')), headers: init?.headers || {} };
    return { ok: true, json: async () => ({ content: [{ text: '{"questions":[]}' }] }) } as any;
  }) as any;
  try { await fn(); } finally { globalThis.fetch = realFetch; }
  assert.ok(seen, 'no request was made at all');
  return seen;
}

const { aiGenerate, aiReview, aiFactCheck } = await import('../services/questionPipelineService.js');
setEnv('ANTHROPIC_API_KEY', 'sk-test');
setEnv('ANTHROPIC_BASE_URL', 'https://sinoxapi.com/v1');   // deliberately the trap spelling

await (async () => {
  setPipeline({ prompts: { generator: 'PROMPT-GEN', reviewer: 'PROMPT-REV', factChecker: 'PROMPT-FACT' } });
  const g = await captureCall(() => aiGenerate({ topic: 'فوتبال', count: 1 }));
  check('the generator sends the operator’s prompt', () => {
    assert.equal(g.body.system.split('\n')[0], 'PROMPT-GEN');
  });
  check('to the configured host, with the path built once', () => {
    assert.equal(g.url, 'https://sinoxapi.com/v1/messages');
  });
  check('and the key goes in both header spellings, so either kind of proxy sees it', () => {
    assert.equal((g.headers as any)['x-api-key'], 'sk-test');
    assert.equal((g.headers as any)['authorization'], 'Bearer sk-test');
  });
  /* The JSON contract is appended by the client and is NOT the operator's to
     edit — the reply is parsed against it. */
  check('the JSON-only instruction still rides along', () => {
    assert.match(g.body.system, /Return ONLY a single valid JSON object/);
  });

  const r = await captureCall(() => aiReview({ text: 'q', options: ['a', 'b', 'c', 'd'], correctIndex: 0, difficulty: 'easy' }));
  check('the reviewer sends ITS prompt, not the generator’s', () => {
    assert.equal(r.body.system.split('\n')[0], 'PROMPT-REV');
  });

  const f = await captureCall(() => aiFactCheck({ text: 'q', options: ['a', 'b', 'c', 'd'], correctIndex: 0 }));
  check('and the fact-checker sends its own', () => {
    assert.equal(f.body.system.split('\n')[0], 'PROMPT-FACT');
  });
})();

setEnv('ANTHROPIC_BASE_URL', KEEP_URL); setEnv('ANTHROPIC_API_KEY', KEEP_KEY); setPipeline(undefined);
console.log(`[aiPrompts] ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
