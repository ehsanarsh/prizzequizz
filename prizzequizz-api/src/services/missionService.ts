/* MISSIONS — definitions are data, never code.
 *
 * The whole point of this design is the last line of the brief: a game meant to
 * run for years to level 100 cannot have its missions compiled into the client.
 * Every mission here is a row — kind, metric, target, rewards, rarity, level
 * window, event window — so a new mission or a Nowruz event is a panel edit,
 * not a release.
 *
 * The engine knows nothing about any particular mission. It knows how to count
 * a metric, how to pick a day's set for a player, and how to pay a reward. What
 * the missions actually are lives in the table.
 */
import { randomUUID } from 'node:crypto';
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';
import { postEntry } from './walletLedgerService.js';
import { grantTickets } from './ticketService.js';
import { grantLifeline } from './lifelineService.js';
import { addHearts } from './heartService.js';
import { recordCategories } from './recordModeService.js';
import { awardScoring } from './matchEngine.js';
import { grantCharacter } from './characterSelectionService.js';
import { logger } from './logger.js';

/* Every countable thing the game can report. A mission targets one of these;
 * adding a mission never needs a new metric, and adding a metric is the only
 * thing that ever needs code. */
export const METRICS = [
  'login', 'dailyClaim', 'wheelSpin',
  'questionsAnswered', 'correctAnswers', 'matchesPlayed', 'matchesWon',
  'xpEarned', 'coinsSpent', 'ticketsUsed', 'ticketsBought', 'paidMatch',
  'newCategory', 'friendMatch', 'shopVisit', 'giftSent', 'giftReceived',
  'friendsAdded', 'invites', 'deposit', 'withdrawal', 'cashPrize', 'adWatched',
  'correctStreak', 'winStreak', 'flawlessWin', 'beatHigherLevel', 'categoriesWon',
  'level', 'loginStreak', 'playStreak', 'winStreakDays',
  /* Record mode. `recordValue` is scoped to a category; `recordGlobal` is the
   * all-topics ladder. Both are "best so far", not counters. */
  'recordSet', 'recordValue', 'recordGlobal', 'recordImproved',
  'recordCategoriesAbove', 'recordRank', 'recordStreakDays', 'recordsInOneDay'
] as const;
export type Metric = typeof METRICS[number];

/** How a metric accumulates. */
export type MetricMode =
  | 'count'   // add up over the period (answers, matches)
  | 'max';    // keep the best seen (records, streaks, level)

const MAX_METRICS = new Set<Metric>([
  'correctStreak', 'winStreak', 'level', 'loginStreak', 'playStreak', 'winStreakDays',
  'recordValue', 'recordGlobal', 'recordCategoriesAbove', 'recordStreakDays', 'recordsInOneDay',
  'categoriesWon'
]);
/* recordRank is "lower is better", so it needs its own comparison. */
const MIN_METRICS = new Set<Metric>(['recordRank']);

export type MissionKind =
  | 'daily' | 'weekly' | 'achievement' | 'skill' | 'social' | 'economy'
  | 'record' | 'streak' | 'event' | 'chain';

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary' | 'mythic';
export const RARITY_FA: Record<Rarity, string> = {
  common: '🟢 معمولی', rare: '🔵 کمیاب', epic: '🟣 حماسی',
  legendary: '🟠 افسانه‌ای', mythic: '👑 اسطوره‌ای'
};

export type RewardType = 'coins' | 'xp' | 'cup' | 'heart' | 'ticket' | 'cash' | 'lifeline' | 'character' | 'spin' | 'cosmetic';
export interface MissionReward { type: RewardType; amount: number; target?: string; label?: string }

export interface MissionDef {
  id: string;
  kind: MissionKind;
  metric: Metric;
  /** Narrows the metric — a category name for record/topic missions. */
  scope: string;
  target: number;
  title: string;
  description: string;
  icon: string;
  rarity: Rarity;
  rewards: MissionReward[];
  enabled: boolean;
  /** Only offered to players inside this level window. 0 = no bound. */
  minLevel: number;
  maxLevel: number;
  /** Relative chance of being drawn for a daily/weekly set. */
  weight: number;
  /** Chain membership: same chainId, ascending step. */
  chainId: string;
  chainStep: number;
  /** Event window, ISO dates; empty = always. */
  startsAt: string;
  endsAt: string;
  sortOrder: number;
}

export interface MissionProgress {
  missionId: string;
  progress: number;
  target: number;
  completed: boolean;
  claimed: boolean;
}

export class MissionError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    metric TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT '',
    target BIGINT NOT NULL DEFAULT 1,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '🎯',
    rarity TEXT NOT NULL DEFAULT 'common',
    rewards JSONB NOT NULL DEFAULT '[]',
    enabled BOOLEAN NOT NULL DEFAULT true,
    min_level INT NOT NULL DEFAULT 0,
    max_level INT NOT NULL DEFAULT 0,
    weight INT NOT NULL DEFAULT 10,
    chain_id TEXT NOT NULL DEFAULT '',
    chain_step INT NOT NULL DEFAULT 0,
    starts_at TEXT NOT NULL DEFAULT '',
    ends_at TEXT NOT NULL DEFAULT '',
    sort_order INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS missions_kind ON missions(kind, enabled)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS missions_metric ON missions(metric, enabled)`);
  /* Progress is per (user, mission, period). A daily mission has one row per
   * day; an achievement has one row forever, with period ''. */
  await pool.query(`CREATE TABLE IF NOT EXISTS mission_progress (
    user_id TEXT NOT NULL,
    mission_id TEXT NOT NULL,
    period TEXT NOT NULL DEFAULT '',
    progress BIGINT NOT NULL DEFAULT 0,
    completed_at TIMESTAMPTZ,
    claimed_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, mission_id, period))`);
  /* Which missions a player was dealt for a given day/week. */
  await pool.query(`CREATE TABLE IF NOT EXISTS mission_assignments (
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    period TEXT NOT NULL,
    mission_ids JSONB NOT NULL DEFAULT '[]',
    PRIMARY KEY (user_id, kind, period))`);
  /* When the set was finished. The next three are dealt 24 HOURS after that
   * moment, not at the next midnight — «وقتی انجام داد ۲۴ ساعت بعد ۳ تا دیگه
   * فعال بشه» — so somebody who finishes at eleven at night does not get a
   * fresh set an hour later. */
  await pool.query(`ALTER TABLE mission_assignments ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
  /* The box a finished daily set earns. One row per set, so it cannot be opened
   * twice and cannot be lost by a reload — and the contents are STORED at the
   * moment it is opened, not re-read from the config later, or a panel edit
   * would silently rewrite a prize somebody has already been given. */
  await pool.query(`CREATE TABLE IF NOT EXISTS mission_boxes (
    user_id TEXT NOT NULL,
    period TEXT NOT NULL,
    opened_at TIMESTAMPTZ,
    rewards JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, period))`);
  /* Some metrics are not counters. "Five wins in a row" has to know whether the
   * run is still alive; "played ten different topics" has to know which topics
   * were already seen. record() cannot work that out from one event, so the
   * state that survives between events lives here: `value` is the run length or
   * the set size, `members` the distinct set, `marker` the last day counted so a
   * day-streak advances once per day rather than once per match. */
  await pool.query(`CREATE TABLE IF NOT EXISTS mission_counters (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value BIGINT NOT NULL DEFAULT 0,
    marker TEXT NOT NULL DEFAULT '',
    members JSONB NOT NULL DEFAULT '[]',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key))`);
  _schemaReady = true;
}

// ---------------------------------------------------------------- periods ----

/* Days and weeks turn over at Tehran midnight. The server runs on UTC and Iran
 * is +03:30, so a UTC day boundary would reset missions at 03:30 in the
 * morning — mid-evening for nobody and mid-night for everyone. */
const TEHRAN_OFFSET_MS = 3.5 * 3600_000;
export function dayKey(ts = Date.now()): string {
  return new Date(ts + TEHRAN_OFFSET_MS).toISOString().slice(0, 10);
}
export function weekKey(ts = Date.now()): string {
  const d = new Date(ts + TEHRAN_OFFSET_MS);
  /* Saturday starts the week in Iran. */
  const dow = (d.getUTCDay() + 1) % 7;           // Sat=0 … Fri=6
  const start = new Date(d.getTime() - dow * 86_400_000);
  return 'w' + start.toISOString().slice(0, 10);
}
export function periodFor(kind: MissionKind, ts = Date.now()): string {
  if (kind === 'daily') return dayKey(ts);
  if (kind === 'weekly') return weekKey(ts);
  return '';   // everything else is lifetime
}

// ------------------------------------------------------------------- store ----

let _memDefs: MissionDef[] | null = null;
const _memProgress = new Map<string, { progress: number; completedAt: number | null; claimedAt: number | null }>();
const _memAssign = new Map<string, string[]>();
const _memCounters = new Map<string, { value: number; marker: string; members: string[] }>();
const pkey = (u: string, m: string, p: string) => u + '|' + m + '|' + p;
const akey = (u: string, k: string, p: string) => u + '|' + k + '|' + p;
const ckey = (u: string, k: string) => u + '|' + k;

