/* DAILY REWARD + PRIZE WHEEL — configured in the panel, decided on the server.
 *
 * Both used to live entirely in the client: a hardcoded fifteen-entry array for
 * the daily calendar and a wheel that picked its own prize and then told the
 * server what it had won. That makes "configurable from the panel" meaningless
 * — nothing the panel changed could bind a client that decides for itself, and
 * anyone could claim the top segment on every spin.
 *
 * Now the panel owns the prize table (how many segments, what each one gives,
 * how likely it is, how many days the streak runs) and the server owns the
 * outcome. The client is told which index to land on so the animation matches,
 * but the prize is already granted by then.
 */
import { randomInt } from 'node:crypto';
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';
import { postEntry } from './walletLedgerService.js';
import { grantTickets } from './ticketService.js';
import { grantLifeline } from './lifelineService.js';
import { id } from '../utils/id.js';
import { logger } from './logger.js';

/** Everything a prize can be. Kept small on purpose: each one has to be
 *  grantable for real, and a type nothing can pay out is worse than no type. */
export type RewardType = 'coins' | 'xp' | 'ticket' | 'heart' | 'cash' | 'lifeline' | 'nothing';

export interface WheelSegment {
  id: string;
  label: string;
  icon: string;
  /** Segment fill on the wheel face. */
  color: string;
  type: RewardType;
  amount: number;
  /** For type 'ticket' the tier, for 'lifeline' the lifeline key. */
  target: string;
  /** Relative chance. A segment with weight 0 is on the wheel but never wins. */
  weight: number;
  enabled: boolean;
}

export interface DailyDay {
  day: number;
  label: string;
  icon: string;
  type: RewardType;
  amount: number;
  target: string;
}

export interface RewardsConfig {
  wheel: {
    enabled: boolean;
    /** Hours between free spins. */
    cooldownHours: number;
    title: string;
    segments: WheelSegment[];
  };
  daily: {
    enabled: boolean;
    /** How many days the calendar runs before it loops. */
    streakDays: number;
    /** Miss a day and the streak restarts at 1 rather than carrying on. */
    resetOnMiss: boolean;
    days: DailyDay[];
  };
}

export class RewardsError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const seg = (id: string, icon: string, label: string, color: string, type: RewardType, amount: number, weight: number, target = ''): WheelSegment =>
  ({ id, icon, label, color, type, amount, target, weight, enabled: true });

/* Ten segments, matching the wheel face the client draws. Weights are
 * deliberately lopsided: the small coin prizes carry most of the probability
 * and the headline prizes are rare, which is what makes spinning feel like
 * something. All of it is editable in the panel. */
