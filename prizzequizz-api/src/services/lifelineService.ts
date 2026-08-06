/* LIFELINES — an inventory the player owns, exactly like tickets.
 *
 * Two rules that were tangled together before:
 *   1. You own a stock of each help. Buy ten 50:50s and the button says ten.
 *   2. In any one match you may use each help ONCE, however many you own.
 *
 * The old client did both in the browser: it decided availability from a
 * localStorage number and wrote the new total back with a PATCH the server
 * accepted as given. That makes buying meaningless — anything the client can
 * spend, the client can also mint. Both the stock and the once-per-match rule
 * now live here, and the client only asks.
 *
 * The catalogue is data, not code: keys, labels, prices, starting grants and the
 * seconds a time-extension adds are all admin-editable, and adding a help is a
 * row rather than a deploy.
 */
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';
import { logger } from './logger.js';
import { postEntry } from './walletLedgerService.js';

export interface LifelineDef {
  key: string;
  label: string;
  icon: string;
  description: string;
  enabled: boolean;
  /** What a brand-new player starts with. */
  startingGrant: number;
  /** Shop price in toman. 0 means it is not for sale. */
  price: number;
  sellable: boolean;
  /** Can be handed out as a prize (wheel, boxes, admin grants). */
  awardable: boolean;
  /** Only meaningful for the time-extension help: how many seconds it adds. */
  seconds: number;
  sortOrder: number;
}

export const LIFELINE_DEFAULTS: LifelineDef[] = [
  { key: 'p5050',   icon: '✂️', label: '۵۰:۵۰',        description: 'دو گزینهٔ غلط حذف می‌شود',            enabled: true, startingGrant: 2, price: 20000, sellable: true, awardable: true, seconds: 0, sortOrder: 1 },
  { key: 'psecond', icon: '🔁', label: 'انتخاب دوم',   description: 'اگر جواب اول غلط بود، یک انتخاب دیگر', enabled: true, startingGrant: 1, price: 30000, sellable: true, awardable: true, seconds: 0, sortOrder: 2 },
  { key: 'pstats',  icon: '📊', label: 'درصد بقیه',    description: 'درصد پاسخ بقیه روی گزینه‌ها',          enabled: true, startingGrant: 5, price: 25000, sellable: true, awardable: true, seconds: 0, sortOrder: 3 },
  { key: 'ptime',   icon: '⏱️', label: 'وقت اضافه',    description: 'به زمان این سؤال اضافه می‌کند',        enabled: true, startingGrant: 2, price: 15000, sellable: true, awardable: true, seconds: 8, sortOrder: 4 }
];

export class LifelineError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS lifeline_config (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  /* One row per (scope, player, help). The primary key IS the once-per-match
   * rule — a second attempt collides instead of being decided by a read. */
  await pool.query(`CREATE TABLE IF NOT EXISTS lifeline_uses (
    scope_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    key      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scope_id, user_id, key)
  )`);
  _schemaReady = true;
}

// ---- catalogue ----
let _memCatalog: LifelineDef[] | null = null;

function withDefaults(rows: any): LifelineDef[] {
  const list = Array.isArray(rows) ? rows : [];
  const byKey = new Map<string, any>(list.map((r: any) => [String(r.key), r]));
  /* Defaults are merged in rather than replaced, so a help added in a later
   * version appears for sites that already have a saved catalogue. */
  const out: LifelineDef[] = [];
  for (const d of LIFELINE_DEFAULTS) {
    const saved = byKey.get(d.key);
    byKey.delete(d.key);
    out.push(saved ? normalise({ ...d, ...saved }) : { ...d });
  }
  for (const extra of byKey.values()) out.push(normalise(extra));
  return out.sort((a, b) => a.sortOrder - b.sortOrder);
}
function normalise(r: any): LifelineDef {
  return {
    key: String(r.key || '').trim(),
    label: String(r.label ?? r.key ?? ''),
    icon: String(r.icon ?? '✨'),
    description: String(r.description ?? ''),
    enabled: r.enabled !== false,
    startingGrant: Math.max(0, Math.round(Number(r.startingGrant) || 0)),
    price: Math.max(0, Math.round(Number(r.price) || 0)),
    sellable: r.sellable !== false,
    awardable: r.awardable !== false,
    seconds: Math.max(0, Math.round(Number(r.seconds) || 0)),
    sortOrder: Number(r.sortOrder) || 0
  };
}