// ---------------------------------------------------------------- counters ----

interface Counter { value: number; marker: string; members: string[] }
const EMPTY_COUNTER: Counter = { value: 0, marker: '', members: [] };

async function readCounter(userId: string, key: string): Promise<Counter> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(
      `SELECT value, marker, members FROM mission_counters WHERE user_id=$1 AND key=$2`, [userId, key]);
    const r = rows[0];
    if (!r) return { ...EMPTY_COUNTER };
    return { value: Number(r.value ?? 0), marker: String(r.marker ?? ''),
             members: Array.isArray(r.members) ? r.members.map(String) : [] };
  }
  const c = _memCounters.get(ckey(userId, key));
  return c ? { ...c, members: c.members.slice() } : { ...EMPTY_COUNTER };
}

async function writeCounter(userId: string, key: string, c: Counter): Promise<void> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO mission_counters(user_id,key,value,marker,members,updated_at)
       VALUES($1,$2,$3,$4,$5,now())
       ON CONFLICT (user_id,key) DO UPDATE SET value=$3, marker=$4, members=$5, updated_at=now()`,
      [userId, key, c.value, c.marker, JSON.stringify(c.members)]);
  } else _memCounters.set(ckey(userId, key), { ...c, members: c.members.slice() });
}

/**
 * A consecutive-run counter: `hit` extends the run, a miss ends it. Returns the
 * run length AFTER this event, which is what a "N in a row" mission compares
 * against. A miss returns 0 and leaves the mission's best-so-far untouched —
 * losing a duel must not undo a five-win streak already banked.
 */
export async function bumpRun(userId: string, key: string, hit: boolean): Promise<number> {
  const c = await readCounter(userId, key);
  const value = hit ? c.value + 1 : 0;
  await writeCounter(userId, key, { ...c, value });
  return value;
}

/**
 * A day-based streak: the first qualifying event of a Tehran day extends it,
 * later events the same day are ignored, and a skipped day restarts it at 1.
 * Returns the streak length in days.
 */
export async function bumpDayStreak(userId: string, key: string, ts = Date.now()): Promise<number> {
  const today = dayKey(ts);
  const c = await readCounter(userId, key);
  if (c.marker === today) return c.value;                 // already counted today
  const yesterday = dayKey(ts - 86_400_000);
  const value = c.marker === yesterday ? c.value + 1 : 1; // gap → back to day one
  await writeCounter(userId, key, { ...c, value, marker: today });
  return value;
}

/**
 * A distinct set: how many different things the player has done. Returns the
 * size after adding, and whether this member was new — "play a topic you have
 * never played" only fires on the new one.
 */
export async function addToSet(userId: string, key: string, member: string): Promise<{ size: number; added: boolean }> {
  const m = String(member ?? '').trim();
  const c = await readCounter(userId, key);
  if (!m || c.members.indexOf(m) >= 0) return { size: c.members.length, added: false };
  const members = [...c.members, m];
  await writeCounter(userId, key, { ...c, value: members.length, members });
  return { size: members.length, added: true };
}

/** Read a counter directly. Tests and the admin panel need to see the streak
 *  state that no mission row exposes. */
export async function counterValue(userId: string, key: string): Promise<number> {
  return (await readCounter(userId, key)).value;
}

function rowToDef(r: any): MissionDef {
  return {
    id: String(r.id), kind: r.kind, metric: r.metric, scope: String(r.scope ?? ''),
    target: Number(r.target ?? 1), title: String(r.title ?? ''), description: String(r.description ?? ''),
    icon: String(r.icon ?? '🎯'), rarity: (r.rarity ?? 'common') as Rarity,
    rewards: Array.isArray(r.rewards) ? r.rewards : [],
    enabled: r.enabled !== false,
    minLevel: Number(r.min_level ?? r.minLevel ?? 0), maxLevel: Number(r.max_level ?? r.maxLevel ?? 0),
    weight: Number(r.weight ?? 10),
    chainId: String(r.chain_id ?? r.chainId ?? ''), chainStep: Number(r.chain_step ?? r.chainStep ?? 0),
    startsAt: String(r.starts_at ?? r.startsAt ?? ''), endsAt: String(r.ends_at ?? r.endsAt ?? ''),
    sortOrder: Number(r.sort_order ?? r.sortOrder ?? 0)
  };
}

export async function listDefs(): Promise<MissionDef[]> {
  await seedIfEmpty();
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT * FROM missions ORDER BY kind, sort_order, id`);
    return rows.map(rowToDef);
  }
  return (_memDefs ?? []).slice();
}