export const REWARDS_DEFAULTS: RewardsConfig = {
  wheel: {
    enabled: true, cooldownHours: 24, title: 'چرخونهٔ شانس هیولاها',
    segments: [
      seg('crown',   '👑', 'تاج پادشاهی',   '#E8A33D', 'ticket',  1,   4,  'green'),
      seg('star',    '⭐', 'ستارهٔ قدرت',    '#4FA9DE', 'xp',      150, 16),
      seg('shield',  '🛡️', 'سپر محافظ',     '#57B26A', 'heart',   1,   12),
      seg('pot',     '🍯', 'دیگ طلا',       '#D9A02B', 'coins',   250, 18),
      seg('potion',  '🧪', 'اکسیر هیولا',   '#9B5DE5', 'lifeline',1,   8,  'p5050'),
      seg('diamond', '💎', 'گنجینهٔ الماس',  '#5DB7EC', 'coins',   700, 5),
      seg('horns',   '🦴', 'شاخ قدرت',      '#C96F4A', 'lifeline',1,   8,  'ptime'),
      seg('slime',   '🟣', 'همراه لزج',     '#D6539E', 'coins',   100, 20),
      seg('gear',    '🌀', 'تجهیزات غواصی', '#3C8FA8', 'xp',      300, 6),
      seg('map',     '🗺️', 'نقشهٔ گنج',     '#C9B27A', 'cash',    5000,3)
    ]
  },
  daily: {
    enabled: true, streakDays: 7, resetOnMiss: true,
    days: [
      { day: 1, icon: '🪙', label: '۱۰۰ سکه',   type: 'coins',  amount: 100, target: '' },
      { day: 2, icon: '⚡', label: '۱۵۰ XP',    type: 'xp',     amount: 150, target: '' },
      { day: 3, icon: '❤️', label: '۱ قلب',     type: 'heart',  amount: 1,   target: '' },
      { day: 4, icon: '🎫', label: '۱ بلیت',    type: 'ticket', amount: 1,   target: 'green' },
      { day: 5, icon: '🪙', label: '۲۵۰ سکه',   type: 'coins',  amount: 250, target: '' },
      { day: 6, icon: '🧩', label: 'کمکِ رایگان', type: 'lifeline', amount: 1, target: 'p5050' },
      { day: 7, icon: '💰', label: '۱۰٬۰۰۰ تومان', type: 'cash', amount: 10000, target: '' }
    ]
  }
};

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS rewards_config (
    id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_rewards (
    user_id TEXT PRIMARY KEY,
    last_spin_at TIMESTAMPTZ,
    last_claim_at TIMESTAMPTZ,
    streak_day INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  _schemaReady = true;
}

let _memConfig: RewardsConfig | null = null;
interface UserRewardState { lastSpinAt: number | null; lastClaimAt: number | null; streakDay: number }
const _memState = new Map<string, UserRewardState>();

// ---------------------------------------------------------------- config ----

function normaliseConfig(raw: any): RewardsConfig {
  const d = REWARDS_DEFAULTS;
  const r = raw && typeof raw === 'object' ? raw : {};
  const w = r.wheel && typeof r.wheel === 'object' ? r.wheel : {};
  const dy = r.daily && typeof r.daily === 'object' ? r.daily : {};
  /* A MISSING segments key means "not configured yet" and falls back to the
     defaults. A key that is present but empty is the operator deleting every
     segment, and must reach validation rather than be quietly refilled. */
  const segments: WheelSegment[] = Array.isArray(w.segments)
    ? w.segments.map((s: any, i: number) => ({
        id: String(s?.id || 'seg' + (i + 1)),
        label: String(s?.label ?? ''),
        icon: String(s?.icon ?? '🎁'),
        color: String(s?.color ?? '#D9A02B'),
        type: (['coins','xp','ticket','heart','cash','lifeline','nothing'] as RewardType[]).includes(s?.type) ? s.type : 'nothing',
        amount: Math.max(0, Math.floor(Number(s?.amount) || 0)),
        target: String(s?.target ?? ''),
        weight: Math.max(0, Number(s?.weight) || 0),
        enabled: s?.enabled !== false
      }))
    : d.wheel.segments.map((s) => ({ ...s }));
  const days: DailyDay[] = Array.isArray(dy.days)
    ? dy.days.map((x: any, i: number) => ({
        day: Math.max(1, Math.floor(Number(x?.day) || i + 1)),
        label: String(x?.label ?? ''),
        icon: String(x?.icon ?? '🎁'),
        type: (['coins','xp','ticket','heart','cash','lifeline','nothing'] as RewardType[]).includes(x?.type) ? x.type : 'coins',
        amount: Math.max(0, Math.floor(Number(x?.amount) || 0)),
        target: String(x?.target ?? '')
      })).sort((a: DailyDay, b: DailyDay) => a.day - b.day)
    : d.daily.days.map((x) => ({ ...x }));

  return {
    wheel: {
      enabled: w.enabled !== false,
      cooldownHours: Math.max(0, Number(w.cooldownHours ?? d.wheel.cooldownHours) || 0),
      title: String(w.title ?? d.wheel.title),
      segments
    },
    daily: {
      enabled: dy.enabled !== false,
      /* The calendar cannot be longer than the days actually defined, or a
       * player reaches a day with no prize behind it. */
      streakDays: Math.max(1, Math.min(days.length || 1, Math.floor(Number(dy.streakDays ?? d.daily.streakDays) || days.length || 1))),
      resetOnMiss: dy.resetOnMiss !== false,
      days
    }
  };
}

export async function getConfig(): Promise<RewardsConfig> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT data FROM rewards_config WHERE id='default'`);
    return normaliseConfig(rows[0]?.data);
  }
  return normaliseConfig(_memConfig);
}

export async function saveConfig(patch: any): Promise<RewardsConfig> {
  const current = await getConfig();
  const next = normaliseConfig({
    wheel: { ...current.wheel, ...(patch?.wheel ?? {}) },
    daily: { ...current.daily, ...(patch?.daily ?? {}) }
  });
  if (!next.wheel.segments.length) throw new RewardsError('NO_SEGMENTS', 'چرخونه باید حداقل یک بخش داشته باشد.');
  if (next.wheel.segments.length > 24) throw new RewardsError('TOO_MANY_SEGMENTS', 'حداکثر ۲۴ بخش برای چرخونه.');
  /* A wheel where every segment has weight zero can never land anywhere; that
   * would surface as a spin that silently does nothing. */
  if (next.wheel.enabled && !next.wheel.segments.some((s) => s.enabled && s.weight > 0)) {
    throw new RewardsError('NO_WEIGHT', 'حداقل یک بخشِ فعال باید شانس بزرگ‌تر از صفر داشته باشد.');
  }
  if (!next.daily.days.length) throw new RewardsError('NO_DAYS', 'تقویم روزانه باید حداقل یک روز داشته باشد.');

  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO rewards_config(id,data,updated_at) VALUES('default',$1,now())
       ON CONFLICT (id) DO UPDATE SET data=$1, updated_at=now()`, [JSON.stringify(next)]);
  } else _memConfig = next;
  logger.info('rewards_config_saved', { segments: next.wheel.segments.length, days: next.daily.days.length });
  return next;
}

