/* Thin Anthropic Messages API client for the question pipeline. It is fully
 * OPTIONAL: with no ANTHROPIC_API_KEY the pipeline still runs (manual mode) and
 * every AI stage reports { configured: false } instead of failing. When a key
 * is present, each stage calls a (config-selectable) model and expects a strict
 * JSON reply, which we parse defensively.
 */
import { gameConfig } from '../core/config.js';
import { logger } from './logger.js';

export function aiConfigured(): boolean { return !!aiKey(); }
function aiKey(): string { return String(process.env.ANTHROPIC_API_KEY || '').trim(); }

/* WHOSE SERVER ANSWERS. The Anthropic Messages API is also spoken by resellers
 * and proxies — which is how this reaches Iran at all — so the host is a
 * setting, not a constant. Anything that speaks the same protocol works, and
 * nothing else in this file changes.
 *
 * The trailing `/v1` is stripped on purpose. Every such provider documents its
 * base URL WITHOUT it because the official SDKs append `/v1/messages`
 * themselves, so an operator who pastes the URL from a page that shows it WITH
 * `/v1` would otherwise get `/v1/v1/messages` and a 404. Sinox's own docs call
 * that their single most common support ticket. Accepting both spellings costs
 * one line and removes the trap. */
const AI_DEFAULT_HOST = 'https://api.anthropic.com';
export function aiBaseUrl(): string {
  const raw = String(process.env.ANTHROPIC_BASE_URL || '').trim() || AI_DEFAULT_HOST;
  return raw.replace(/\/+$/, '').replace(/\/v1$/, '');
}
/** Where the request actually goes — shown in the panel so it can be checked. */
export function aiEndpoint(model?: string): string {
  return aiBaseUrl() + (dialectFor(model ?? aiModel('generator')) === 'openai' ? '/v1/chat/completions' : '/v1/messages');
}

/* ---------------------------------------------------------------------------
 * TWO PROTOCOLS, ONE HOST.
 *
 * «Model 't-gpt-5.5' is not supported via /v1/messages. Use
 *  /v1/chat/completions instead.»
 *
 * The proxies that make this reachable from Iran are multi-model: they speak
 * Anthropic's Messages API for Claude and OpenAI's Chat Completions for
 * everything else, on the same host and the same key. This file only ever spoke
 * the first, so choosing any non-Claude model produced a 400 — and from the
 * panel that looked exactly like «تولید سوال کار نمی‌کنه».
 *
 * The model id decides, and the provider's own refusal corrects us when the
 * guess is wrong: an error that names the other endpoint is retried there once.
 * Guessing from a name is a heuristic; being TOLD is not, and providers add
 * models faster than anybody updates a list.
 * ------------------------------------------------------------------------- */
export type AiDialect = 'anthropic' | 'openai';
export function dialectFor(model: string): AiDialect {
  /* A reseller prefix («t-» for token-billed keys) is not part of the family. */
  const m = String(model || '').trim().toLowerCase().replace(/^[a-z]{1,3}-(?=claude|gpt|o[0-9])/, '');
  return m.startsWith('claude') ? 'anthropic' : 'openai';
}

function pipelineCfg(): any { return (gameConfig as any)?.questionPipeline ?? {}; }
export function aiModel(kind: 'generator' | 'reviewer' | 'factChecker'): string {
  const c = pipelineCfg();
  /* Trimmed, because these are PASTED. A model id carrying a stray space is
   * rejected by the provider as an unknown model, and the panel then looks
   * exactly like a bad key or a model that cannot be changed — which is how it
   * was reported. */
  const pick = (v: unknown) => String(v ?? '').trim();
  return pick(c[kind + 'Model']) || pick(c.model) || 'claude-sonnet-5';
}

/* WHICH MODELS THIS KEY MAY ACTUALLY USE.
 *
 * The three model boxes were free text, so «choose any model» meant «type an
 * id exactly right, from memory, and find out it was wrong only when a run
 * fails». The provider knows the list; this asks it.
 *
 * It is a best effort on purpose: a proxy that does not implement /v1/models
 * is not broken, it just cannot be listed — so the boxes stay typable and the
 * panel says the list is unavailable rather than pretending there are none.
 */
