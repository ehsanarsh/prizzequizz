/* SHOP CATALOG — admin-managed, server-driven.
 * The in-game shop reads its items from here, so an admin can add items, set
 * prices, toggle availability and reorder — no client redeploy. Postgres-backed
 * with a memory fallback, and seeded once from the classic built-in catalog so
 * the shop is never empty on a fresh install. */
import { getPgPool } from '../database/postgres.js';
import { id } from '../utils/id.js';

export type ShopCurrency = 'coins' | 'cash';

/* One thing a purchase hands over. A plain item has a single reward; a bundle
 * has several — «۳ بلیط + ۴۰۰ سکه + ۲ کمک» is three rows, not three items.
 * The keys are the same ones effectKey has always used, so nothing new had to
 * be taught to the granting code. */
export interface ShopReward { key: string; value: number }

export interface ShopItem {
  id: string;
  category: string;          // tickets | coins | util | cosmetic | gift | (custom)
  icon: string;
  name: string;
  description: string;
  price: number;
  currency: ShopCurrency;
  effectKey: string;         // p5050 | psecond | pstats | heart | xp | skin-* | gift | ticket-green/blue/red | coins
  effectValue: number;       // how much the effect grants (e.g. +1 lifeline, +100 coins)
  /* A bundle's contents. When present it REPLACES effectKey/effectValue at
   * grant time; those two are kept in step with the first row so every older
   * reader (and the mission counters) still sees something sensible. */
  rewards?: ShopReward[];
  /** Artwork, as a data: URI. Falls back to `icon` when empty. */
  image?: string;
  badge?: string;            // e.g. «محبوب», «جدید», «٪۲۰ تخفیف»
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/* What a reward is called, for «۲ عدد بلیط آبی خریداری شد». Kept beside the
 * keys rather than in the client, so the panel, the receipt and the game can
 * never disagree about what an item actually gives. */
const REWARD_LABELS: Record<string, string> = {
  coins: 'سکه', heart: 'قلب', xp: 'XP',
  'ticket-green': 'بلیط سبز', 'ticket-blue': 'بلیط آبی', 'ticket-red': 'بلیط قرمز',
  'ticket-bronze': 'بلیط برنز', 'ticket-silver': 'بلیط نقره‌ای', 'ticket-gold': 'بلیط طلایی',
  p5050: 'کمک حذف دو گزینه', psecond: 'کمک انتخاب دوم', pstats: 'کمک درصد پاسخ', ptime: 'کمک وقت اضافه',
  gift: 'هدیه'
};
export function rewardLabel(key: string): string { return REWARD_LABELS[key] || key; }

/** The rows a purchase should hand over, whether the item is a bundle or not. */
export function rewardsOf(item: ShopItem): ShopReward[] {
  const rows = Array.isArray(item.rewards) ? item.rewards.filter((r) => r && r.key && Number(r.value) > 0) : [];
  if (rows.length) return rows.map((r) => ({ key: String(r.key), value: Math.max(0, Math.floor(Number(r.value) || 0)) }));
  if (!item.effectKey) return [];
  return [{ key: item.effectKey, value: Math.max(0, Math.floor(Number(item.effectValue) || 0)) || 1 }];
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS shop_items (
    id TEXT PRIMARY KEY,
    category VARCHAR(32) NOT NULL DEFAULT 'util',
    icon VARCHAR(16) NOT NULL DEFAULT '🛍️',
    name VARCHAR(120) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price BIGINT NOT NULL DEFAULT 0,
    currency VARCHAR(8) NOT NULL DEFAULT 'coins',
    effect_key VARCHAR(32) NOT NULL DEFAULT 'gift',
    effect_value INT NOT NULL DEFAULT 1,
    badge VARCHAR(40),
    enabled BOOLEAN NOT NULL DEFAULT true,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_shop_items_cat ON shop_items(category, sort_order)`);
  /* CREATE TABLE IF NOT EXISTS never adds a column to a table that already
     exists, so a server created before bundles needs these explicitly. */
  await pool.query(`ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS rewards JSONB`);
  await pool.query(`ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS image TEXT`);
  _schemaReady = true;
}

const mem: ShopItem[] = [];

function parseRewards(v: any): ShopReward[] | undefined {
  let raw = v;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return undefined; } }
  if (!Array.isArray(raw)) return undefined;
  const rows = raw
    .map((r: any) => ({ key: String(r?.key ?? '').slice(0, 32), value: Math.max(0, Math.floor(Number(r?.value) || 0)) }))
    .filter((r) => r.key && r.value > 0)
    .slice(0, 8);                                  // a bundle, not a shopping list
  return rows.length ? rows : undefined;
}

function rowToItem(r: any): ShopItem {
  return {
    id: r.id, category: r.category, icon: r.icon, name: r.name, description: r.description ?? '',
    price: Number(r.price ?? 0), currency: r.currency === 'cash' ? 'cash' : 'coins',
    effectKey: r.effect_key, effectValue: Number(r.effect_value ?? 1), badge: r.badge ?? undefined,
    rewards: parseRewards(r.rewards), image: r.image || undefined,
    enabled: r.enabled !== false, sortOrder: Number(r.sort_order ?? 0),
    createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    updatedAt: r.updated_at?.toISOString?.() ?? String(r.updated_at)
  };
}

// Classic built-in catalog — seeded once so the shop is populated on day one.
const SEED: Array<Omit<ShopItem, 'id' | 'createdAt' | 'updatedAt'>> = [
  { category: 'util', icon: '✂️', name: 'حذف دو گزینه', description: 'یک استفاده به کمک‌هایت اضافه می‌شود', price: 20000, currency: 'cash', effectKey: 'p5050', effectValue: 1, enabled: true, sortOrder: 1, badge: 'محبوب' },
  { category: 'util', icon: '🔁', name: 'حق دو انتخاب', description: 'اگر جواب اول غلط بود، یک انتخاب دیگر', price: 30000, currency: 'cash', effectKey: 'psecond', effectValue: 1, enabled: true, sortOrder: 2 },
  { category: 'util', icon: '📊', name: 'درصد پاسخ دیگران', description: 'درصد پاسخ بقیه روی گزینه‌ها', price: 25000, currency: 'cash', effectKey: 'pstats', effectValue: 1, enabled: true, sortOrder: 3 },
  { category: 'util', icon: '❤️', name: 'یک قلب', description: 'یک قلب به موجودی‌ات اضافه می‌شود', price: 20000, currency: 'cash', effectKey: 'heart', effectValue: 1, enabled: true, sortOrder: 4 },
  { category: 'util', icon: '💖', name: 'بستهٔ ۵ قلبی', description: 'پنج قلب یک‌جا — ارزان‌تر از تکی', price: 80000, currency: 'cash', effectKey: 'heart', effectValue: 5, enabled: true, sortOrder: 5, badge: 'به‌صرفه' },
  { category: 'util', icon: '💗', name: 'بستهٔ ۱۵ قلبی', description: 'برای وقتی که می‌خواهی رکورد بزنی', price: 200000, currency: 'cash', effectKey: 'heart', effectValue: 15, enabled: true, sortOrder: 6 },
  /* Tickets are ordinary catalogue items now, so they can be priced, bundled
     and given artwork from the panel like everything else. Prices match the
     three tiers the game has always charged. */
  { category: 'tickets', icon: '🎫', name: 'بلیط سبز', description: 'ورودی یک مسابقه', price: 12500, currency: 'cash', effectKey: 'ticket-green', effectValue: 1, enabled: true, sortOrder: 1 },
  { category: 'tickets', icon: '🎟️', name: 'بلیط آبی', description: 'ورودی یک مسابقه — سهم بیشتر و یک سپر', price: 25000, currency: 'cash', effectKey: 'ticket-blue', effectValue: 1, enabled: true, sortOrder: 2 },
  { category: 'tickets', icon: '🎫', name: 'بلیط قرمز', description: 'ورودی یک مسابقه — بیشترین سهم و دو سپر', price: 50000, currency: 'cash', effectKey: 'ticket-red', effectValue: 1, enabled: true, sortOrder: 3, badge: 'محبوب' },
  { category: 'tickets', icon: '🎁', name: 'بستهٔ شروع', description: '۳ بلیط سبز + ۴۰۰ سکه + ۲ کمک', price: 40000, currency: 'cash', effectKey: 'ticket-green', effectValue: 3, enabled: true, sortOrder: 4, badge: 'به‌صرفه',
    rewards: [{ key: 'ticket-green', value: 3 }, { key: 'coins', value: 400 }, { key: 'p5050', value: 2 }] },
  { category: 'coins', icon: '🪙', name: '۵۰۰ سکه', description: 'سکه برای بازی‌های دوستانه', price: 15000, currency: 'cash', effectKey: 'coins', effectValue: 500, enabled: true, sortOrder: 1 },
  { category: 'coins', icon: '🪙', name: '۲٬۰۰۰ سکه', description: 'چهار برابر، کمی ارزان‌تر', price: 50000, currency: 'cash', effectKey: 'coins', effectValue: 2000, enabled: true, sortOrder: 2, badge: 'محبوب' },
  { category: 'coins', icon: '💰', name: '۱۰٬۰۰۰ سکه', description: 'بستهٔ بزرگ', price: 200000, currency: 'cash', effectKey: 'coins', effectValue: 10000, enabled: true, sortOrder: 3 },
  { category: 'util', icon: '⚡', name: 'شتاب‌دهنده XP', description: 'دو برابر امتیاز برای ۱ ساعت', price: 40000, currency: 'cash', effectKey: 'xp', effectValue: 1, enabled: true, sortOrder: 5 },
  { category: 'cosmetic', icon: '👑', name: 'اسکین طلایی', description: 'هیولای شاهانه با درخشش طلا', price: 120000, currency: 'cash', effectKey: 'skin-gold', effectValue: 1, enabled: true, sortOrder: 1 },
  { category: 'cosmetic', icon: '🕶️', name: 'اسکین نئون', description: 'ظاهر خفن شب‌تاب', price: 60000, currency: 'cash', effectKey: 'skin-neon', effectValue: 1, enabled: true, sortOrder: 2 },
  { category: 'cosmetic', icon: '🌈', name: 'اسکین رنگین‌کمان', description: 'رنگ‌های چرخان دور کاراکتر', price: 100000, currency: 'cash', effectKey: 'skin-rainbow', effectValue: 1, enabled: true, sortOrder: 3 },
  { category: 'gift', icon: '🎟️', name: 'ژتون بازی برای دوست', description: 'یک بازی رایگان هدیه بده', price: 30000, currency: 'cash', effectKey: 'gift', effectValue: 1, enabled: true, sortOrder: 1 },
  { category: 'gift', icon: '💝', name: 'بستهٔ کمک‌ها', description: '۳ کمک برای دوستت', price: 60000, currency: 'cash', effectKey: 'gift', effectValue: 3, enabled: true, sortOrder: 2 },
  { category: 'gift', icon: '🎁', name: 'جعبهٔ سورپرایز', description: 'هدیهٔ شانسی', price: 80000, currency: 'cash', effectKey: 'gift', effectValue: 1, enabled: true, sortOrder: 3 }
];

/* Add any built-in item the catalogue is missing, and report what was added.
 *
 * seedIfEmpty only fills a table that is COMPLETELY empty, which is right for a
 * fresh install and useless for an existing one: a server seeded before the
 * coin packs existed will never get them, and the shop's coins tab stays empty
 * forever with no way to explain why.
 *
 * This is deliberately NOT automatic. Running it on every boot would resurrect
 * anything an operator had chosen to delete; it is a button in the panel, so
 * adding the missing items is a decision rather than a surprise.
 *
 * Identity is (category, effectKey, effectValue) — the triple that says what an
 * item DOES. Editing a seeded item's name or price therefore does not make a
 * duplicate appear. */
export async function seedMissing(): Promise<{ added: ShopItem[]; skipped: number }> {
  const existing = await listAllRaw();
  const key = (x: { category: string; effectKey: string; effectValue: number }) =>
    x.category + '|' + x.effectKey + '|' + (Number(x.effectValue) || 1);
  const have = new Set(existing.map((x) => key(x)));
  const added: ShopItem[] = [];
  for (const s of SEED) {
    if (have.has(key(s))) continue;
    added.push(await saveItem({ ...s }));
  }
  return { added, skipped: SEED.length - added.length };
}

let _seeded = false;
async function seedIfEmpty(): Promise<void> {
  if (_seeded) return;
  const existing = await listAllRaw();
  if (existing.length === 0) {
    for (const s of SEED) await saveItem({ ...s });
  }
  _seeded = true;
}

async function listAllRaw(): Promise<ShopItem[]> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT * FROM shop_items ORDER BY category, sort_order, created_at`);
    return rows.map(rowToItem);
  }
  return mem.slice().sort((a, b) => a.category === b.category ? a.sortOrder - b.sortOrder : a.category < b.category ? -1 : 1);
}