// ----------------------------------------------------------------- state ----

async function loadState(userId: string): Promise<UserRewardState> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT last_spin_at,last_claim_at,streak_day FROM user_rewards WHERE user_id=$1`, [userId]);
    const r = rows[0];
    return {
      lastSpinAt: r?.last_spin_at ? new Date(r.last_spin_at).getTime() : null,
      lastClaimAt: r?.last_claim_at ? new Date(r.last_claim_at).getTime() : null,
      streakDay: Number(r?.streak_day ?? 0)
    };
  }
  return _memState.get(userId) ?? { lastSpinAt: null, lastClaimAt: null, streakDay: 0 };
}

async function saveState(userId: string, s: UserRewardState): Promise<void> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO user_rewards(user_id,last_spin_at,last_claim_at,streak_day,updated_at)
       VALUES($1,$2,$3,$4,now())
       ON CONFLICT (user_id) DO UPDATE SET last_spin_at=$2,last_claim_at=$3,streak_day=$4,updated_at=now()`,
      [userId, s.lastSpinAt ? new Date(s.lastSpinAt) : null, s.lastClaimAt ? new Date(s.lastClaimAt) : null, s.streakDay]);
  } else _memState.set(userId, { ...s });
}

/* Calendar days in Tehran, not UTC. The server runs on UTC, and Iran is
 * +03:30, so a plain date comparison would roll the daily reward over at
 * 03:30 in the morning local time — a player claiming at 01:00 would be told
 * to come back tomorrow, and one claiming at 04:00 could claim twice. */
const TEHRAN_OFFSET_MS = 3.5 * 3600_000;
export function dayNumber(ts: number): number {
  return Math.floor((ts + TEHRAN_OFFSET_MS) / 86_400_000);
}

// ---------------------------------------------------------------- payout ----

export interface Granted { type: RewardType; amount: number; target: string; label: string; icon: string }

/** Pay a prize out for real. Idempotency key makes a retried claim safe.
 *  Exported because the wheel is no longer the only thing that pays a prize —
 *  an approved player-written question does too, and paying it any other way
 *  would be a second, divergent copy of this. */
export async function grantReward(userId: string, p: { type: RewardType; amount: number; target: string; label: string; icon: string }, idemKey: string): Promise<Granted> {
  const amount = Math.max(0, Math.floor(p.amount || 0));
  if (p.type !== 'nothing' && amount > 0) {
    if (p.type === 'cash') {
      await postEntry({ userId, entryType: 'bonus', kind: 'credit', amount,
        idempotencyKey: idemKey, description: p.label || 'جایزه' });
    } else if (p.type === 'ticket') {
      await grantTickets(userId, p.target || 'green', amount);
    } else if (p.type === 'lifeline') {
      await grantLifeline(userId, p.target || 'p5050', amount);
    } else {
      const u = await repositories.users.findById(userId);
      if (u) {
        if (p.type === 'coins') u.coins = (Number(u.coins) || 0) + amount;
        if (p.type === 'xp') u.xp = (Number(u.xp) || 0) + amount;
        if (p.type === 'heart') u.hearts = (Number(u.hearts) || 0) + amount;
        await repositories.users.save(u);
      }
    }
  }
  return { type: p.type, amount, target: p.target, label: p.label, icon: p.icon };
}

// ------------------------------------------------------------------ wheel ----

/** Weighted pick over the enabled segments. Uses crypto rather than
 *  Math.random: this decides real money. */
export function pickSegment(segments: WheelSegment[]): number {
  const live = segments.map((s, i) => ({ s, i })).filter((x) => x.s.enabled && x.s.weight > 0);
  if (!live.length) return -1;
  const total = live.reduce((n, x) => n + x.s.weight, 0);
  /* Integer arithmetic so fractional weights cannot drift the distribution. */
  const scale = 1_000_000;
  let roll = randomInt(0, Math.max(1, Math.round(total * scale)));
  for (const x of live) {
    roll -= Math.round(x.s.weight * scale);
    if (roll < 0) return x.i;
  }
  return live[live.length - 1]!.i;
}

export interface SpinResult {
  index: number;
  segment: WheelSegment;
  granted: Granted;
  nextSpinAt: number | null;
}