export async function saveDef(input: Partial<MissionDef>): Promise<MissionDef> {
  const title = String(input.title ?? '').trim();
  if (!title) throw new MissionError('TITLE_REQUIRED', 'عنوان مأموریت لازم است.');
  if (input.metric && !(METRICS as readonly string[]).includes(input.metric)) {
    throw new MissionError('UNKNOWN_METRIC', 'این شاخص شناخته‌شده نیست: ' + input.metric);
  }
  const def: MissionDef = {
    id: String(input.id || '').trim() || randomUUID(),
    kind: (input.kind ?? 'daily') as MissionKind,
    metric: (input.metric ?? 'matchesPlayed') as Metric,
    scope: String(input.scope ?? ''),
    target: Math.max(1, Math.floor(Number(input.target ?? 1) || 1)),
    title, description: String(input.description ?? ''),
    icon: String(input.icon ?? '🎯'),
    rarity: (input.rarity ?? 'common') as Rarity,
    rewards: Array.isArray(input.rewards) ? input.rewards.map((r: any) => ({
      type: r?.type ?? 'coins', amount: Math.max(0, Math.floor(Number(r?.amount) || 0)),
      target: String(r?.target ?? ''), label: String(r?.label ?? '')
    })) : [],
    enabled: input.enabled !== false,
    minLevel: Math.max(0, Math.floor(Number(input.minLevel ?? 0) || 0)),
    maxLevel: Math.max(0, Math.floor(Number(input.maxLevel ?? 0) || 0)),
    weight: Math.max(0, Math.floor(Number(input.weight ?? 10) || 0)),
    chainId: String(input.chainId ?? ''),
    chainStep: Math.max(0, Math.floor(Number(input.chainStep ?? 0) || 0)),
    startsAt: String(input.startsAt ?? ''), endsAt: String(input.endsAt ?? ''),
    sortOrder: Math.floor(Number(input.sortOrder ?? 0) || 0)
  };
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO missions(id,kind,metric,scope,target,title,description,icon,rarity,rewards,enabled,
        min_level,max_level,weight,chain_id,chain_step,starts_at,ends_at,sort_order,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())
       ON CONFLICT (id) DO UPDATE SET kind=$2,metric=$3,scope=$4,target=$5,title=$6,description=$7,icon=$8,
        rarity=$9,rewards=$10,enabled=$11,min_level=$12,max_level=$13,weight=$14,chain_id=$15,chain_step=$16,
        starts_at=$17,ends_at=$18,sort_order=$19,updated_at=now()`,
      [def.id, def.kind, def.metric, def.scope, def.target, def.title, def.description, def.icon, def.rarity,
       JSON.stringify(def.rewards), def.enabled, def.minLevel, def.maxLevel, def.weight,
       def.chainId, def.chainStep, def.startsAt, def.endsAt, def.sortOrder]);
  } else {
    if (!_memDefs) _memDefs = [];
    const i = _memDefs.findIndex((d) => d.id === def.id);
    if (i >= 0) _memDefs[i] = def; else _memDefs.push(def);
  }
  return def;
}

export async function deleteDef(missionId: string): Promise<boolean> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rowCount } = await pool.query(`DELETE FROM missions WHERE id=$1`, [missionId]);
    return (rowCount ?? 0) > 0;
  }
  if (!_memDefs) return false;
  const i = _memDefs.findIndex((d) => d.id === missionId);
  if (i < 0) return false;
  _memDefs.splice(i, 1);
  return true;
}

// ------------------------------------------------------------------ seed ----

const R = (type: RewardType, amount: number, target = ''): MissionReward => ({ type, amount, target });

/** The starting pool. Big on purpose — the brief asks for 150–300 so a player
 *  does not see the same five every day — and every row is editable. */
function buildSeed(): Partial<MissionDef>[] {
  const out: Partial<MissionDef>[] = [];
  const add = (d: Partial<MissionDef>) => out.push(d);

  // ---- daily ----
  const dailies: [string, Metric, number, string, Rarity, MissionReward[]][] = [
    ['ورود به بازی', 'login', 1, '🚪', 'common', [R('coins', 50)]],
    ['جایزهٔ روزانه را بگیر', 'dailyClaim', 1, '🎁', 'common', [R('coins', 50)]],
    ['گردونه را بچرخان', 'wheelSpin', 1, '🎡', 'common', [R('coins', 75)]],
    ['به ۲۰ سؤال جواب بده', 'questionsAnswered', 20, '❓', 'common', [R('coins', 150), R('xp', 100)]],
    ['۱۵ جواب درست بده', 'correctAnswers', 15, '✅', 'rare', [R('coins', 200), R('xp', 150)]],
    ['۳ مسابقه انجام بده', 'matchesPlayed', 3, '🎮', 'common', [R('coins', 120)]],
    ['۵ مسابقه انجام بده', 'matchesPlayed', 5, '🎮', 'rare', [R('coins', 220), R('xp', 120)]],
    ['۱ مسابقه ببر', 'matchesWon', 1, '🏆', 'common', [R('coins', 150)]],
    ['۳ مسابقه ببر', 'matchesWon', 3, '🏆', 'rare', [R('coins', 300), R('heart', 1)]],
    ['۵ مسابقه ببر', 'matchesWon', 5, '🏆', 'epic', [R('ticket', 1, 'green'), R('xp', 250)]],
    ['۲۰۰ XP بگیر', 'xpEarned', 200, '⚡', 'common', [R('coins', 150)]],
    ['۵۰۰ XP بگیر', 'xpEarned', 500, '⚡', 'rare', [R('coins', 300), R('heart', 1)]],
    ['یک بلیت استفاده کن', 'ticketsUsed', 1, '🎫', 'rare', [R('coins', 200)]],
    ['در یک مسابقهٔ پولی شرکت کن', 'paidMatch', 1, '💰', 'epic', [R('coins', 400)]],
    ['در یک موضوع تازه بازی کن', 'newCategory', 1, '🧭', 'rare', [R('coins', 180), R('xp', 100)]],
    ['با یک دوست بازی کن', 'friendMatch', 1, '🤝', 'rare', [R('coins', 250)]],
    ['سری به فروشگاه بزن', 'shopVisit', 1, '🛒', 'common', [R('coins', 40)]],
    ['۵۰۰ سکه خرج کن', 'coinsSpent', 500, '🪙', 'rare', [R('xp', 200)]],
    ['یک هدیه بفرست', 'giftSent', 1, '💝', 'rare', [R('coins', 200)]],
    ['یک رکورد تازه ثبت کن', 'recordSet', 1, '🏅', 'rare', [R('coins', 250), R('xp', 150)]],
    ['۱۰ جواب درست پشت سر هم', 'correctStreak', 10, '🔥', 'epic', [R('ticket', 1, 'green')]]
  ];
  /* The flat list the game shipped with. It is kept — an operator may still
   * want «سری به فروشگاه بزن» — but it is no longer DEALT: weight 0 keeps it
   * out of the daily draw so the level ladder below is the only thing a player
   * is handed. Switching one back on in the panel is a weight edit. */
  dailies.forEach(([title, metric, target, icon, rarity, rewards], i) =>
    add({ id: 'd_' + metric + '_' + target, kind: 'daily', metric, target, title, icon, rarity, rewards, weight: 0, sortOrder: i }));

  // ---- the daily LADDER: one band per level, 1 … 100 ----
  out.push(...buildDailyLadder());

  // ---- weekly ----
  const weeklies: [string, Metric, number, string, Rarity, MissionReward[]][] = [
    ['۳۰ مسابقه انجام بده', 'matchesPlayed', 30, '🎮', 'rare', [R('coins', 800), R('xp', 500)]],
    ['۵۰ مسابقه انجام بده', 'matchesPlayed', 50, '🎮', 'epic', [R('ticket', 1, 'blue')]],
    ['۱۵ مسابقه ببر', 'matchesWon', 15, '🏆', 'rare', [R('coins', 1000)]],
    ['۳۰ مسابقه ببر', 'matchesWon', 30, '🏆', 'epic', [R('ticket', 1, 'blue'), R('xp', 800)]],
    ['۳۰۰ جواب درست بده', 'correctAnswers', 300, '✅', 'epic', [R('coins', 1200), R('xp', 700)]],
    ['۵۰۰۰ XP بگیر', 'xpEarned', 5000, '⚡', 'epic', [R('ticket', 1, 'blue')]],
    ['۱۰ بلیت استفاده کن', 'ticketsUsed', 10, '🎫', 'epic', [R('coins', 1500)]],
    ['در ۲۰ مسابقهٔ پولی شرکت کن', 'paidMatch', 20, '💰', 'legendary', [R('ticket', 1, 'red')]],
    ['یک دوست دعوت کن', 'invites', 1, '📨', 'rare', [R('coins', 700), R('heart', 2)]],
    ['در ۱۰ موضوع مختلف بازی کن', 'newCategory', 10, '🧭', 'epic', [R('coins', 1000), R('xp', 600)]],
    ['۷ روز پشت سر هم وارد شو', 'loginStreak', 7, '📅', 'epic', [R('ticket', 1, 'blue'), R('coins', 500)]]
  ];
  weeklies.forEach(([title, metric, target, icon, rarity, rewards], i) =>
    add({ id: 'w_' + metric + '_' + target, kind: 'weekly', metric, target, title, icon, rarity, rewards, weight: 10, sortOrder: i }));

  // ---- achievements: matches, wins, correct answers, level ----
  const ach = (metric: Metric, n: number, title: string, icon: string, rarity: Rarity, rewards: MissionReward[]) =>
    add({ id: 'a_' + metric + '_' + n, kind: 'achievement', metric, target: n, title, icon, rarity, rewards, weight: 0 });
  [1, 10, 50, 100, 500, 1000].forEach((n, i) =>
    ach('matchesPlayed', n, n === 1 ? 'اولین مسابقه' : n + ' مسابقه', '🎮',
      (['common','common','rare','epic','legendary','mythic'] as Rarity[])[i]!, [R('coins', n * 20 + 100), R('xp', n * 10 + 50)]));
  [1, 10, 50, 100, 500, 1000, 5000].forEach((n, i) =>
    ach('matchesWon', n, n === 1 ? 'اولین برد' : n + ' برد', '🏆',
      (['common','common','rare','epic','legendary','mythic','mythic'] as Rarity[])[i]!, [R('coins', n * 30 + 150), R('xp', n * 12 + 80)]));
  [100, 500, 1000, 5000, 10000].forEach((n, i) =>
    ach('correctAnswers', n, n + ' پاسخ صحیح', '✅',
      (['common','rare','epic','legendary','mythic'] as Rarity[])[i]!, [R('coins', Math.round(n / 2) + 200)]));
  for (let lv = 10; lv <= 100; lv += 10) {
    ach('level', lv, 'رسیدن به لول ' + lv, '🎖️',
      lv >= 80 ? 'mythic' : lv >= 50 ? 'legendary' : lv >= 30 ? 'epic' : 'rare',
      [R('coins', lv * 100), R('ticket', lv >= 50 ? 1 : 0, 'blue')].filter((r) => r.amount > 0));
  }

  // ---- skill ----
  const skill = (metric: Metric, n: number, title: string, icon: string, rarity: Rarity, rewards: MissionReward[]) =>
    add({ id: 's_' + metric + '_' + n, kind: 'skill', metric, target: n, title, icon, rarity, rewards, weight: 0 });
  [5, 10, 20].forEach((n, i) => skill('correctStreak', n, n + ' پاسخ صحیح پشت سر هم', '🔥',
    (['rare','epic','legendary'] as Rarity[])[i]!, [R('coins', n * 60), R('xp', n * 25)]));
  [3, 5, 10].forEach((n, i) => skill('winStreak', n, n + ' برد متوالی', '⚡',
    (['rare','epic','legendary'] as Rarity[])[i]!, [R('coins', n * 120), R('ticket', n >= 10 ? 1 : 0, 'green')].filter((r) => r.amount > 0)));
  skill('flawlessWin', 1, 'برد بدون اشتباه', '💎', 'epic', [R('coins', 600), R('xp', 300)]);
  skill('beatHigherLevel', 1, 'برد مقابل بازیکن قوی‌تر', '🥊', 'epic', [R('coins', 500)]);
  skill('categoriesWon', 5, 'برد در ۵ موضوع مختلف', '🧭', 'epic', [R('coins', 800)]);

  // ---- social ----
  const social = (metric: Metric, n: number, title: string, icon: string, rarity: Rarity, rewards: MissionReward[]) =>
    add({ id: 'so_' + metric + '_' + n, kind: 'social', metric, target: n, title, icon, rarity, rewards, weight: 0 });
  [1, 5].forEach((n) => social('friendsAdded', n, n === 1 ? 'اولین دوست' : n + ' دوست', '🤝', n === 1 ? 'common' : 'rare', [R('coins', n * 150 + 100)]));
  [1, 5].forEach((n) => social('invites', n, n === 1 ? 'دعوت از یک دوست' : 'دعوت از ' + n + ' دوست', '📨', n === 1 ? 'rare' : 'epic', [R('coins', n * 300 + 200), R('heart', n)]));
  social('friendMatch', 1, 'مسابقه با دوست', '🎮', 'common', [R('coins', 200)]);
  social('giftSent', 1, 'ارسال هدیه', '💝', 'common', [R('coins', 150)]);
  social('giftReceived', 1, 'دریافت هدیه', '🎁', 'common', [R('coins', 150)]);

  // ---- economy ----
  const eco = (metric: Metric, n: number, title: string, icon: string, rarity: Rarity, rewards: MissionReward[]) =>
    add({ id: 'e_' + metric + '_' + n, kind: 'economy', metric, target: n, title, icon, rarity, rewards, weight: 0 });
  [1, 5, 20].forEach((n) => eco('ticketsBought', n, n === 1 ? 'خرید اولین بلیت' : 'خرید ' + n + ' بلیت', '🎫',
    n === 1 ? 'common' : n === 5 ? 'rare' : 'epic', [R('coins', n * 100 + 200)]));
  eco('deposit', 1, 'اولین شارژ کیف پول', '💳', 'rare', [R('coins', 500)]);
  eco('withdrawal', 1, 'اولین برداشت', '🏦', 'epic', [R('coins', 800)]);
  eco('cashPrize', 1, 'اولین جایزهٔ نقدی', '💰', 'epic', [R('coins', 1000)]);
  eco('coinsSpent', 1000, 'خرج کردن ۱۰۰۰ سکه', '🪙', 'rare', [R('xp', 400)]);

  // ---- streak ----
  [3, 7, 15, 30, 60].forEach((n, i) =>
    add({ id: 'st_login_' + n, kind: 'streak', metric: 'loginStreak', target: n,
      title: 'ورود ' + n + ' روز متوالی', icon: '📅',
      rarity: (['common','rare','epic','legendary','mythic'] as Rarity[])[i]!,
      rewards: [R('coins', n * 80), R('ticket', n >= 15 ? 1 : 0, 'green')].filter((r) => r.amount > 0), weight: 0 }));
  add({ id: 'st_play_3', kind: 'streak', metric: 'playStreak', target: 3, title: '۳ روز متوالی مسابقه بده', icon: '🎮', rarity: 'rare', rewards: [R('coins', 400)], weight: 0 });
  add({ id: 'st_win_7', kind: 'streak', metric: 'winStreakDays', target: 7, title: '۷ روز متوالی برنده شو', icon: '🏆', rarity: 'legendary', rewards: [R('ticket', 1, 'red')], weight: 0 });
  add({ id: 'st_rec_7', kind: 'streak', metric: 'recordStreakDays', target: 7, title: '۷ روز متوالی رکورد ثبت کن', icon: '🏅', rarity: 'legendary', rewards: [R('ticket', 1, 'blue'), R('coins', 1500)], weight: 0 });

  // ---- record: per category, plus the global ladder and combined goals ----
  const thresholds = [1, 5, 10, 15, 20, 30, 40, 50, 75, 100];
  const rarityFor = (n: number): Rarity =>
    n >= 75 ? 'mythic' : n >= 40 ? 'legendary' : n >= 20 ? 'epic' : n >= 10 ? 'rare' : 'common';
  for (const c of recordCategories()) {
    for (const n of thresholds) {
      add({ id: 'r_' + c.name + '_' + n, kind: 'record', metric: 'recordValue', scope: c.name, target: n,
        title: n === 1 ? ('اولین رکورد ' + c.name) : ('رکورد ' + c.name + ' را به ' + n + ' برسان'),
        icon: c.icon, rarity: rarityFor(n),
        rewards: [R('coins', n * 40 + 100), R('xp', n * 15 + 50)], weight: 0 });
    }
  }
  [1, 20, 30, 50, 75, 100].forEach((n) =>
    add({ id: 'rg_' + n, kind: 'record', metric: 'recordGlobal', target: n,
      title: n === 1 ? 'اولین رکورد کلی' : 'رکورد کلی ' + n, icon: '🌍', rarity: rarityFor(n),
      rewards: [R('coins', n * 60 + 200), R('xp', n * 20 + 100)], weight: 0 }));
  add({ id: 'rc_5_20', kind: 'record', metric: 'recordCategoriesAbove', scope: '20', target: 5,
    title: 'در ۵ موضوع رکورد بالای ۲۰ ثبت کن', icon: '🎯', rarity: 'epic', rewards: [R('ticket', 1, 'blue')], weight: 0 });
  add({ id: 'rc_10_30', kind: 'record', metric: 'recordCategoriesAbove', scope: '30', target: 10,
    title: 'در ۱۰ موضوع رکورد بالای ۳۰ ثبت کن', icon: '🎯', rarity: 'legendary', rewards: [R('ticket', 1, 'red')], weight: 0 });
  [5, 10, 20].forEach((n) =>
    add({ id: 'ri_' + n, kind: 'record', metric: 'recordImproved', target: n,
      title: 'رکورد خودت را ' + n + ' بار ارتقا بده', icon: '📈',
      rarity: n >= 20 ? 'epic' : 'rare', rewards: [R('coins', n * 120)], weight: 0 }));
  add({ id: 'rd_5', kind: 'record', metric: 'recordsInOneDay', target: 5, title: 'در یک روز ۵ رکورد تازه ثبت کن', icon: '⚡', rarity: 'epic', rewards: [R('coins', 900)], weight: 0 });
  [100, 50, 10, 1].forEach((n) =>
    add({ id: 'rr_' + n, kind: 'record', metric: 'recordRank', target: n,
      title: n === 1 ? 'رتبهٔ اول یک موضوع' : 'ورود به ' + n + ' نفر برتر یک موضوع', icon: '📊',
      rarity: n === 1 ? 'mythic' : n <= 10 ? 'legendary' : n <= 50 ? 'epic' : 'rare',
      rewards: [R('coins', 2000 / Math.max(1, n) * 10 + 300)], weight: 0 }));

  // ---- a starter chain ----
  const chain: [string, Metric, number, string][] = [
    ['یک مسابقه ببر', 'matchesWon', 1, '🏆'],
    ['به ۱۰ سؤال درست جواب بده', 'correctAnswers', 10, '✅'],
    ['یک رکورد تازه ثبت کن', 'recordSet', 1, '🏅'],
    ['در یک مسابقهٔ پولی شرکت کن', 'paidMatch', 1, '💰'],
    ['۵ برد متوالی بگیر', 'winStreak', 5, '⚡']
  ];
  chain.forEach(([title, metric, target, icon], i) =>
    add({ id: 'ch_start_' + (i + 1), kind: 'chain', chainId: 'starter', chainStep: i + 1,
      metric, target, title, icon, rarity: i === chain.length - 1 ? 'legendary' : 'rare',
      rewards: i === chain.length - 1 ? [R('ticket', 1, 'blue'), R('coins', 2000)] : [R('coins', 200 * (i + 1))],
      weight: 0, sortOrder: i }));

  return out;
}

/* THE DAILY LADDER.
 *
 * «ماموریت ۱ لول ۱، ماموریت ۱۰۰ لول ۱۰۰ و سخت‌تر» — a mission belongs to a
 * level, and the higher the level the more it asks for. Writing a hundred of
 * them by hand would be a hundred chances to typo a number, so the ladder is
 * GENERATED from a handful of shapes and one growth curve each. What the panel
 * gets is still ordinary rows it can edit or switch off one by one.
 *
 * Four missions per level, three dealt — so two players at the same level do
 * not always see the same three, and a mission the player cannot stand is not
 * the only thing between them and the box.
 *
 * Every rung pays cup AND xp, because the cup is what the weekly league is
 * played for and missions are the steady way to earn it.
 */
interface Rung { metric: Metric; title: (n: number) => string; icon: string; at: (lv: number) => number }
const DAILY_RUNGS: Rung[] = [
  { metric: 'questionsAnswered', icon: '❓', at: (lv) => 10 + 2 * (lv - 1),            title: (n) => `به ${n} سؤال جواب بده` },
  { metric: 'correctAnswers',    icon: '✅', at: (lv) => 5 + Math.round(1.5 * (lv - 1)), title: (n) => `${n} جواب درست بده` },
  { metric: 'matchesPlayed',     icon: '🎮', at: (lv) => 2 + Math.floor((lv - 1) / 6),  title: (n) => `${n} مسابقه انجام بده` },
  { metric: 'matchesWon',        icon: '🏆', at: (lv) => 1 + Math.floor((lv - 1) / 8),  title: (n) => `${n} مسابقه ببر` },
  { metric: 'xpEarned',          icon: '⚡', at: (lv) => 150 + 40 * (lv - 1),           title: (n) => `${n} XP بگیر` },
  { metric: 'correctStreak',     icon: '🔥', at: (lv) => 3 + Math.floor((lv - 1) / 10), title: (n) => `${n} جواب درست پشت سر هم` },
  { metric: 'coinsSpent',        icon: '🪙', at: (lv) => 200 + 60 * (lv - 1),           title: (n) => `${n} سکه خرج کن` },
  { metric: 'newCategory',       icon: '🧭', at: (lv) => 1 + Math.floor((lv - 1) / 25), title: (n) => n === 1 ? 'در یک موضوع تازه بازی کن' : `در ${n} موضوع تازه بازی کن` }
];
export const DAILY_LADDER_LEVELS = 100;
export const DAILY_PER_LEVEL = 4;

function rungRarity(lv: number): Rarity {
  return lv >= 80 ? 'mythic' : lv >= 60 ? 'legendary' : lv >= 35 ? 'epic' : lv >= 15 ? 'rare' : 'common';
}

export function buildDailyLadder(): MissionDef[] {
  const out: MissionDef[] = [];
  for (let lv = 1; lv <= DAILY_LADDER_LEVELS; lv++) {
    for (let k = 0; k < DAILY_PER_LEVEL; k++) {
      /* Rotating the starting rung by level keeps neighbouring levels from
       * being the same four missions with bigger numbers. */
      const rung = DAILY_RUNGS[(lv * 3 + k) % DAILY_RUNGS.length]!;
      const target = Math.max(1, rung.at(lv));
      out.push({
        id: `dl_${lv}_${k + 1}`,
        kind: 'daily', metric: rung.metric, scope: '', target,
        title: rung.title(target), description: '', icon: rung.icon,
        rarity: rungRarity(lv),
        rewards: [
          { type: 'cup', amount: 5 + Math.floor(lv / 2) },
          { type: 'xp', amount: 40 + 8 * lv },
          { type: 'coins', amount: 60 + 12 * lv }
        ],
        enabled: true,
        /* One level, one band. The set a player is dealt is the set for the
         * level they are on — which is what «لول‌بندی» means. The TOP rung has
         * no ceiling: a player who passes level 100 must not fall off the end
         * of the ladder and be dealt nothing at all. */
        minLevel: lv, maxLevel: lv === DAILY_LADDER_LEVELS ? 0 : lv,
        weight: 10, chainId: '', chainStep: 0, startsAt: '', endsAt: '', sortOrder: k
      });
    }
  }
  return out;
}

let _seeded = false;
async function seedIfEmpty(): Promise<void> {
  if (_seeded) return;
  _seeded = true;
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM missions`);
    if (rows[0]?.n > 0) { await seedDailyLadder(pool); return; }
  } else if (_memDefs && _memDefs.length) return;
  else _memDefs = [];
  for (const d of buildSeed()) await saveDef(d);
  logger.info('missions_seeded', { count: (await listDefs()).length });
}

