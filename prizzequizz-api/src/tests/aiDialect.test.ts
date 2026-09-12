/* TWO PROTOCOLS ON ONE HOST.
 *
 * «Model 't-gpt-5.5' is not supported via /v1/messages. Use
 *  /v1/chat/completions instead.»
 *
 * The proxies that make this reachable from Iran are multi-model: Anthropic's
 * Messages API for Claude, OpenAI's Chat Completions for everything else, same
 * host, same key. The client only ever spoke the first, so picking any
 * non-Claude model produced a 400 — and from the panel that is indistinguishable
 * from «تولید سوال کار نمی‌کنه».
 *
 * Guessing the protocol from a model name is a heuristic and will be wrong
 * eventually; being TOLD by the provider is not. Both paths are held here.
 *
 * Run: npx tsx src/tests/aiDialect.test.ts */
import assert from 'node:assert/strict';
import { dialectFor, aiJson, aiEndpoint } from '../services/aiClient.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const realFetch = globalThis.fetch;
let seen: Array<{ url: string; body: any }> = [];
/** `reply` decides what the fake provider does with each request. */
function serve(reply: (url: string, body: any) => { status?: number; json?: any; text?: string }): void {
  seen = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    seen.push({ url: String(url), body });
    const r = reply(String(url), body);
    const status = r.status ?? 200;
    return {
      ok: status < 400, status,
      json: async () => r.json ?? {},
      text: async () => r.text ?? JSON.stringify(r.json ?? {})
    } as any;
  }) as any;
}
const ANTHROPIC_OK = { content: [{ type: 'text', text: '{"ok":true}' }] };
const OPENAI_OK = { choices: [{ message: { content: '{"ok":true}' } }] };
const ask = (model: string) => aiJson({ model, system: 's', user: 'u', maxTokens: 40 });

const KEEP = process.env.ANTHROPIC_API_KEY;
const KEEP_BASE = process.env.ANTHROPIC_BASE_URL;

(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = 'https://proxy.example';

  /* ── which protocol a model speaks ─────────────────────────────────── */

  await check('Claude models speak the Messages API', () => {
    assert.equal(dialectFor('claude-sonnet-5'), 'anthropic');
    assert.equal(dialectFor('claude-opus-5'), 'anthropic');
  });

  await check('and a reseller prefix does not change what they are', () => {
    /* «t-» marks a token-billed key at the proxy; it is not part of the family. */
    assert.equal(dialectFor('t-claude-sonnet-5'), 'anthropic');
  });

  await check('everything else speaks Chat Completions', () => {
    assert.equal(dialectFor('gpt-5.5'), 'openai');
    assert.equal(dialectFor('t-gpt-5.5'), 'openai', 'the exact model that was reported');
    assert.equal(dialectFor('o3-mini'), 'openai');
    assert.equal(dialectFor('deepseek-chat'), 'openai');
    assert.equal(dialectFor(''), 'openai');
  });

  /* ── and it is actually spoken ─────────────────────────────────────── */

  await check('a Claude model is posted to /v1/messages, in its shape', async () => {
    serve(() => ({ json: ANTHROPIC_OK }));
    const r = await ask('claude-sonnet-5');
    assert.equal(r.ok, true);
    assert.match(seen[0]!.url, /\/v1\/messages$/);
    assert.ok(seen[0]!.body.system, 'Messages carries the instruction in `system`');
    assert.equal(seen[0]!.body.messages.length, 1);
    assert.equal(seen[0]!.body.max_tokens, 40);
  });

  await check('a GPT model is posted to /v1/chat/completions, in ITS shape', async () => {
    serve(() => ({ json: OPENAI_OK }));
    const r = await ask('t-gpt-5.5');
    assert.equal(r.ok, true, 'this is the call that used to 400');
    assert.match(seen[0]!.url, /\/v1\/chat\/completions$/);
    assert.equal(seen[0]!.body.system, undefined, 'Chat Completions has no `system` field');
    assert.equal(seen[0]!.body.messages[0].role, 'system', 'it is the first message instead');
    assert.equal(seen[0]!.body.messages[1].role, 'user');
  });

  await check('and its answer is read out of the right place', async () => {
    serve(() => ({ json: { choices: [{ message: { content: '{"n":7}' } }] } }));
    const r = await ask('gpt-5.5');
    assert.equal((r.data as any).n, 7, 'reading `content` like an Anthropic reply would find nothing');
  });

  await check('a reply split into parts is still read', async () => {
    serve(() => ({ json: { choices: [{ message: { content: [{ text: '{"n":' }, { text: '9}' }] } }] } }));
    const r = await ask('gpt-5.5');
    assert.equal((r.data as any).n, 9);
  });

  /* ── the provider gets to correct us ───────────────────────────────── */

  await check('a model that refuses one endpoint is retried on the one it names', async () => {
    /* The exact refusal that was reported, on a model whose NAME says Claude —
       so the guess is wrong and only the provider can say so. */
    let first = true;
    serve((url) => {
      if (first && /\/v1\/messages$/.test(url)) {
        first = false;
        return { status: 400, text: JSON.stringify({ error: { message: "Model 'x' is not supported via /v1/messages. Use /v1/chat/completions instead." } }) };
      }
      return { json: OPENAI_OK };
    });
    const r = await ask('claude-weird-9');
    assert.equal(r.ok, true, 'the provider said where to go and we did not follow');
    assert.equal(seen.length, 2);
    assert.match(seen[1]!.url, /chat\/completions$/);
  });

  await check('and the correction works in the other direction too', async () => {
    let first = true;
    serve((url) => {
      if (first && /chat\/completions$/.test(url)) {
        first = false;
        return { status: 400, text: JSON.stringify({ error: { message: 'This model requires /v1/messages' } }) };
      }
      return { json: ANTHROPIC_OK };
    });
    const r = await ask('mystery-model-1');
    assert.equal(r.ok, true);
    assert.match(seen[1]!.url, /\/v1\/messages$/);
  });

  await check('a renamed token cap is retried under its new name', async () => {
    let first = true;
    serve(() => {
      if (first) { first = false; return { status: 400, text: JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }) }; }
      return { json: OPENAI_OK };
    });
    const r = await ask('gpt-5.5');
    assert.equal(r.ok, true);
    assert.equal(seen[1]!.body.max_completion_tokens, 40);
    assert.equal(seen[1]!.body.max_tokens, undefined);
  });

  await check('a real failure is still reported, with the provider’s own words', async () => {
    serve(() => ({ status: 401, text: JSON.stringify({ error: { message: 'invalid x-api-key' } }) }));
    const r = await ask('gpt-5.5');
    assert.equal(r.ok, false);
    assert.match(String(r.error), /401/);
    assert.match(String(r.error), /invalid x-api-key/, 'the panel can only help if it is told what happened');
  });

  await check('and it does not retry forever on an error nobody named', async () => {
    serve(() => ({ status: 500, text: 'boom' }));
    await ask('gpt-5.5');
    assert.equal(seen.length, 1, 'a 500 is not an instruction to try somewhere else');
  });

  await check('the panel is shown the endpoint a given model will really use', () => {
    assert.match(aiEndpoint('claude-sonnet-5'), /\/v1\/messages$/);
    assert.match(aiEndpoint('t-gpt-5.5'), /chat\/completions$/);
  });

  globalThis.fetch = realFetch;
  if (KEEP === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = KEEP;
  if (KEEP_BASE === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = KEEP_BASE;
  console.log(`[aiDialect] ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