export async function getCatalog(): Promise<LifelineDef[]> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT data FROM lifeline_config WHERE id='default'`);
    if (!rows[0]) {
      await pool.query(`INSERT INTO lifeline_config(id,data) VALUES('default',$1) ON CONFLICT DO NOTHING`, [JSON.stringify(LIFELINE_DEFAULTS)]);
      return LIFELINE_DEFAULTS.map((d) => ({ ...d }));
    }
    return withDefaults(rows[0].data);
  }
  if (!_memCatalog) _memCatalog = LIFELINE_DEFAULTS.map((d) => ({ ...d }));
  return withDefaults(_memCatalog);
}

export async function saveCatalog(defs: any[]): Promise<LifelineDef[]> {
  const next = withDefaults(defs).filter((d) => d.key);
  if (!next.length) throw new LifelineError('CATALOG_EMPTY', 'حداقل یک کمک لازم است.');
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(`INSERT INTO lifeline_config(id,data,updated_at) VALUES('default',$1,now())
                      ON CONFLICT (id) DO UPDATE SET data=$1, updated_at=now()`, [JSON.stringify(next)]);
  } else _memCatalog = next;
  return next;
}

/** Enabled helps only — what a player is actually offered. */
export async function activeCatalog(): Promise<LifelineDef[]> {
  return (await getCatalog()).filter((d) => d.enabled);
}

// ---- inventory ----
/** A player's counts, with the starting grant filled in for keys they have
 *  never held — including a help added after they signed up. */
export async function inventoryFor(userId: string): Promise<Record<string, number>> {
  const [user, catalog] = await Promise.all([repositories.users.findById(userId), getCatalog()]);
  const held: Record<string, any> = (user?.lifelines as any) ?? {};
  const out: Record<string, number> = {};
  for (const d of catalog) {
    const v = held[d.key];
    out[d.key] = v == null ? d.startingGrant : Math.max(0, Math.round(Number(v) || 0));
  }
  return out;
}

async function writeInventory(userId: string, inv: Record<string, number>): Promise<void> {
  await repositories.users.updateLifelines(userId, inv);
}

/** Add (or take away, with a negative amount) — the one door for shop
 *  purchases, wheel prizes, boxes and admin grants. */
export async function grantLifeline(userId: string, key: string, amount: number): Promise<Record<string, number>> {
  const catalog = await getCatalog();
  if (!catalog.some((d) => d.key === key)) throw new LifelineError('LIFELINE_UNKNOWN', 'این کمک وجود ندارد.');
  const inv = await inventoryFor(userId);
  inv[key] = Math.max(0, (inv[key] ?? 0) + Math.round(Number(amount) || 0));
  await writeInventory(userId, inv);
  logger.info('lifeline_granted', { userId, key, amount, total: inv[key] });
  return inv;
}

// ---- usage ----
async function alreadyUsed(scopeId: string, userId: string, key: string): Promise<boolean> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT 1 FROM lifeline_uses WHERE scope_id=$1 AND user_id=$2 AND key=$3`, [scopeId, userId, key]);
    return !!rows[0];
  }
  return _memUses.has(`${scopeId}|${userId}|${key}`);
}
const _memUses = new Set<string>();