/* A LIVE GAME ALREADY HAS MISSIONS, so the seed above never runs again — which
 * would leave every existing player on the old flat dailies for ever. The
 * ladder therefore installs itself separately, once, and quiets the flat list
 * as it goes. It touches nothing an operator has edited by hand: only the rows
 * this file wrote in the first place. */
async function seedDailyLadder(pool: NonNullable<ReturnType<typeof pg>>): Promise<void> {
  try {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM missions WHERE id LIKE 'dl\\_%'`);
    if (rows[0]?.n > 0) return;
    for (const d of buildDailyLadder()) await saveDef(d);
    await pool.query(`UPDATE missions SET weight=0 WHERE kind='daily' AND id LIKE 'd\\_%'`);
    logger.info('mission_daily_ladder_installed', { rungs: DAILY_LADDER_LEVELS * DAILY_PER_LEVEL });
  } catch (e) {
    logger.warn('mission_daily_ladder_failed', { message: (e as Error).message });
  }
}


// -------------------------------------------------------------- progress ----

async function readProgress(userId: string, missionId: string, period: string) {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(
      `SELECT progress, completed_at, claimed_at FROM mission_progress WHERE user_id=$1 AND mission_id=$2 AND period=$3`,
      [userId, missionId, period]);
    const r = rows[0];
    return { progress: Number(r?.progress ?? 0),
             completedAt: r?.completed_at ? new Date(r.completed_at).getTime() : null,
             claimedAt: r?.claimed_at ? new Date(r.claimed_at).getTime() : null };
  }
  return _memProgress.get(pkey(userId, missionId, period)) ?? { progress: 0, completedAt: null, claimedAt: null };
}

async function writeProgress(userId: string, missionId: string, period: string,
                             v: { progress: number; completedAt: number | null; claimedAt: number | null }) {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO mission_progress(user_id,mission_id,period,progress,completed_at,claimed_at)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id,mission_id,period) DO UPDATE SET progress=$4, completed_at=$5, claimed_at=$6`,
      [userId, missionId, period, v.progress,
       v.completedAt ? new Date(v.completedAt) : null, v.claimedAt ? new Date(v.claimedAt) : null]);
  } else _memProgress.set(pkey(userId, missionId, period), { ...v });
}