export async function listItems(opts: { category?: string; enabledOnly?: boolean } = {}): Promise<ShopItem[]> {
  await seedIfEmpty();
  let items = await listAllRaw();
  if (opts.category) items = items.filter((i) => i.category === opts.category);
  if (opts.enabledOnly) items = items.filter((i) => i.enabled);
  return items;
}

export async function getItem(itemId: string): Promise<ShopItem | null> {
  return (await listAllRaw()).find((i) => i.id === itemId) ?? null;
}

export async function saveItem(input: Partial<ShopItem> & { name: string; category: string }): Promise<ShopItem> {
  const now = new Date().toISOString();
  const existing = input.id ? await getItem(input.id) : null;
  const item: ShopItem = {
    id: input.id || id(),
    category: String(input.category || 'util').trim() || 'util',
    icon: (input.icon || existing?.icon || '🛍️').slice(0, 16),
    name: String(input.name).slice(0, 120),
    description: String(input.description ?? existing?.description ?? '').slice(0, 400),
    price: Math.max(0, Math.round(Number(input.price ?? existing?.price ?? 0))),
    currency: (input.currency ?? existing?.currency) === 'cash' ? 'cash' : 'coins',
    effectKey: String(input.effectKey ?? existing?.effectKey ?? 'gift').slice(0, 32),
    effectValue: Math.max(0, Math.round(Number(input.effectValue ?? existing?.effectValue ?? 1))),
    rewards: input.rewards !== undefined ? parseRewards(input.rewards) : existing?.rewards,
    image: (input.image !== undefined ? String(input.image || '') : (existing?.image || '')) || undefined,
    badge: (input.badge ?? existing?.badge) || undefined,
    enabled: input.enabled != null ? !!input.enabled : (existing?.enabled ?? true),
    sortOrder: Number(input.sortOrder ?? existing?.sortOrder ?? 0),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  if (!item.name) throw new Error('NAME_REQUIRED');
  /* Keep the single-effect pair pointing at the first row of a bundle. Older
     readers — and the mission counters — still look at effectKey/effectValue,
     and a bundle whose pair said «gift ×1» would quietly miscount. */
  const first = item.rewards?.[0];
  if (first) { item.effectKey = first.key; item.effectValue = first.value; }
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO shop_items(id,category,icon,name,description,price,currency,effect_key,effect_value,badge,enabled,sort_order,created_at,updated_at,rewards,image)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (id) DO UPDATE SET category=$2,icon=$3,name=$4,description=$5,price=$6,currency=$7,effect_key=$8,effect_value=$9,badge=$10,enabled=$11,sort_order=$12,updated_at=$14,rewards=$15,image=$16`,
      [item.id, item.category, item.icon, item.name, item.description, item.price, item.currency, item.effectKey, item.effectValue, item.badge ?? null, item.enabled, item.sortOrder, item.createdAt, item.updatedAt,
       item.rewards ? JSON.stringify(item.rewards) : null, item.image ?? null]);
  } else {
    const i = mem.findIndex((x) => x.id === item.id);
    if (i >= 0) mem[i] = item; else mem.push(item);
  }
  return item;
}

export async function removeItem(itemId: string): Promise<boolean> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rowCount } = await pool.query(`DELETE FROM shop_items WHERE id=$1`, [itemId]);
    return (rowCount ?? 0) > 0;
  }
  const i = mem.findIndex((x) => x.id === itemId);
  if (i < 0) return false;
  mem.splice(i, 1);
  return true;
}
