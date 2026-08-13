/* QUICK-CHAT PACKS — what a player is allowed to say mid-match.
 *
 * The duel used to carry eight hard-coded taunts in the client file, which
 * meant the sentences could only ever be changed by shipping a new client and
 * there was nothing to sell. A pack is now a named group of sentences with its
 * own price: one pack is free and always usable, the rest are bought once and
 * owned for good.
 *
 * Everything an operator would want to change lives here — the pack's name, its
 * emoji, its price, whether that price is in coins or in cash, and every
 * sentence in it. Nothing about a pack is written in the client.
 *
 * Postgres-backed with a memory fallback, and the schema applies itself: the
 * deployed dist carries no migrations folder, so a table that only exists in a
 * migration file is a table that never exists in production.
 */
import { getPgPool } from '../database/postgres.js';
import { postEntry, getAccount } from './walletLedgerService.js';
import { repositories } from '../repositories/index.js';
import { logger } from './logger.js';

export type ChatPackCurrency = 'coins' | 'cash';

export interface ChatPack {
  key: string;                 // stable slug — ownership is keyed on it, so it never changes
  name: string;
  emoji: string;
  free: boolean;               // usable by everyone, price ignored
  price: number;
  currency: ChatPackCurrency;
  enabled: boolean;
  sortOrder: number;
  phrases: string[];
}

/** What a player is told about a pack. Sentences are withheld until it is theirs. */
export interface ChatPackView {
  key: string; name: string; emoji: string; free: boolean;
  price: number; currency: ChatPackCurrency;
  owned: boolean; locked: boolean;
  phraseCount: number;
  phrases: string[];           // empty while locked
}

export class ChatPackError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export const CHAT_PACK_MAX_PHRASES = 40;
export const CHAT_PACK_MAX_LEN = 80;

/* The catalogue a fresh install starts with. «دوستانه» is the free one — every
 * player has something to say from the first match, and the paid packs are an
 * addition rather than a toll on being able to speak at all. */