// ------------------------------------------------------------ assignment ----

/* A deterministic shuffle from (userId, period): the same player gets the same
 * set all day even across servers and restarts, and two players get different
 * sets. Random would re-deal on every request. */
function seededOrder<T>(items: T[], seed: string): T[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; };
  return items.map((v) => ({ v, k: rnd() })).sort((a, b) => a.k - b.k).map((x) => x.v);
}

function inWindow(d: MissionDef, now: number): boolean {
  if (d.startsAt && Date.parse(d.startsAt) > now) return false;
  if (d.endsAt && Date.parse(d.endsAt) < now) return false;
  return true;
}
function levelOk(d: MissionDef, level: number): boolean {
  if (d.minLevel && level < d.minLevel) return false;
  if (d.maxLevel && level > d.maxLevel) return false;
  return true;
}

export interface AssignCounts { daily: number; weekly: number }
/* Three a day. Enough that finishing them is a session's work, few enough that
 * the box at the end is reachable. */
export const ASSIGN_DEFAULT: AssignCounts = { daily: 3, weekly: 3 };

/**
 * THE SET DOES NOT MOVE UNTIL IT IS DONE.
 *
 * «اگه کاربر ماموریت‌ها را انجام نده... ۱۰ روز هم بگذره عوض نمی‌شن» — a daily
 * set that is re-dealt every midnight punishes the player who was busy: they
 * see three new missions and the three they had half-finished are gone. So the
 * period a daily set lives in is the day it was DEALT, not today, and it stays
 * live until all three are completed. The day after that, a new set.
 *
 * Everything a daily touches — progress, claims, the box — is keyed by this
 * period rather than by today, or a mission dealt on Monday would be recording
 * Thursday's answers into a row nobody reads.
 */
async function latestDailyPeriod(userId: string): Promise<string | null> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(
      `SELECT period FROM mission_assignments WHERE user_id=$1 AND kind='daily' ORDER BY period DESC LIMIT 1`, [userId]);
    return rows[0] ? String(rows[0].period) : null;
  }
  const mine = [...(_memAssign.keys() as any)]
    .filter((k: string) => k.startsWith(userId + '|daily|'))
    .map((k: string) => k.split('|')[2] as string)
    .sort();
  return mine.length ? mine[mine.length - 1]! : null;
}

/** True when every mission in `ids` is finished for that period. */
async function setComplete(userId: string, ids: string[], period: string): Promise<boolean> {
  if (!ids.length) return false;
  for (const mid of ids) {
    const p = await readProgress(userId, mid, period);
    if (!p.completedAt) return false;
  }
  return true;
}

/** How long after finishing the three the next three arrive. */
export const DAILY_COOLDOWN_MS = 24 * 60 * 60_000;

const _memDone = new Map<string, number>();

/** When this set was finished, or 0. */
export async function setFinishedAt(userId: string, period: string): Promise<number> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(
      `SELECT completed_at FROM mission_assignments WHERE user_id=$1 AND kind='daily' AND period=$2`, [userId, period]);
    return rows[0]?.completed_at ? new Date(rows[0].completed_at).getTime() : 0;
  }
  return _memDone.get(akey(userId, 'daily', period)) ?? 0;
}

/** Stamp the moment the third one landed. Written once and never moved. */
export async function markSetFinished(userId: string, period: string, at: number): Promise<void> {
  if (await setFinishedAt(userId, period)) return;
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `UPDATE mission_assignments SET completed_at=$3 WHERE user_id=$1 AND kind='daily' AND period=$2 AND completed_at IS NULL`,
      [userId, period, new Date(at)]);
    return;
  }
  _memDone.set(akey(userId, 'daily', period), at);
}

/** The period the player's live daily set belongs to. */
export async function activeDailyPeriod(userId: string, now = Date.now()): Promise<string> {
  const today = dayKey(now);
  const last = await latestDailyPeriod(userId);
  if (!last) return today;
  const ids = await readAssignment(userId, 'daily', last);
  if (!(await setComplete(userId, ids, last))) return last;   // unfinished → frozen

  /* Finished. The clock starts at the moment it was finished — and if nothing
   * stamped it (a set completed before this rule existed), it starts now, so
   * the player waits a day rather than being handed a set instantly. */
  let doneAt = await setFinishedAt(userId, last);
  if (!doneAt) { await markSetFinished(userId, last, now); doneAt = now; }
  if (now - doneAt < DAILY_COOLDOWN_MS) return last;
  /* A new set. Its period is today's key unless that is the one just finished,
   * in which case the next day's — two sets cannot share a period, or the
   * second would inherit the first's finished progress. */
  return today > last ? today : dayKey(now + 86_400_000);
}

