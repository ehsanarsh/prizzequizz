/* LAST SURVIVOR — admin-tunable configuration.
 *
 * A single self-healing JSON row (`ls_config`) holds EVERY knob the game needs,
 * so the admin panel can change capacity, timings, prize split, topic gating,
 * etc. without a redeploy. Postgres-backed with an in-memory fallback. A room
 * snapshots this config when it is created, so admin edits never disturb a
 * match that is already running. */
import { getPgPool } from '../database/postgres.js';

/* `shields` are extra lives inside a match: a wrong answer spends one instead
 * of eliminating, so a red ticket survives two mistakes and goes out on the
 * third. It is what the more expensive ticket buys besides a bigger share. */
export interface TicketTier { value: number; units: number; shields?: number; }
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
  topics: Record<string, TopicSettings>;
  /* Which categories «تصادفی» actually draws from.
   * Empty means every category, which is what the mode has always done and
   * stays the default — an operator who never opens this screen sees no
   * change. Naming categories here narrows the pool to exactly those, so a
   * topic can be live on its own without also turning up inside «تصادفی». */
  randomCategories: string[];
}

export interface TopicSettings {
  enabled: boolean;
  comingSoon?: boolean;
  minUsers?: number;
  /* Written here by an operator rather than discovered from the question bank.
   * A custom topic has no category behind it, so deleting it really does delete
   * it — that is the whole difference from a discovered one. */
  custom?: boolean;
  /* Taken off the picker entirely. A discovered topic cannot be deleted (the
   * bank puts it straight back on the next read), so hiding is what "remove it
   * from the list" honestly means for those. */
  hidden?: boolean;
  /* Emoji for the picker. Discovered topics inherit the category's icon; a
   * custom topic has no category, so without this it would show «❓». */
  icon?: string;
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
      green: { value: 12500, units: 1, shields: 0 },
      blue: { value: 25000, units: 2, shields: 1 },
      red: { value: 50000, units: 4, shields: 2 }
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
  },
  randomCategories: []
};

/* The categories «تصادفی» is allowed to draw from, or an empty list meaning
 * "no restriction". One reader for the question picker, the topic list and the
 * admin screen, so the three can never disagree about what the pool is. */
export function randomPoolCategories(cfg: LastSurvivorConfig): string[] {
  const raw = Array.isArray(cfg?.randomCategories) ? cfg.randomCategories : [];
  const out: string[] = [];
  for (const c of raw) {
    const t = String(c ?? '').trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}
/** Is this question's category in the «تصادفی» pool? Everything is, when unset. */
export function isInRandomPool(cfg: LastSurvivorConfig, category: string): boolean {
  const list = randomPoolCategories(cfg);
  return !list.length || list.includes(String(category ?? ''));
}

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
  const topics = {
    ...cfg.topics,
    [topic]: {
      ...(cfg.topics[topic] || {}), enabled, comingSoon: !enabled,
      /* Turning a topic on means putting it in front of players, so it cannot
       * stay hidden — otherwise the switch flips and nothing happens. */
      ...(enabled ? { hidden: false } : {}),
      ...(minUsers != null ? { minUsers } : {})
    }
  };
  return updateConfig({ topics });
}

/* Add a topic of the operator's own choosing.
 *
 * Until now the Last Survivor list could only contain what the question bank
 * happened to hold. A topic invented here has no category behind it, which is
 * exactly why it is marked custom: it can be deleted for real, and it stays
 * deleted. It arrives disabled — a topic with no questions must not be
 * playable — so the client shows it with the «به‌زودی» badge, which is what
 * announcing something ahead of time means. */