export async function aiListModels(): Promise<{ ok: boolean; models: string[]; error?: string }> {
  if (!aiConfigured()) return { ok: false, models: [], error: 'ANTHROPIC_API_KEY not set' };
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 12_000);
    let res: Response;
    try {
      res = await fetch(aiBaseUrl() + '/v1/models?limit=200', {
        headers: { 'x-api-key': aiKey(), 'authorization': 'Bearer ' + aiKey(), 'anthropic-version': '2023-06-01' },
        signal: ac.signal
      });
    } finally { clearTimeout(timer); }
    if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status}` };
    const body: any = await res.json().catch(() => null);
    /* Anthropic answers {data:[{id}]}; some proxies answer {models:[...]} or a
     * bare array. All three are read rather than insisting on one. */
    const rows = Array.isArray(body?.data) ? body.data
      : Array.isArray(body?.models) ? body.models
      : Array.isArray(body) ? body : [];
    const models = rows
      .map((m: any) => String(typeof m === 'string' ? m : (m?.id ?? m?.name ?? '')).trim())
      .filter(Boolean)
      .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
      .sort();
    return { ok: true, models };
  } catch (e) {
    return { ok: false, models: [], error: e instanceof Error ? e.message : 'unreachable' };
  }
}

/* DOES THIS MODEL ACTUALLY WORK, for this key, on this host?
 *
 * «تولید سوال کار نمیکنه» and «نمی‌تونم مدل رو عوض کنم» look the same from the
 * panel and have completely different fixes. One tiny real call answers it: the
 * provider's own words come back, so «model not found» and «billing type
 * mismatch» stop being the same silence. */
export async function aiTestModel(model: string): Promise<{ ok: boolean; model: string; dialect: AiDialect; endpoint: string; error?: string; reply?: string }> {
  const m = String(model || '').trim();
  const d = dialectFor(m), ep = aiEndpoint(m);
  if (!m) return { ok: false, model: m, dialect: d, endpoint: ep, error: 'شناسهٔ مدل خالی است.' };
  if (!aiConfigured()) return { ok: false, model: m, dialect: d, endpoint: ep, error: 'ANTHROPIC_API_KEY روی سرور تنظیم نشده.' };
  const r = await aiJson<{ ok?: unknown }>({
    model: m,
    system: 'Reply with JSON only.',
    user: 'Return exactly: {"ok":true}',
    maxTokens: 32
  });
  if (!r.ok) return { ok: false, model: m, dialect: d, endpoint: ep, error: r.error || 'پاسخی نداد.' };
  return { ok: true, model: m, dialect: d, endpoint: ep, reply: String(r.raw || '').slice(0, 120) };
}

export interface AiResult<T> { configured: boolean; ok: boolean; data?: T; error?: string; raw?: string }

/* Ask a model for a JSON object. `schemaHint` is embedded in the prompt so the
 * model returns exactly the shape we parse. Returns a defensively-parsed value. */
const JSON_ONLY = '\n\nReturn ONLY a single valid JSON object. No markdown, no prose.';

function buildRequest(dialect: AiDialect, input: { model: string; system: string; user: string; maxTokens?: number }, tokenKey: 'max_tokens' | 'max_completion_tokens'): Record<string, unknown> {
  const max = input.maxTokens ?? 1200;
  if (dialect === 'anthropic') {
    return { model: input.model, max_tokens: max, system: input.system + JSON_ONLY, messages: [{ role: 'user', content: input.user }] };
  }
  /* Chat Completions has no `system` field of its own — the instruction is the
   * first message — and the newer models renamed the token cap. */
  return {
    model: input.model, [tokenKey]: max,
    messages: [{ role: 'system', content: input.system + JSON_ONLY }, { role: 'user', content: input.user }]
  };
}

/** The text, out of whichever answer shape came back. */
function readReply(dialect: AiDialect, body: any): string {
  if (dialect === 'anthropic') return (body?.content ?? []).map((b: any) => b?.text ?? '').join('').trim();
  const c = body?.choices?.[0]?.message?.content;
  /* Some gateways answer with the content already split into parts. */
  if (Array.isArray(c)) return c.map((x: any) => x?.text ?? x?.content ?? '').join('').trim();
  return String(c ?? '').trim();
}

async function callOnce(dialect: AiDialect, input: { model: string; system: string; user: string; maxTokens?: number }, tokenKey: 'max_tokens' | 'max_completion_tokens'):
  Promise<{ ok: true; raw: string } | { ok: false; status: number; text: string } | { ok: false; status: 0; text: string }> {
  const url = aiBaseUrl() + (dialect === 'openai' ? '/v1/chat/completions' : '/v1/messages');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      /* Both spellings of the same credential. The official API reads
       * `x-api-key`; some proxies only look at `Authorization`. Sending both
       * costs nothing and means one setting works either way. */
      'x-api-key': aiKey(),
      'authorization': 'Bearer ' + aiKey(),
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(buildRequest(dialect, input, tokenKey))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, text };
  }
  const body: any = await res.json().catch(() => null);
  return { ok: true, raw: readReply(dialect, body) };
}

export async function aiJson<T = any>(input: { model: string; system: string; user: string; maxTokens?: number }): Promise<AiResult<T>> {
  if (!aiConfigured()) return { configured: false, ok: false, error: 'ANTHROPIC_API_KEY not set' };
  try {
    let dialect = dialectFor(input.model);
    let tokenKey: 'max_tokens' | 'max_completion_tokens' = 'max_tokens';
    let r = await callOnce(dialect, input, tokenKey);

    /* THE PROVIDER GETS TO CORRECT US. Guessing the protocol from a model name
     * works until somebody ships a model whose name does not say what it is —
     * but a refusal that NAMES the other endpoint is not a guess. */
    if (!r.ok && /chat\/completions/i.test(r.text) && dialect === 'anthropic') {
      dialect = 'openai';
      r = await callOnce(dialect, input, tokenKey);
    } else if (!r.ok && /\/v1\/messages/i.test(r.text) && dialect === 'openai') {
      dialect = 'anthropic';
      r = await callOnce(dialect, input, tokenKey);
    }
    /* And the newer OpenAI models renamed the token cap; the error says so. */
    if (!r.ok && dialect === 'openai' && /max_completion_tokens/i.test(r.text) && tokenKey === 'max_tokens') {
      tokenKey = 'max_completion_tokens';
      r = await callOnce(dialect, input, tokenKey);
    }

    if (!r.ok) {
      logger.warn('ai_request_failed', { status: r.status, model: input.model, dialect });
      return { configured: true, ok: false, error: `AI HTTP ${r.status}: ${r.text.slice(0, 220)}` };
    }
    const parsed = extractJson(r.raw);
    if (parsed == null) return { configured: true, ok: false, error: 'AI returned non-JSON', raw: r.raw };
    return { configured: true, ok: true, data: parsed as T, raw: r.raw };
  } catch (e) {
    return { configured: true, ok: false, error: e instanceof Error ? e.message : 'AI error' };
  }
}

function extractJson(text: string): unknown | null {
  if (!text) return null;
  // strip ```json fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}