/** When the next three arrive, or 0 while the current set is unfinished. */
export async function nextDailySetAt(userId: string, now = Date.now()): Promise<number> {
  const last = await latestDailyPeriod(userId);
  if (!last) return 0;
  const ids = await readAssignment(userId, 'daily', last);
  if (!(await setComplete(userId, ids, last))) return 0;
  const doneAt = await setFinishedAt(userId, last);
  return doneAt ? doneAt + DAILY_COOLDOWN_MS : now + DAILY_COOLDOWN_MS;
}

async function readAssignment(userId: string, kind: 'daily' | 'weekly', period: string): Promise<string[]> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(
      `SELECT mission_ids FROM mission_assignments WHERE user_id=$1 AND kind=$2 AND period=$3`, [userId, kind, period]);
    return rows[0] ? ((rows[0].mission_ids as string[]) ?? []) : [];
  }
  return _memAssign.get(akey(userId, kind, period)) ?? [];
}

/** The period a mission's progress is written under, for this player. */
export async function periodForUser(userId: string, kind: MissionKind, now = Date.now()): Promise<string> {
  if (kind === 'daily') return activeDailyPeriod(userId, now);
  return periodFor(kind, now);
}

async function assignmentFor(userId: string, kind: 'daily' | 'weekly', count: number): Promise<string[]> {
  const period = kind === 'daily' ? await activeDailyPeriod(userId) : periodFor(kind);
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(
      `SELECT mission_ids FROM mission_assignments WHERE user_id=$1 AND kind=$2 AND period=$3`, [userId, kind, period]);
    if (rows[0]) return (rows[0].mission_ids as string[]) ?? [];
  } else {
    const cached = _memAssign.get(akey(userId, kind, period));
    if (cached) return cached;
  }

  const user = await repositories.users.findById(userId).catch(() => null);
  const level = Number(user?.level ?? 1) || 1;
  const now = Date.now();
  const pool2 = (await listDefs())
    .filter((d) => d.kind === kind && d.enabled && d.weight > 0 && inWindow(d, now) && levelOk(d, level));
  /* Weight is honoured by repeating an entry, so a heavier mission is simply
   * more likely to land in the shuffle's first `count`. */
  const bag: string[] = [];
  for (const d of pool2) for (let i = 0; i < Math.max(1, Math.round(d.weight / 5)); i++) bag.push(d.id);
  const picked: string[] = [];
  for (const idr of seededOrder(bag, userId + '|' + period)) {
    if (picked.indexOf(idr) < 0) picked.push(idr);
    if (picked.length >= count) break;
  }

  if (pool) {
    await pool.query(
      `INSERT INTO mission_assignments(user_id,kind,period,mission_ids) VALUES($1,$2,$3,$4)
       ON CONFLICT (user_id,kind,period) DO UPDATE SET mission_ids=$4`,
      [userId, kind, period, JSON.stringify(picked)]);
  } else _memAssign.set(akey(userId, kind, period), picked);
  return picked;
}

// ---------------------------------------------------------------- record ----

/** Report something the player did. Advances every live mission on that metric.
 *  `at` exists so a test can play a day forward; the game always passes now. */
export async function record(userId: string, metric: Metric, amount = 1, scope = '', at = Date.now()): Promise<void> {
  if (!(METRICS as readonly string[]).includes(metric)) return;
  const now = at;
  const defs = (await listDefs()).filter((d) =>
    d.enabled && d.metric === metric && inWindow(d, now) &&
    /* A scoped mission only listens to its own scope. */
    (!d.scope || d.scope === scope || metric === 'recordCategoriesAbove'));
  if (!defs.length) return;

  /* Dailies and weeklies only count when they were actually dealt today —
   * otherwise every mission in the pool would quietly accumulate and a player
   * could be handed one already finished. */
  const dailyIds = await assignmentFor(userId, 'daily', ASSIGN_DEFAULT.daily);
  const weeklyIds = await assignmentFor(userId, 'weekly', ASSIGN_DEFAULT.weekly);

  const dailyPeriod = await activeDailyPeriod(userId, now);
  let touchedDaily = false;
  for (const d of defs) {
    if (d.kind === 'daily' && dailyIds.indexOf(d.id) < 0) continue;
    if (d.kind === 'weekly' && weeklyIds.indexOf(d.id) < 0) continue;
    const period = d.kind === 'daily' ? dailyPeriod : periodFor(d.kind);
    const cur = await readProgress(userId, d.id, period);
    if (cur.claimedAt) continue;

    let next = cur.progress;
    if (MAX_METRICS.has(metric)) next = Math.max(cur.progress, amount);
    else if (MIN_METRICS.has(metric)) next = cur.progress === 0 ? amount : Math.min(cur.progress, amount);
    else next = cur.progress + amount;

    const done = MIN_METRICS.has(metric) ? next <= d.target : next >= d.target;
    if (next === cur.progress && !!cur.completedAt === done) continue;
    await writeProgress(userId, d.id, period, {
      progress: next, completedAt: done ? (cur.completedAt ?? now) : null, claimedAt: null
    });
    if (d.kind === 'daily') touchedDaily = true;
  }

  /* The 24-hour clock starts HERE — the moment the third one lands — not the
   * next time the board happens to be read. Stamped where completion actually
   * happens, or a player who finishes at ten and opens the app at eight would
   * be made to wait until eight the next evening. */
  if (touchedDaily && await setComplete(userId, dailyIds, dailyPeriod)) {
    await markSetFinished(userId, dailyPeriod, now);
  }
}

/* Missions must never be able to break a game. A mission table that is briefly
 * unreachable is a cosmetic problem; a duel that fails to settle because of it
 * is not. Every reporter below is fire-and-forget through this. */
async function quietly(what: string, fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); } catch (e) {
    logger.warn('mission_record_failed', { what, detail: e instanceof Error ? e.message : 'unknown' });
  }
}

// ------------------------------------------------------- activity reporters ----

/* The game modes report WHAT HAPPENED; which metrics that touches is decided
 * here. Keeping the mapping in one place is what stops a new mode from
 * silently supporting only half the mission list — the reason «یک مسابقه ببر»
 * never completed while the record-mode missions did was that only record mode
 * had ever been wired up. */

/** One answered question, in any mode. `streak` is the player's current run of
 *  correct answers within that match (0 after a wrong one). */
export async function recordAnswer(userId: string, correct: boolean, streak = 0): Promise<void> {
  if (!userId || userId.startsWith('bot_')) return;
  await quietly('answer', async () => {
    await record(userId, 'questionsAnswered', 1);
    if (correct) {
      await record(userId, 'correctAnswers', 1);
      if (streak > 0) await record(userId, 'correctStreak', streak);
    }
  });
}

/** One finished match, from one player's side. Covers duel, Last Survivor and
 *  any future mode: the caller states the facts, this decides the metrics. */
export interface MatchOutcome {
  userId: string;
  won: boolean;
  /** A real-money match (an entry ticket or stake was at risk). */
  paid?: boolean;
  /** Every question category the match actually served — one for Last Survivor
   *  (a room is one topic), possibly several for a duel, whose adaptive
   *  difficulty picks a question per round. Drives newCategory/categoriesWon. */
  categories?: string[];
  /** XP the player earned from this match. */
  xp?: number;
  /** Cash prize actually paid, in toman. */
  cashPrize?: number;
  /** Entry tickets really spent (not refunded). */
  ticketsUsed?: number;
  /** Won without a single wrong answer. */
  flawless?: boolean;
  /** Levels, when known — "beat someone above your level". */
  myLevel?: number;
  opponentLevel?: number;
  /** The opponent was on the player's friend list. */
  friendMatch?: boolean;
  at?: number;
}
export async function recordMatch(o: MatchOutcome): Promise<void> {
  const userId = o.userId;
  if (!userId || userId.startsWith('bot_')) return;
  const at = o.at ?? Date.now();
  await quietly('match', async () => {
    await record(userId, 'matchesPlayed', 1);
    if (o.paid) await record(userId, 'paidMatch', 1);
    if (o.ticketsUsed && o.ticketsUsed > 0) await record(userId, 'ticketsUsed', o.ticketsUsed);
    if (o.xp && o.xp > 0) await record(userId, 'xpEarned', Math.round(o.xp));
    if (o.cashPrize && o.cashPrize > 0) await record(userId, 'cashPrize', Math.round(o.cashPrize));
    if (o.friendMatch) await record(userId, 'friendMatch', 1);

    /* A topic counts as "new" the first time it is ever played, not every time
     * — otherwise «۵ موضوع تازه را امتحان کن» would finish in one topic. */
    const cats = (o.categories ?? []).filter(Boolean);
    for (const c of cats) {
      const seen = await addToSet(userId, 'categoriesPlayed', c);
      if (seen.added) await record(userId, 'newCategory', 1, c);
    }

    /* Playing at all extends the play streak; the day-streak counters only move
     * once per Tehran day however many matches are played. */
    await record(userId, 'playStreak', await bumpDayStreak(userId, 'playStreak', at));

    if (o.won) {
      await record(userId, 'matchesWon', 1);
      if (o.flawless) await record(userId, 'flawlessWin', 1);
      if (o.opponentLevel && o.myLevel && o.opponentLevel > o.myLevel) await record(userId, 'beatHigherLevel', 1);
      for (const c of cats) {
        const won = await addToSet(userId, 'categoriesWon', c);
        await record(userId, 'categoriesWon', won.size);
      }
      await record(userId, 'winStreakDays', await bumpDayStreak(userId, 'winStreakDays', at));
    }
    /* The consecutive-win run ends on a loss, so it is bumped either way. */
    const run = await bumpRun(userId, 'winStreak', o.won);
    if (run > 0) await record(userId, 'winStreak', run);
  });
}