export const CHAT_PACK_DEFAULTS: ChatPack[] = [
  {
    key: 'friendly', name: 'دوستانه', emoji: '🤝', free: true, price: 0, currency: 'coins',
    enabled: true, sortOrder: 1,
    phrases: [
      'سلام! 👋', 'بازی خوبی باشه 🤝', 'موفق باشی!', 'آفرین! 👏', 'عالی بود 🔥',
      'چه جواب قشنگی', 'حقت بود 😄', 'ایول!', 'خوش‌شانس بودی 😅', 'نوبت توئه',
      'عجله نکن', 'من آماده‌ام ⚡', 'بازی قشنگیه', 'دمت گرم 🙏', 'ببخشید دیر شد',
      'اینترنتم قطع شد 📶', 'یه دور دیگه؟ 🔁', 'ممنون از بازی 🙌', 'خداحافظ 👋', 'باز هم بازی کنیم'
    ]
  },
  {
    key: 'fun', name: 'فان', emoji: '😂', free: false, price: 1500, currency: 'coins',
    enabled: true, sortOrder: 2,
    phrases: [
      '😂😂😂', 'چی شد اصلاً؟', 'مغزم سوخت 🤯', 'این سؤال از کجا اومد؟!', 'شانسی زدم 🎲',
      'گوگل کجایی؟ 😅', 'الان جدی بود؟', 'دستم لرزید! 🫠', 'مامانم صدام کرد 🏃', 'یه لحظه، چایی‌ام ریخت ☕',
      'گربه‌م رو کیبورد نشست 🐈', 'من که گفتم بلد نیستم 😭', 'این یکی رو حفظ بودم 😎', 'بریم بعدی، یادم نمیاد', 'خنده‌ام گرفت 😆',
      'ای وای! 🙈', 'جوابش این نبود؟! 😳', 'باشه باشه قبول 😌', 'زدم و رفت 🚀', 'من رو دست کم نگیر 😏'
    ]
  },
  {
    key: 'flirt', name: 'مخ‌زنی', emoji: '😉', free: false, price: 2500, currency: 'coins',
    enabled: true, sortOrder: 3,
    phrases: [
      'چه سلیقه‌ای در انتخاب موضوع ✨', 'باهوشی، معلومه', 'اسمت قشنگه', 'با تو بازی کردن لذت داره', 'حریف خوبی هستی 😊',
      'چه سریع جواب دادی!', 'تحسین‌برانگیز بود 👏', 'رقیب باکلاسی هستی', 'ازت یاد گرفتم', 'دوباره بازی کنیم؟ 😊',
      'خوشحالم که تو حریفم شدی', 'حرفه‌ای می‌زنی', 'آرامشت رو دوست دارم', 'چه اعتمادبه‌نفسی ⚡', 'رقابت باهات جذابه',
      'دست‌مریزاد 🌟', 'تو رو باید جدی گرفت', 'بازیت تمیزه', 'لیاقتش رو داشتی', 'امیدوارم باز ببینمت 🙂'
    ]
  },
  {
    key: 'trash', name: 'کل‌کل', emoji: '😤', free: false, price: 2500, currency: 'coins',
    enabled: true, sortOrder: 4,
    phrases: [
      'همین؟ 😏', 'تازه گرم شدم 🔥', 'جدی گرفتمت، اشتباه کردم 😅', 'آماده باش، دارم میام', 'این دور مال منه',
      'سرعتت کمه ⏱️', 'یه سؤال دیگه تموم می‌شی', 'حواست کجاست؟', 'من هنوز شروع نکردم', 'کاپ رو ببرم دیگه 🏆',
      'بهتر از این بلد نیستی؟', 'فشار رو حس می‌کنی؟ 😎', 'جا نزنی وسط بازی', 'راحت باش، صبر می‌کنم ⏳', 'دو تا جواب دیگه، تمومه',
      'شانس همیشه یار نیست 🎲', 'اینم رفت ✅', 'برگرد اگه تونستی', 'تسلیم شو، راحت‌تری', 'خداحافظ امتیازهات 👋'
    ]
  }
];

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS chat_packs (
    key TEXT PRIMARY KEY,
    name VARCHAR(60) NOT NULL,
    emoji VARCHAR(16) NOT NULL DEFAULT '💬',
    free BOOLEAN NOT NULL DEFAULT false,
    price BIGINT NOT NULL DEFAULT 0,
    currency VARCHAR(8) NOT NULL DEFAULT 'coins',
    enabled BOOLEAN NOT NULL DEFAULT true,
    sort_order INT NOT NULL DEFAULT 0,
    phrases JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS chat_pack_owners (
    user_id TEXT NOT NULL,
    pack_key TEXT NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, pack_key))`);
  _schemaReady = true;
}

/* The memory fallback, and also the cache in front of Postgres. Seeded lazily
 * so a fresh install is never a shop with nothing on the shelf. */
let mem: ChatPack[] | null = null;
const memOwners = new Map<string, Set<string>>();

function clonePack(p: ChatPack): ChatPack { return { ...p, phrases: [...p.phrases] }; }
function seed(): ChatPack[] { return CHAT_PACK_DEFAULTS.map(clonePack); }

function normPhrases(v: unknown): string[] {
  let raw: unknown = v;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = []; } }
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const s of raw) {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, CHAT_PACK_MAX_LEN);
    /* Deduped: a pack with the same sentence twice is a pack with a wasted
       slot, and the player would tap the same bubble expecting two things. */
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= CHAT_PACK_MAX_PHRASES) break;
  }
  return out;
}

/* A key is what ownership is stored against, so it must survive a rename and
 * must never contain anything that changes meaning in a URL. */
function normKey(v: unknown): string {
  return String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
}

function normPack(input: any, fallbackOrder: number): ChatPack | null {
  const key = normKey(input?.key);
  if (!key) return null;
  const free = !!input?.free;
  const currency: ChatPackCurrency = input?.currency === 'cash' ? 'cash' : 'coins';
  return {
    key,
    name: String(input?.name ?? '').trim().slice(0, 60) || key,
    emoji: String(input?.emoji ?? '💬').trim().slice(0, 16) || '💬',
    free,
    /* A free pack's price is not merely ignored at checkout — it is stored as
       zero, so the panel can never show a price beside a pack nobody pays. */
    price: free ? 0 : Math.max(0, Math.floor(Number(input?.price) || 0)),
    currency,
    enabled: input?.enabled !== false,
    sortOrder: Number.isFinite(Number(input?.sortOrder)) ? Math.floor(Number(input.sortOrder)) : fallbackOrder,
    phrases: normPhrases(input?.phrases)
  };
}

function rowToPack(r: any): ChatPack {
  return {
    key: r.key, name: r.name, emoji: r.emoji, free: r.free === true,
    price: Number(r.price ?? 0), currency: r.currency === 'cash' ? 'cash' : 'coins',
    enabled: r.enabled !== false, sortOrder: Number(r.sort_order ?? 0),
    phrases: normPhrases(r.phrases)
  };
}

function sortPacks(list: ChatPack[]): ChatPack[] {
  return [...list].sort((a, b) => (a.sortOrder - b.sortOrder) || a.key.localeCompare(b.key));
}

/** Every pack, enabled or not. Admin view. */
export async function listPacks(): Promise<ChatPack[]> {
  const pool = pg();
  if (!pool) { mem ??= seed(); return sortPacks(mem).map(clonePack); }
  await ensureSchema(pool);
  const { rows } = await pool.query('SELECT * FROM chat_packs');
  if (!rows.length) {
    /* First run on a real database: write the defaults down rather than
       returning them from thin air, so the very first admin edit has something
       to edit and does not silently create a second copy. */
    for (const p of seed()) await upsert(pool, p);
    return sortPacks(seed()).map(clonePack);
  }
  return sortPacks(rows.map(rowToPack));
}

async function upsert(pool: NonNullable<ReturnType<typeof pg>>, p: ChatPack): Promise<void> {
  await pool.query(
    `INSERT INTO chat_packs (key,name,emoji,free,price,currency,enabled,sort_order,phrases,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,now())
     ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name, emoji=EXCLUDED.emoji, free=EXCLUDED.free,
       price=EXCLUDED.price, currency=EXCLUDED.currency, enabled=EXCLUDED.enabled,
       sort_order=EXCLUDED.sort_order, phrases=EXCLUDED.phrases, updated_at=now()`,
    [p.key, p.name, p.emoji, p.free, p.price, p.currency, p.enabled, p.sortOrder, JSON.stringify(p.phrases)]
  );
}

/** Replace the catalogue. Admin action. */
export async function savePacks(input: unknown): Promise<ChatPack[]> {
  const raw = Array.isArray(input) ? input : (input as any)?.packs;
  if (!Array.isArray(raw)) throw new ChatPackError('BAD_INPUT', 'فهرست پک‌ها فرستاده نشده است.');
  if (raw.length > 24) throw new ChatPackError('TOO_MANY', 'حداکثر ۲۴ پک چت.');

  const packs: ChatPack[] = [];
  const seenKeys = new Set<string>();
  raw.forEach((p: any, i: number) => {
    const norm = normPack(p, i + 1);
    if (!norm) throw new ChatPackError('BAD_KEY', 'شناسهٔ پک باید انگلیسی و بدون فاصله باشد.');
    if (seenKeys.has(norm.key)) throw new ChatPackError('DUPLICATE_KEY', 'شناسهٔ «' + norm.key + '» تکراری است.');
    seenKeys.add(norm.key);
    if (!norm.phrases.length) throw new ChatPackError('EMPTY_PACK', 'پک «' + norm.name + '» هیچ جمله‌ای ندارد.');
    packs.push(norm);
  });

  /* A player with no free pack cannot say anything at all, and the چت button
     would open onto an empty sheet. Refuse rather than ship that. */
  if (!packs.some((p) => p.free && p.enabled)) {
    throw new ChatPackError('NO_FREE_PACK', 'حداقل یک پک باید رایگان و فعال باشد.');
  }
  /* A paid pack at zero is free in every way except that the player is never
     told so — the buy button takes nothing and the pack unlocks. Say it. */
  const zero = packs.find((p) => !p.free && p.enabled && p.price <= 0);
  if (zero) throw new ChatPackError('ZERO_PRICE', 'پک «' + zero.name + '» قیمت ندارد؛ یا رایگانش کن یا قیمت بگذار.');

  const keys = packs.map((p) => p.key);
  const pool = pg();
  if (!pool) {
    mem = packs.map(clonePack);
    /* Same rule as the database path below: a removed pack takes its owners
       with it, so a later pack reusing the key is not pre-owned by strangers. */
    for (const [user, owned] of memOwners) {
      for (const k of [...owned]) if (!keys.includes(k)) owned.delete(k);
      if (!owned.size) memOwners.delete(user);
    }
    return sortPacks(mem).map(clonePack);
  }
  await ensureSchema(pool);
  /* Removing a pack must not strand its owners' rows; they go with it, so a
     later pack reusing the key does not arrive pre-owned by strangers. */
  await pool.query('DELETE FROM chat_pack_owners WHERE NOT (pack_key = ANY($1::text[]))', [keys]);
  await pool.query('DELETE FROM chat_packs WHERE NOT (key = ANY($1::text[]))', [keys]);
  for (const p of packs) await upsert(pool, p);
  return sortPacks(packs).map(clonePack);
}

/** The keys this player already owns (does not include the free ones). */
export async function ownedKeys(userId: string): Promise<string[]> {
  const pool = pg();
  if (!pool) return [...(memOwners.get(userId) ?? [])];
  await ensureSchema(pool);
  const { rows } = await pool.query('SELECT pack_key FROM chat_pack_owners WHERE user_id=$1', [userId]);
  return rows.map((r: any) => String(r.pack_key));
}

export async function grantPack(userId: string, key: string): Promise<void> {
  const k = normKey(key);
  if (!k) return;
  const pool = pg();
  if (!pool) {
    const set = memOwners.get(userId) ?? new Set<string>();
    set.add(k); memOwners.set(userId, set);
    return;
  }
  await ensureSchema(pool);
  await pool.query(
    'INSERT INTO chat_pack_owners (user_id, pack_key) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [userId, k]
  );
}

/** What the game shows: every enabled pack, sentences only for the ones in hand. */
export async function packsFor(userId: string): Promise<ChatPackView[]> {
  const [all, owned] = await Promise.all([listPacks(), ownedKeys(userId)]);
  const own = new Set(owned);
  return all.filter((p) => p.enabled).map((p) => {
    const has = p.free || own.has(p.key);
    return {
      key: p.key, name: p.name, emoji: p.emoji, free: p.free,
      price: p.price, currency: p.currency,
      owned: has, locked: !has,
      phraseCount: p.phrases.length,
      /* A locked pack's sentences are not sent. Shipping them with a flag set
         would mean the whole paid catalogue is one devtools tab away. */
      phrases: has ? [...p.phrases] : []
    };
  });
}

/** True only if the player may actually send this sentence. */
export async function canSay(userId: string, key: string, phrase: string): Promise<boolean> {
  const all = await listPacks();
  const p = all.find((x) => x.key === normKey(key));
  if (!p || !p.enabled) return false;
  if (!p.phrases.includes(String(phrase))) return false;
  if (p.free) return true;
  return (await ownedKeys(userId)).includes(p.key);
}

export interface ChatPackPurchase {
  key: string; name: string; price: number; currency: ChatPackCurrency;
  duplicate: boolean;
  balances: { wallet: number; coins: number };
  phrases: string[];
}

/* Settled purchases, so a double tap or a retried request charges once. */
const _seen = new Map<string, ChatPackPurchase>();

async function balancesOf(userId: string): Promise<{ wallet: number; coins: number }> {
  const user = await repositories.users.findById(userId);
  let wallet = Number(user?.wallet ?? 0);
  try { wallet = (await getAccount(userId)).available; } catch { /* ledger optional */ }
  return { wallet, coins: Number(user?.coins ?? 0) };
}

export async function purchasePack(input: { userId: string; key: string; idempotencyKey: string }): Promise<ChatPackPurchase> {
  const userId = input.userId;
  const idem = String(input.idempotencyKey || '').trim();
  if (!idem) throw new ChatPackError('IDEMPOTENCY_REQUIRED', 'کلید یکتا لازم است.');
  const cached = _seen.get(idem);
  if (cached) return { ...cached, duplicate: true };

  const key = normKey(input.key);
  const pack = (await listPacks()).find((p) => p.key === key);
  if (!pack) throw new ChatPackError('PACK_NOT_FOUND', 'این پک وجود ندارد.');
  if (!pack.enabled) throw new ChatPackError('PACK_DISABLED', 'این پک فعلاً موجود نیست.');
  if (pack.free) throw new ChatPackError('PACK_IS_FREE', 'این پک رایگان است و لازم نیست خریده شود.');

  /* Already owned → say so and charge nothing. Without this, buying twice is
     two debits for one thing the player already had. */
  if ((await ownedKeys(userId)).includes(pack.key)) {
    const result: ChatPackPurchase = {
      key: pack.key, name: pack.name, price: 0, currency: pack.currency,
      duplicate: true, balances: await balancesOf(userId), phrases: [...pack.phrases]
    };
    _seen.set(idem, result);
    return result;
  }

  const user = await repositories.users.findById(userId);
  if (!user) throw new ChatPackError('USER_NOT_FOUND', 'کاربر پیدا نشد.');
  const price = Math.max(0, Math.floor(pack.price));

  /* Charge first, grant second. A grant with no charge is money lost with no
     trace; a charge with no grant is a support case with a ledger row. */
  if (price > 0) {
    if (pack.currency === 'cash') {
      const acct = await getAccount(userId).catch(() => ({ available: Number(user.wallet) || 0 } as any));
      if (Number(acct.available) < price) throw new ChatPackError('INSUFFICIENT_FUNDS', 'موجودی کیف پولت کافی نیست.');
      await postEntry({
        userId, entryType: 'shop_purchase', kind: 'debit', amount: price,
        idempotencyKey: 'chatpack:' + idem, description: 'خرید پک چت: ' + pack.name
      });
    } else {
      const have = Number(user.coins) || 0;
      if (have < price) throw new ChatPackError('INSUFFICIENT_COINS', 'سکه‌ات کافی نیست.');
      user.coins = have - price;
      await repositories.users.save(user);
    }
  }

  await grantPack(userId, pack.key);

  const result: ChatPackPurchase = {
    key: pack.key, name: pack.name, price, currency: pack.currency,
    duplicate: false, balances: await balancesOf(userId), phrases: [...pack.phrases]
  };
  _seen.set(idem, result);
  if (_seen.size > 5000) for (const k of [..._seen.keys()].slice(0, 1000)) _seen.delete(k);
  logger.info('chat_pack_purchase', { userId, key: pack.key, price, currency: pack.currency });
  return result;
}

/** Test seam. */
export function _resetChatPacks(): void {
  mem = null; memOwners.clear(); _seen.clear(); _schemaReady = false;
}
