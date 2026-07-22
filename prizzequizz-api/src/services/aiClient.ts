/* Thin Anthropic Messages API client for the question pipeline. It is fully
 * OPTIONAL: with no ANTHROPIC_API_KEY the pipeline still runs (manual mode) and
 * every AI stage reports { configured: false } instead of failing. When a key
 * is present, each stage calls a (config-selectable) model and expects a strict
 * JSON reply, which we parse defensively.
 */
import { gameConfig } from '../core/config.js';
import { logger } from './logger.js';

export function aiConfigured(): boolean { return !!process.env.ANTHROPIC_API_KEY; }

function pipelineCfg(): any { return (gameConfig as any)?.questionPipeline ?? {}; }
export function aiModel(kind: 'generator' | 'reviewer' | 'factChecker'): string {
  const c = pipelineCfg();
  return c[kind + 'Model'] || c.model || 'claude-sonnet-5';
}

export interface AiResult<T> { configured: boolean; ok: boolean; data?: T; error?: string; raw?: string }

/* Ask a model for a JSON object. `schemaHint` is embedded in the prompt so the
 * model returns exactly the shape we parse. Returns a defensively-parsed value. */
export async function aiJson<T = any>(input: { model: string; system: string; user: string; maxTokens?: number }): Promise<AiResult<T>> {
  if (!aiConfigured()) return { configured: false, ok: false, error: 'ANTHROPIC_API_KEY not set' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY as string,
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