export async function spin(userId: string): Promise<SpinResult> {
  const cfg = await getConfig();
  if (!cfg.wheel.enabled) throw new RewardsError('WHEEL_OFF', 'چرخونه فعلاً غیرفعال است.');
  const st = await loadState(userId);
  const now = Date.now();
  const cooldownMs = cfg.wheel.cooldownHours * 3600_000;
  if (st.lastSpinAt && cooldownMs > 0 && now - st.lastSpinAt < cooldownMs) {
    throw new RewardsError('WHEEL_COOLDOWN', 'هنوز نوبت چرخش بعدی نرسیده.');
  }
  const index = pickSegment(cfg.wheel.segments);
  if (index < 0) throw new RewardsError('NO_WEIGHT', 'هیچ جایزه‌ای برای چرخونه تنظیم نشده.');
  const segment = cfg.wheel.segments[index]!;

  /* State is written BEFORE the payout: if granting throws, the spin is still
   * consumed. The alternative — pay first, record after — turns any failure
   * into an unlimited spin loop. */
  st.lastSpinAt = now;
  await saveState(userId, st);

  const granted = await grantReward(userId, segment, `wheel:${userId}:${now}`);
  logger.info('wheel_spun', { userId, segment: segment.id, type: segment.type, amount: granted.amount });
  return { index, segment, granted, nextSpinAt: cooldownMs > 0 ? now + cooldownMs : null };
}

// ------------------------------------------------------------------ daily ----

/** Which day of the calendar this player is on right now (1-based). */
function nextStreakDay(st: UserRewardState, cfg: RewardsConfig, now: number): number {
  const today = dayNumber(now);
  const last = st.lastClaimAt == null ? null : dayNumber(st.lastClaimAt);
  if (last === null) return 1;
  if (last === today - 1) {
    /* Consecutive day: advance, wrapping back to 1 once the calendar ends so a
     * long-running player keeps getting something. */
    return (st.streakDay % cfg.daily.streakDays) + 1;
  }
  if (last < today - 1) return cfg.daily.resetOnMiss ? 1 : (st.streakDay % cfg.daily.streakDays) + 1;
  return st.streakDay || 1;  // already claimed today
}

export interface DailyStatus {
  enabled: boolean;
  claimedToday: boolean;
  day: number;
  streakDays: number;
  days: DailyDay[];
}

export interface WheelStatus {
  enabled: boolean;
  ready: boolean;
  nextSpinAt: number | null;
  title: string;
  /** The face only — weights never leave the server. */
  segments: { id: string; label: string; icon: string; color: string }[];
}

export async function status(userId: string): Promise<{ wheel: WheelStatus; daily: DailyStatus }> {
  const cfg = await getConfig();
  const st = await loadState(userId);
  const now = Date.now();
  const cooldownMs = cfg.wheel.cooldownHours * 3600_000;
  const nextSpinAt = st.lastSpinAt && cooldownMs > 0 ? st.lastSpinAt + cooldownMs : null;
  const claimedToday = st.lastClaimAt != null && dayNumber(st.lastClaimAt) === dayNumber(now);
  return {
    wheel: {
      enabled: cfg.wheel.enabled,
      ready: cfg.wheel.enabled && (!nextSpinAt || now >= nextSpinAt),
      nextSpinAt, title: cfg.wheel.title,
      segments: cfg.wheel.segments.map((s) => ({ id: s.id, label: s.label, icon: s.icon, color: s.color }))
    },
    daily: {
      enabled: cfg.daily.enabled,
      claimedToday,
      day: nextStreakDay(st, cfg, now),
      streakDays: cfg.daily.streakDays,
      days: cfg.daily.days.slice(0, cfg.daily.streakDays)
    }
  };
}

export async function claimDaily(userId: string): Promise<{ day: number; granted: Granted; streakDays: number }> {
  const cfg = await getConfig();
  if (!cfg.daily.enabled) throw new RewardsError('DAILY_OFF', 'جایزهٔ روزانه فعلاً غیرفعال است.');
  const st = await loadState(userId);
  const now = Date.now();
  if (st.lastClaimAt != null && dayNumber(st.lastClaimAt) === dayNumber(now)) {
    throw new RewardsError('ALREADY_CLAIMED', 'جایزهٔ امروز را گرفته‌ای — فردا دوباره بیا.');
  }
  const day = nextStreakDay(st, cfg, now);
  const prize = cfg.daily.days.find((d) => d.day === day) ?? cfg.daily.days[0]!;

  st.lastClaimAt = now;
  st.streakDay = day;
  await saveState(userId, st);

  const granted = await grantReward(userId, prize, `daily:${userId}:${dayNumber(now)}`);
  logger.info('daily_claimed', { userId, day, type: prize.type, amount: granted.amount });
  return { day, granted, streakDays: cfg.daily.streakDays };
}

/** Test seam. */
export function _resetRewardsMemory(): void { _memConfig = null; _memState.clear(); }
export function _setState(userId: string, s: Partial<UserRewardState>): void {
  _memState.set(userId, { lastSpinAt: null, lastClaimAt: null, streakDay: 0, ..._memState.get(userId), ...s });
}
