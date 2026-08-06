/* LAST SURVIVOR — admin-tunable configuration.
 *
 * A single self-healing JSON row (`ls_config`) holds EVERY knob the game needs,
 * so the admin panel can change capacity, timings, prize split, topic gating,
 * etc. without a redeploy. Postgres-backed with an in-memory fallback. A room
 * snapshots this config when it is created, so admin edits never disturb a
 * match that is already running. */
import { getPgPool } from '../database/postgres.js';

export interface TicketTier { value: number; units: number; }
export interface LastSurvivorConfig {
  room: {
    capacity: number;          // max players before a room starts instantly + a new room opens
    minUsers: number;          // do not start below this many
    waitSeconds: number;       // waiting-room countdown
    manualStartEnabled: boolean;
    startPct: number;          // % of players pressing "start now" that triggers an early start
  };
  timings: {
    readySeconds: number;       // "آماده‌ای؟" gate before each question (like the duel)
    questionSeconds: number;
    eliminationSeconds: number;
    dashboardSeconds: number;
    cashoutSeconds: number;
  };
  match: {
    totalRounds: number;       // max questions before the pot is split among survivors
    questionsPerRound: number;
    minSurvivors: number;      // stop when survivors reach this (usually 1)
  };
  features: { animations: boolean; chat: boolean };
  economy: {
    rakePercent: number;       // house cut on the gross pool (admin-set; 0 = full pool to players)
    tickets: Record<string, TicketTier>; // green/blue/red → {value, units}
  };
  // Per-topic gating. A topic is playable only when enabled=true. Anything not
  // enabled shows the "به‌زودی…" badge in the client. minUsers can override the
  // room default per topic.
  topics: Record<string, { enabled: boolean; comingSoon?: boolean; minUsers?: number }>;
}

/* The topic whose questions come from every category at once. Held here rather
 * than typed as a string in three places, because the question picker, the
 * topic list and the seed all have to agree on it exactly. */
export const RANDOM_TOPIC = 'تصادفی';
export function isRandomTopic(topic: string): boolean { return topic === RANDOM_TOPIC; }

export const LS_DEFAULT_CONFIG: LastSurvivorConfig = {
  room: { capacity: 100, minUsers: 2, waitSeconds: 120, manualStartEnabled: true, startPct: 70 },
  timings: { readySeconds: 5, questionSeconds: 10, eliminationSeconds: 7, dashboardSeconds: 6, cashoutSeconds: 8 },
  match: { totalRounds: 12, questionsPerRound: 1, minSurvivors: 1 },
  features: { animations: true, chat: true },
  economy: {
    rakePercent: 0,
    tickets: {
      green: { value: 12500, units: 1 },
      blue: { value: 25000, units: 2 },
      red: { value: 50000, units: 4 }
    }
  },
  // General knowledge is live; everything else is "coming soon" until the admin
  // enables it. The topic list itself is merged from the real categories at read
  // time, so new categories automatically show up (gated) with no code change.
  topics: {
    /* The one topic that is live out of the box. It has no category of its own:
     * its questions are drawn from the WHOLE bank, which is the point — the
     * pool is as deep as the database instead of as deep as one category, so a
     * long match never runs short and never repeats early. Every real category
     * stays "coming soon" until an operator turns it on. */
    [RANDOM_TOPIC]: { enabled: true }
  }
};

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ls_config (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  _schemaReady = true;
}

let _mem: LastSurvivorConfig | null = null;

// Deep-merge a partial patch onto a base config (objects merged, scalars/arrays
// replaced). Keeps unknown keys from persisted data so we never lose settings.
function deepMerge<T>(base: T, patch: any): T {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) return (patch ?? base) as T;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const k of Object.keys(patch)) {
    const bv = (base as any)?.[k];
    const pv = patch[k];
    out[k] = (bv && typeof bv === 'object' && pv && typeof pv === 'object' && !Array.isArray(bv) && !Array.isArray(pv))
      ? deepMerge(bv, pv) : pv;
  }
  return out;
}

export function withDefaults(partial: any): LastSurvivorConfig {
  return deepMerge(LS_DEFAULT_CONFIG, partial || {});
}

export async function getConfig(): Promise<LastSurvivorConfig> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT data FROM ls_config WHERE id='default'`);
    if (!rows[0]) { await pool.query(`INSERT INTO ls_config(id,data) VALUES ('default',$1) ON CONFLICT (id) DO NOTHING`, [JSON.stringify(LS_DEFAULT_CONFIG)]); return LS_DEFAULT_CONFIG; }
    return withDefaults(rows[0].data);
  }
  if (!_mem) _mem = withDefaults({});
  return _mem;
}

/* Write a whole config, no merging. Removing anything has to go through this:
 * updateConfig deep-MERGES, so a key left out of the patch is restored from the
 * current config and a delete silently does nothing. */
async function persistConfig(next: LastSurvivorConfig): Promise<LastSurvivorConfig> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(`INSERT INTO ls_config(id,data,updated_at) VALUES ('default',$1,now()) ON CONFLICT (id) DO UPDATE SET data=$1, updated_at=now()`, [JSON.stringify(next)]);
  } else {
    _mem = next;
  }
  return next;
}

export async function updateConfig(patch: Partial<LastSurvivorConfig> | Record<string, any>): Promise<LastSurvivorConfig> {
  const current = await getConfig();
  return persistConfig(deepMerge(current, patch));
}

// Reset a single topic's gating (admin toggles). Convenience over updateConfig.
export async function setTopicEnabled(topic: string, enabled: boolean, minUsers?: number): Promise<LastSurvivorConfig> {
  const cfg = await getConfig();
  const topics = { ...cfg.topics, [topic]: { ...(cfg.topics[topic] || {}), enabled, comingSoon: !enabled, ...(minUsers != null ? { minUsers } : {}) } };
  return updateConfig({ topics });
}

/* Forget a topic's settings entirely.
 *
 * The topic LIST is the union of the categories that have questions and the
 * names in this config, so deleting is not "make it disappear" — a category
 * with questions comes straight back, gated, on the next read. What it removes
 * is the override: the enabled flag and any per-topic minUsers. That is the
 * honest meaning of delete here, and it is why «تصادفی» refuses: it has no
 * category behind it, so forgetting it would remove the only topic that is
 * playable out of the box. */
export async function removeTopic(topic: string): Promise<LastSurvivorConfig> {
  if (isRandomTopic(topic)) {
    throw new Error('موضوع «' + RANDOM_TOPIC + '» حذف نمی‌شود؛ می‌توانی غیرفعالش کنی.');
  }
  const cfg = await getConfig();
  const topics = { ...cfg.topics };
  delete topics[topic];
  return persistConfig({ ...cfg, topics });
}

export function isTopicPlayable(cfg: LastSurvivorConfig, topic: string): boolean {
  return cfg.topics?.[topic]?.enabled === true;
}