export async function addTopic(
  name: string,
  opts: { icon?: string; enabled?: boolean; minUsers?: number } = {}
): Promise<LastSurvivorConfig> {
  const topic = String(name || '').trim();
  if (!topic) throw new Error('نام موضوع لازم است.');
  if (topic.length > 60) throw new Error('نام موضوع نباید بیش از ۶۰ نویسه باشد.');
  if (isRandomTopic(topic)) throw new Error('موضوع «' + RANDOM_TOPIC + '» از قبل وجود دارد.');
  const cfg = await getConfig();
  const existing = cfg.topics?.[topic];
  /* Adding a name that is already on the list is how a hidden topic comes back,
   * not an error — but it must never quietly re-enable something. */
  if (existing && !existing.hidden) throw new Error('موضوع «' + topic + '» از قبل در فهرست است.');
  const entry: TopicSettings = {
    ...(existing || {}),
    enabled: opts.enabled === true,
    comingSoon: opts.enabled !== true,
    custom: existing?.custom ?? true,
    hidden: false,
    ...(opts.icon ? { icon: String(opts.icon).slice(0, 8) } : {}),
    ...(opts.minUsers != null ? { minUsers: Number(opts.minUsers) } : {})
  };
  return persistConfig({ ...cfg, topics: { ...cfg.topics, [topic]: entry } });
}

/* Narrow (or reopen) the pool «تصادفی» draws from.
 * Written whole rather than merged: taking a category OUT is the whole point,
 * and a deep merge of arrays would never remove one. */
export async function setRandomCategories(list: unknown): Promise<LastSurvivorConfig> {
  if (!Array.isArray(list)) throw new Error('فهرست موضوع‌ها فرستاده نشده است.');
  const out: string[] = [];
  for (const c of list) {
    const t = String(c ?? '').trim().slice(0, 60);
    if (t && !out.includes(t)) out.push(t);
  }
  const cfg = await getConfig();
  return persistConfig({ ...cfg, randomCategories: out });
}

/** Take a topic off the picker, or put it back, without touching its settings. */
export async function setTopicHidden(topic: string, hidden: boolean): Promise<LastSurvivorConfig> {
  if (isRandomTopic(topic) && hidden) {
    throw new Error('موضوع «' + RANDOM_TOPIC + '» از فهرست حذف نمی‌شود؛ می‌توانی غیرفعالش کنی.');
  }
  const cfg = await getConfig();
  const entry: TopicSettings = { ...(cfg.topics[topic] || { enabled: false }), hidden };
  return persistConfig({ ...cfg, topics: { ...cfg.topics, [topic]: entry } });
}

/* Remove a topic from the list — and say honestly which of the two things that
 * meant.
 *
 * A CUSTOM topic exists only in this config, so it is deleted outright. A
 * DISCOVERED one is only on the list because its category holds questions;
 * dropping the config entry would put it straight back on the next read, so it
 * is hidden instead. Either way it leaves the picker, which is what the
 * operator asked for; only the undo differs. «تصادفی» refuses both: it has no
 * category behind it and it is the one topic playable out of the box. */
export async function removeTopic(topic: string): Promise<{ config: LastSurvivorConfig; action: 'removed' | 'hidden' }> {
  if (isRandomTopic(topic)) {
    throw new Error('موضوع «' + RANDOM_TOPIC + '» حذف نمی‌شود؛ می‌توانی غیرفعالش کنی.');
  }
  const cfg = await getConfig();
  if (cfg.topics?.[topic]?.custom) {
    const topics = { ...cfg.topics };
    delete topics[topic];
    return { config: await persistConfig({ ...cfg, topics }), action: 'removed' };
  }
  return { config: await setTopicHidden(topic, true), action: 'hidden' };
}

export function isTopicHidden(cfg: LastSurvivorConfig, topic: string): boolean {
  return cfg.topics?.[topic]?.hidden === true;
}

export function isTopicPlayable(cfg: LastSurvivorConfig, topic: string): boolean {
  /* Hidden wins over enabled. A topic taken off the picker must not stay
   * joinable through a stale client or a hand-made request. */
  if (isTopicHidden(cfg, topic)) return false;
  return cfg.topics?.[topic]?.enabled === true;
}