/** Which helps this player has already spent in this match. */
export async function usedIn(scopeId: string, userId: string): Promise<string[]> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT key FROM lifeline_uses WHERE scope_id=$1 AND user_id=$2`, [scopeId, userId]);
    return rows.map((r: any) => String(r.key));
  }
  const out: string[] = [];
  for (const k of _memUses) { const [s, u, key] = k.split('|'); if (s === scopeId && u === userId) out.push(key!); }
  return out;
}

export interface UseResult { key: string; remaining: number; seconds: number; def: LifelineDef }

/** Spend one, for this match. Refuses when the player owns none, when they have
 *  already used this help in this match, or when it has been switched off. */
export async function useLifeline(userId: string, key: string, scopeId: string): Promise<UseResult> {
  const catalog = await getCatalog();
  const def = catalog.find((d) => d.key === key);
  if (!def) throw new LifelineError('LIFELINE_UNKNOWN', 'این کمک وجود ندارد.');
  if (!def.enabled) throw new LifelineError('LIFELINE_DISABLED', 'این کمک فعلاً غیرفعال است.');
  if (!scopeId) throw new LifelineError('SCOPE_REQUIRED', 'شناسهٔ مسابقه لازم است.');

  if (await alreadyUsed(scopeId, userId, key)) {
    throw new LifelineError('LIFELINE_USED_THIS_MATCH', 'این کمک را در همین مسابقه استفاده کرده‌ای.');
  }
  const inv = await inventoryFor(userId);
  if ((inv[key] ?? 0) <= 0) throw new LifelineError('LIFELINE_EMPTY', `${def.label} نداری؛ از فروشگاه تهیه کن.`);

  // Claim the once-per-match slot BEFORE debiting, so two taps that arrive
  // together cannot both get through and take two from the stock.
  const pool = pg();
  if (pool) {
    const res = await pool.query(
      `INSERT INTO lifeline_uses(scope_id,user_id,key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [scopeId, userId, key]);
    if (!res.rowCount) throw new LifelineError('LIFELINE_USED_THIS_MATCH', 'این کمک را در همین مسابقه استفاده کرده‌ای.');
  } else {
    const memKey = `${scopeId}|${userId}|${key}`;
    if (_memUses.has(memKey)) throw new LifelineError('LIFELINE_USED_THIS_MATCH', 'این کمک را در همین مسابقه استفاده کرده‌ای.');
    _memUses.add(memKey);
  }

  inv[key] = Math.max(0, (inv[key] ?? 0) - 1);
  await writeInventory(userId, inv);
  logger.info('lifeline_used', { userId, key, scopeId, remaining: inv[key] });
  return { key, remaining: inv[key]!, seconds: def.seconds, def };
}

/** Buy from the shop. Money leaves the wallet through the same ledger as every
 *  other purchase, and the help is granted only if the debit went through — the
 *  browser neither sets the price nor the resulting count. */
export async function purchaseLifeline(input: { userId: string; key: string; qty?: number; idempotencyKey: string; ip?: string; device?: string; platform?: string }): Promise<{ key: string; qty: number; price: number; inventory: Record<string, number>; balance: number; duplicate: boolean }> {
  const catalog = await getCatalog();
  const def = catalog.find((d) => d.key === input.key);
  if (!def) throw new LifelineError('LIFELINE_UNKNOWN', 'این کمک وجود ندارد.');
  if (!def.enabled || !def.sellable || def.price <= 0) throw new LifelineError('LIFELINE_NOT_FOR_SALE', 'این کمک برای فروش نیست.');
  const qty = Math.max(1, Math.min(99, Math.round(Number(input.qty) || 1)));
  const total = def.price * qty;

  const posted = await postEntry({
    userId: input.userId, entryType: 'lifeline_purchase', kind: 'debit', amount: total,
    idempotencyKey: input.idempotencyKey, refType: 'lifeline', refId: def.key,
    description: `خرید ${def.label}` + (qty > 1 ? ` ×${qty}` : ''),
    ip: input.ip, device: input.device, platform: input.platform
  });
  if (posted.duplicate) {
    return { key: def.key, qty, price: total, inventory: await inventoryFor(input.userId), balance: posted.account.available, duplicate: true };
  }
  const inventory = await grantLifeline(input.userId, def.key, qty);
  return { key: def.key, qty, price: total, inventory, balance: posted.account.available, duplicate: false };
}

/** Test seam. */
export function _resetLifelineMemory(): void { _memUses.clear(); _memCatalog = null; }