/** The player opened the app today. Also drives the login-streak missions. */
export async function recordLogin(userId: string, at = Date.now()): Promise<void> {
  if (!userId) return;
  await quietly('login', async () => {
    await record(userId, 'login', 1);
    await record(userId, 'loginStreak', await bumpDayStreak(userId, 'loginStreak', at));
  });
}

/** Something was bought. `coins`/`cash` is the price actually charged. */
export async function recordPurchase(userId: string, input: {
  coins?: number; tickets?: number; effectKey?: string;
}): Promise<void> {
  if (!userId) return;
  await quietly('purchase', async () => {
    if (input.coins && input.coins > 0) await record(userId, 'coinsSpent', Math.round(input.coins));
    if (input.tickets && input.tickets > 0) await record(userId, 'ticketsBought', Math.round(input.tickets));
  });
}

/** Money in and out of the wallet. */
export async function recordMoney(userId: string, kind: 'deposit' | 'withdrawal', amount: number): Promise<void> {
  if (!userId || !(amount > 0)) return;
  await quietly('money', () => record(userId, kind, Math.round(amount)));
}

/** Social: a new friend on both sides, an invite accepted, a gift moved. */
export async function recordSocial(userId: string, metric: 'friendsAdded' | 'invites' | 'giftSent' | 'giftReceived', amount = 1): Promise<void> {
  if (!userId) return;
  await quietly('social', () => record(userId, metric, amount));
}

// ------------------------------------------------------------------ view ----

export interface MissionView extends MissionDef {
  progress: number;
  completed: boolean;
  claimed: boolean;
  rarityLabel: string;
}

async function viewOf(userId: string, d: MissionDef, at = Date.now()): Promise<MissionView> {
  const p = await readProgress(userId, d.id, await periodForUser(userId, d.kind, at));
  return { ...d, progress: p.progress, completed: !!p.completedAt, claimed: !!p.claimedAt,
           rarityLabel: RARITY_FA[d.rarity] ?? d.rarity };
}

/** One mission's state for this player. The board only shows the forty most
 *  relevant of several hundred, so anything wanting a specific mission — a
 *  detail view, a test — asks for it directly. */
export async function progressOf(userId: string, missionId: string, at = Date.now()): Promise<MissionView | null> {
  const def = (await listDefs()).find((d) => d.id === missionId);
  return def ? viewOf(userId, def, at) : null;
}

/** Everything the missions screen shows. */
export async function boardFor(userId: string): Promise<{
  daily: MissionView[]; weekly: MissionView[]; achievements: MissionView[];
  chain: { chainId: string; step: MissionView | null; total: number; done: number } | null;
  resetsAt: { daily: number; weekly: number };
  box: BoxView;
  /** False while the set is unfinished — it is frozen until it is done, so the
   *  midnight in `resetsAt.daily` is not when THIS player's set changes. */
  dailyRotates: boolean;
  /** When the next three arrive; 0 while the current three are unfinished. */
  nextSetAt: number;
}> {
  const defs = await listDefs();
  const byId = new Map(defs.map((d) => [d.id, d]));
  const now = Date.now();
  const user = await repositories.users.findById(userId).catch(() => null);
  const level = Number(user?.level ?? 1) || 1;

  const dailyIds = await assignmentFor(userId, 'daily', ASSIGN_DEFAULT.daily);
  const weeklyIds = await assignmentFor(userId, 'weekly', ASSIGN_DEFAULT.weekly);
  const daily = await Promise.all(dailyIds.map((i) => byId.get(i)).filter(Boolean).map((d) => viewOf(userId, d!)));
  const weekly = await Promise.all(weeklyIds.map((i) => byId.get(i)).filter(Boolean).map((d) => viewOf(userId, d!)));

  /* The long-lived kinds: show what is in progress or freshly done, not all
   * three hundred at once. */
  const longKinds: MissionKind[] = ['achievement', 'skill', 'social', 'economy', 'record', 'streak', 'event'];
  const candidates = defs.filter((d) => d.enabled && longKinds.includes(d.kind) && inWindow(d, now) && levelOk(d, level));
  const views = await Promise.all(candidates.map((d) => viewOf(userId, d)));
  const achievements = views
    .filter((v) => !v.claimed)
    .sort((a, b) => {
      /* Claimable first, then closest to done. */
      if (a.completed !== b.completed) return a.completed ? -1 : 1;
      return (b.progress / b.target) - (a.progress / a.target);
    })
    .slice(0, 40);

  /* Chains advance one step at a time. */
  let chain: { chainId: string; step: MissionView | null; total: number; done: number } | null = null;
  const chainDefs = defs.filter((d) => d.kind === 'chain' && d.enabled && d.chainId).sort((a, b) => a.chainStep - b.chainStep);
  if (chainDefs.length) {
    const chainId = chainDefs[0]!.chainId;
    const steps = chainDefs.filter((d) => d.chainId === chainId);
    const stepViews = await Promise.all(steps.map((d) => viewOf(userId, d)));
    const done = stepViews.filter((v) => v.claimed).length;
    chain = { chainId, step: stepViews.find((v) => !v.claimed) ?? null, total: steps.length, done };
  }

  /* The daily set only turns over once it is finished, so «تا فردا» is the
   * truth for a player who has done them and a lie for one who has not — the
   * screen is given the real next-reset for THIS player. */
  const box = await boxFor(userId);
  const nextMidnight = Date.parse(dayKey(now + 86_400_000) + 'T00:00:00Z') - TEHRAN_OFFSET_MS;
  const nextWeek = Date.parse(weekKey(now + 7 * 86_400_000).slice(1) + 'T00:00:00Z') - TEHRAN_OFFSET_MS;
  return { daily, weekly, achievements, chain, box,
           dailyRotates: box.total > 0 && box.done >= box.total,
           nextSetAt: await nextDailySetAt(userId, now),
           resetsAt: { daily: nextMidnight, weekly: nextWeek } };
}

// ----------------------------------------------------------------- claim ----

async function grantReward(userId: string, r: MissionReward, idem: string): Promise<void> {
  const amount = Math.max(0, Math.floor(r.amount || 0));
  if (!amount) return;
  if (r.type === 'cash') {
    await postEntry({ userId, entryType: 'bonus', kind: 'credit', amount,
      idempotencyKey: idem, description: r.label || 'جایزهٔ مأموریت' }).catch(() => undefined);
  } else if (r.type === 'ticket') {
    await grantTickets(userId, r.target || 'green', amount).catch(() => undefined);
  } else if (r.type === 'lifeline') {
    await grantLifeline(userId, r.target || 'p5050', amount).catch(() => undefined);
  } else if (r.type === 'heart') {
    await addHearts(userId, amount).catch(() => undefined);
  } else if (r.type === 'character') {
    /* A character as a mission prize — `target` is its id. Same grant the shop
     * and the wheel use, tagged as a mission so the statistics say where the
     * roster's characters actually came from. */
    if (r.target) await grantCharacter(userId, r.target, 'mission').catch(() => false);
  } else if (r.type === 'cup') {
    /* The cup is the weekly board's currency and it resets with the week, so it
     * goes through the SAME atomic award a finished match uses — writing
     * weekly_score by hand here would miss the week rollover and hand a player
     * last week's total back. */
    await awardScoring(userId, 0, amount).catch(() => undefined);
  } else if (r.type === 'coins' || r.type === 'xp') {
    const u = await repositories.users.findById(userId);
    if (u) {
      if (r.type === 'coins') u.coins = (Number(u.coins) || 0) + amount;
      else u.xp = (Number(u.xp) || 0) + amount;
      await repositories.users.save(u);
    }
  }
  /* 'spin' and 'cosmetic' have no balance to move yet; the claim is the record. */
}

