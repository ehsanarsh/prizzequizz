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
export function aiEndpoint(): string { return aiBaseUrl() + '/v1/messages'; }

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
export async function aiTestModel(model: string): Promise<{ ok: boolean; model: string; error?: string; reply?: string }> {
  const m = String(model || '').trim();
  if (!m) return { ok: false, model: m, error: 'شناسهٔ مدل خالی است.' };
  if (!aiConfigured()) return { ok: false, model: m, error: 'ANTHROPIC_API_KEY روی سرور تنظیم نشده.' };
  const r = await aiJson<{ ok?: unknown }>({
    model: m,
    system: 'Reply with JSON only.',
    user: 'Return exactly: {"ok":true}',
    maxTokens: 32
  });
  if (!r.ok) return { ok: false, model: m, error: r.error || 'پاسخی نداد.' };
  return { ok: true, model: m, reply: String(r.raw || '').slice(0, 120) };
}

export interface AiResult<T> { configured: boolean; ok: boolean; data?: T; error?: string; raw?: string }

/* Ask a model for a JSON object. `schemaHint` is embedded in the prompt so the
 * model returns exactly the shape we parse. Returns a defensively-parsed value. */
export async function aiJson<T = any>(input: { model: string; system: string; user: string; maxTokens?: number }): Promise<AiResult<T>> {
  if (!aiConfigured()) return { configured: false, ok: false, error: 'ANTHROPIC_API_KEY not set' };
  try {
    const res = await fetch(aiEndpoint(), {
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
      body: JSON.stringify({
        model: input.model,
        max_tokens: input.maxTokens ?? 1200,
        system: input.system + '\n\nReturn ONLY a single valid JSON object. No markdown, no prose.',
        messages: [{ role: 'user', content: input.user }]
      })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn('ai_request_failed', { status: res.status });
      return { configured: true, ok: false, error: `AI HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const body: any = await res.json();
    const raw = (body?.content ?? []).map((b: any) => b?.text ?? '').join('').trim();
    const parsed = extractJson(raw);
    if (parsed == null) return { configured: true, ok: false, error: 'AI returned non-JSON', raw };
    return { configured: true, ok: true, data: parsed as T, raw };
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