export async function claim(userId: string, missionId: string): Promise<{ missionId: string; rewards: MissionReward[] }> {
  const def = (await listDefs()).find((d) => d.id === missionId);
  if (!def) throw new MissionError('MISSION_NOT_FOUND', 'این مأموریت وجود ندارد.');
  const period = await periodForUser(userId, def.kind);
  const cur = await readProgress(userId, missionId, period);
  if (!cur.completedAt) throw new MissionError('NOT_COMPLETED', 'این مأموریت هنوز کامل نشده.');
  if (cur.claimedAt) throw new MissionError('ALREADY_CLAIMED', 'جایزهٔ این مأموریت را گرفته‌ای.');

  /* Marked claimed BEFORE paying: if a grant throws, the reward is not handed
   * out twice by a retry. */
  await writeProgress(userId, missionId, period, { ...cur, claimedAt: Date.now() });
  for (let i = 0; i < def.rewards.length; i++) {
    await grantReward(userId, def.rewards[i]!, `mission:${userId}:${missionId}:${period}:${i}`);
  }
  logger.info('mission_claimed', { userId, missionId, kind: def.kind });
  return { missionId, rewards: def.rewards };
}

// ------------------------------------------------------------- the box ----

/* WHAT FINISHING ALL THREE IS WORTH.
 *
 * «اگه هر سه این ماموریت‌ها انجام شد یه جعبه جایزه می‌گیره و جوایزی که در پنل
 * تعیین شده به کاربر برسه. کاربر باید روی جعبه ضربه بزنه تا باز بشه.»
 *
 * So the box is a real object with two states — earned, and opened — rather
 * than a payment that happens invisibly the moment the third mission ticks
 * over. The contents come from the panel; they are copied into the row when it
 * is opened so that a later panel edit cannot rewrite a prize already given.
 */
export interface BoxConfig { enabled: boolean; title: string; rewards: MissionReward[] }
export const BOX_DEFAULT: BoxConfig = {
  enabled: true,
  title: 'جعبهٔ جایزهٔ روزانه',
  rewards: [
    { type: 'coins', amount: 300 },
    { type: 'xp', amount: 200 },
    { type: 'cup', amount: 15 }
  ]
};
const BOX_CFG_KEY = 'mission_daily_box';
let _memBoxCfg: BoxConfig | null = null;
const _memBoxes = new Map<string, { openedAt: number | null; rewards: MissionReward[] }>();

function cleanReward(r: any): MissionReward | null {
  const type = String(r?.type || '') as RewardType;
  const amount = Math.max(0, Math.floor(Number(r?.amount) || 0));
  if (!amount) return null;
  if (!['coins', 'xp', 'cup', 'heart', 'ticket', 'cash', 'lifeline', 'character', 'spin', 'cosmetic'].includes(type)) return null;
  const out: MissionReward = { type, amount };
  if (r.target) out.target = String(r.target).slice(0, 40);
  if (r.label) out.label = String(r.label).slice(0, 60);
  return out;
}

export async function getBoxConfig(): Promise<BoxConfig> {
  let raw: Partial<BoxConfig> | null = _memBoxCfg;
  const pool = pg();
  if (pool) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS app_config (key VARCHAR(64) PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMP NOT NULL DEFAULT now(), updated_by VARCHAR(64))`);
      const { rows } = await pool.query(`SELECT value FROM app_config WHERE key=$1`, [BOX_CFG_KEY]);
      if (rows[0]?.value) raw = rows[0].value as Partial<BoxConfig>;
    } catch (e) { logger.warn('mission_box_config_read_failed', { message: (e as Error).message }); }
  }
  if (!raw) return { ...BOX_DEFAULT, rewards: BOX_DEFAULT.rewards.map((r) => ({ ...r })) };
  const rewards = (Array.isArray(raw.rewards) ? raw.rewards : BOX_DEFAULT.rewards)
    .map(cleanReward).filter((r): r is MissionReward => !!r);
  return {
    enabled: raw.enabled !== false,
    title: String(raw.title || BOX_DEFAULT.title).slice(0, 60),
    rewards: rewards.length ? rewards : BOX_DEFAULT.rewards.map((r) => ({ ...r }))
  };
}

export async function setBoxConfig(patch: Partial<BoxConfig>): Promise<BoxConfig> {
  const cur = await getBoxConfig();
  const next: BoxConfig = {
    enabled: patch.enabled === undefined ? cur.enabled : !!patch.enabled,
    title: String(patch.title ?? cur.title).slice(0, 60) || BOX_DEFAULT.title,
    rewards: (Array.isArray(patch.rewards) ? patch.rewards : cur.rewards)
      .map(cleanReward).filter((r): r is MissionReward => !!r)
  };
  if (!next.rewards.length) next.rewards = BOX_DEFAULT.rewards.map((r) => ({ ...r }));
  _memBoxCfg = next;
  const pool = pg();
  if (pool) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS app_config (key VARCHAR(64) PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMP NOT NULL DEFAULT now(), updated_by VARCHAR(64))`);
      await pool.query(`INSERT INTO app_config(key,value,updated_at) VALUES($1,$2,now())
                        ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`, [BOX_CFG_KEY, JSON.stringify(next)]);
    } catch (e) { logger.warn('mission_box_config_write_failed', { message: (e as Error).message }); }
  }
  return next;
}

async function readBox(userId: string, period: string): Promise<{ openedAt: number | null; rewards: MissionReward[] } | null> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT opened_at, rewards FROM mission_boxes WHERE user_id=$1 AND period=$2`, [userId, period]);
    if (!rows[0]) return null;
    return { openedAt: rows[0].opened_at ? new Date(rows[0].opened_at).getTime() : null,
             rewards: Array.isArray(rows[0].rewards) ? rows[0].rewards : [] };
  }
  return _memBoxes.get(pkey(userId, 'box', period)) ?? null;
}

async function writeBox(userId: string, period: string, v: { openedAt: number | null; rewards: MissionReward[] }): Promise<void> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO mission_boxes(user_id,period,opened_at,rewards) VALUES($1,$2,$3,$4)
       ON CONFLICT (user_id,period) DO UPDATE SET opened_at=$3, rewards=$4`,
      [userId, period, v.openedAt ? new Date(v.openedAt) : null, JSON.stringify(v.rewards)]);
  } else _memBoxes.set(pkey(userId, 'box', period), { openedAt: v.openedAt, rewards: v.rewards.map((r) => ({ ...r })) });
}

export interface BoxView {
  /** The set this box belongs to — the day it was dealt. */
  period: string;
  /** How many of the three are done, and how many there are. */
  done: number;
  total: number;
  /** Earned but not yet opened: the one state the screen animates. */
  ready: boolean;
  opened: boolean;
  title: string;
  /** What is inside. Before opening this is the panel's list; after, what was
   *  actually given. */
  rewards: MissionReward[];
}

export async function boxFor(userId: string): Promise<BoxView> {
  const cfg = await getBoxConfig();
  const period = await activeDailyPeriod(userId);
  const ids = await assignmentFor(userId, 'daily', ASSIGN_DEFAULT.daily);
  let done = 0;
  for (const mid of ids) if ((await readProgress(userId, mid, period)).completedAt) done++;
  const row = await readBox(userId, period);
  const all = ids.length > 0 && done >= ids.length;
  return {
    period, done, total: ids.length,
    ready: cfg.enabled && all && !row?.openedAt,
    opened: !!row?.openedAt,
    title: cfg.title,
    rewards: row?.openedAt ? row.rewards : cfg.rewards
  };
}

export async function openBox(userId: string): Promise<{ period: string; rewards: MissionReward[] }> {
  const cfg = await getBoxConfig();
  if (!cfg.enabled) throw new MissionError('BOX_OFF', 'جعبهٔ جایزه فعلاً غیرفعال است.');
  const period = await activeDailyPeriod(userId);
  const ids = await assignmentFor(userId, 'daily', ASSIGN_DEFAULT.daily);
  if (!ids.length || !(await setComplete(userId, ids, period))) {
    throw new MissionError('BOX_NOT_READY', 'هنوز هر سه مأموریت امروز را کامل نکرده‌ای.');
  }
  const existing = await readBox(userId, period);
  if (existing?.openedAt) throw new MissionError('BOX_ALREADY_OPEN', 'جعبهٔ امروز را باز کرده‌ای.');

  /* Written as opened BEFORE anything is paid, exactly as a mission claim is:
   * a grant that throws must not leave a box a retry can open again. */
  const rewards = cfg.rewards.map((r) => ({ ...r }));
  await writeBox(userId, period, { openedAt: Date.now(), rewards });
  for (let i = 0; i < rewards.length; i++) {
    await grantReward(userId, rewards[i]!, `missionbox:${userId}:${period}:${i}`);
  }
  logger.info('mission_box_opened', { userId, period, rewards: rewards.length });
  return { period, rewards };
}

/** Test seam. */
export function _resetMissionMemory(): void {
  _memDefs = null; _memProgress.clear(); _memAssign.clear(); _memCounters.clear(); _seeded = false;
  _memBoxes.clear(); _memBoxCfg = null;
}

export { buildSeed as _buildSeed };
