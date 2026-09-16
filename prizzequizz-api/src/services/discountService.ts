/* CODES THAT TAKE MONEY OFF A PRICE.
 *
 * «و کد تخفیف هم باید باشه.»
 *
 * Nothing here is the browser's to decide. The client sends a STRING; what it
 * is worth, whether it is still alive, whether this player has already had it,
 * and what the price becomes are all computed here — a discount arrived at in a
 * browser is a price arrived at by the person paying it.
 *
 * There is already `giftCodeService`, and it is not this. A gift code puts a
 * reward INTO a wallet; a discount code reduces an invoice that has not been
 * paid yet. The two can look alike from the outside and share nothing inside.
 *
 * TWO THINGS ARE LOAD-BEARING.
 *
 * 1. A CODE IS SPENT WHEN THE MONEY MOVES, NOT WHEN IT IS TYPED. Quoting is
 *    free and repeatable; `redeem` is what consumes a use, and it is the insert
 *    that decides — a UNIQUE on the order reference means one order can never
 *    consume two uses, and the conditional UPDATE means two players racing for
 *    the last use of a code produce exactly one winner.
 *
 * 2. A GATEWAY PAYMENT IS NOT PAID YET. The intent is opened now and settles
 *    minutes later, so a code attached to an intent must NOT be spent at that
 *    moment — otherwise opening ten invoices would burn ten uses of a
 *    single-use code without a rial being transferred. It is re-checked and
 *    spent where the goods are handed over.
 */
import { getPgPool } from '../database/postgres.js';
import { logger } from './logger.js';

function pg() { try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; } }

export type DiscountKind = 'percent' | 'amount';

export interface DiscountCode {
  id: string;
  /** As the operator typed it — what is shown back to the player. */
  code: string;
  kind: DiscountKind;
  /** Percent (1-100) or toman off, depending on `kind`. */
  value: number;
  /** The order has to be at least this much before the code applies. */
  minAmount: number;
  /** Ceiling on a percentage discount. 0 means no ceiling. */
  maxDiscount: number;
  /** Epoch ms. 0 means «already started» / «never expires». */
  startsAt: number;
  expiresAt: number;
  /** 0 means unlimited. */
  usageLimit: number;
  perUserLimit: number;
  usedCount: number;
  enabled: boolean;
  note: string;
  createdAt: number;
}

/* WHAT COUNTS AS THE SAME CODE.
 *
 * A code is read off a banner, a story, a friend's message — and typed by hand,
 * in a language whose keyboard produces its own digits. «Eid1404», «EID ۱۴۰۴»
 * and «eid-1404» are one code to everybody except a byte comparison, and a
 * player who typed the right code and was told it is invalid does not try a
 * fourth spelling; they decide the code was a lie. */
export function foldCode(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[​-‏‪-‮﻿‌]/g, '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[\s\-_.]+/g, '')
    .toUpperCase()
    .slice(0, 48);
}

export class DiscountError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'DiscountError'; }
}

let _ready = false;
async function ensureSchema(pool: NonNullable<ReturnType<typeof pg>>): Promise<void> {
  if (_ready) return;
  /* Created at runtime, not by a migration: the server is deployed as a built
     `dist/` and migrations do not travel with it. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discount_codes (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      folded TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'percent',
      value BIGINT NOT NULL DEFAULT 0,
      min_amount BIGINT NOT NULL DEFAULT 0,
      max_discount BIGINT NOT NULL DEFAULT 0,
      starts_at BIGINT NOT NULL DEFAULT 0,
      expires_at BIGINT NOT NULL DEFAULT 0,
      usage_limit INT NOT NULL DEFAULT 0,
      per_user_limit INT NOT NULL DEFAULT 1,
      used_count INT NOT NULL DEFAULT 0,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      note TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL DEFAULT 0
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discount_redemptions (
      id TEXT PRIMARY KEY,
      code_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      /* One order, one redemption — this UNIQUE is what makes a replayed
         settlement idempotent instead of doubly discounted. */
      ref TEXT NOT NULL UNIQUE,
      amount_off BIGINT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL DEFAULT 0
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_discount_redeem_user ON discount_redemptions(code_id, user_id)`);
  _ready = true;
}

function rowToCode(r: any): DiscountCode {
  return {
    id: String(r.id), code: String(r.code ?? ''),
    kind: (String(r.kind) === 'amount' ? 'amount' : 'percent'),
    value: Number(r.value ?? 0), minAmount: Number(r.min_amount ?? 0), maxDiscount: Number(r.max_discount ?? 0),
    startsAt: Number(r.starts_at ?? 0), expiresAt: Number(r.expires_at ?? 0),
    usageLimit: Number(r.usage_limit ?? 0), perUserLimit: Number(r.per_user_limit ?? 0),
    usedCount: Number(r.used_count ?? 0), enabled: r.enabled !== false,
    note: String(r.note ?? ''), createdAt: Number(r.created_at ?? 0)
  };
}

/* WHAT A CODE TAKES OFF A PRICE — the arithmetic on its own, so it can be read
 * and checked without a database in the room.
 *
 * Never more than the price: a code worth more than the basket makes the order
 * free, not a refund. And a percentage is floored, so the discount can never be
 * rounded up into money the shop did not agree to give away. */
export function discountFor(c: Pick<DiscountCode, 'kind' | 'value' | 'maxDiscount'>, amount: number): number {
  const price = Math.max(0, Math.floor(Number(amount) || 0));
  const v = Math.max(0, Math.floor(Number(c.value) || 0));
  if (!price || !v) return 0;
  let off = c.kind === 'amount' ? v : Math.floor((price * Math.min(100, v)) / 100);
  const cap = Math.max(0, Math.floor(Number(c.maxDiscount) || 0));
  if (c.kind === 'percent' && cap > 0) off = Math.min(off, cap);
  return Math.max(0, Math.min(off, price));
}

export interface DiscountQuote {
  ok: boolean;
  /** Present only when ok. */
  codeId?: string;
  code?: string;
  amountOff: number;
  finalAmount: number;
  reason?: string;
  message?: string;
}

/** Look a code up without spending it. Safe to call on every keystroke. */
export async function quoteDiscount(input: { code: string; userId: string; amount: number }): Promise<DiscountQuote> {
  const amount = Math.max(0, Math.floor(Number(input.amount) || 0));
  const no = (reason: string, message: string): DiscountQuote => ({ ok: false, amountOff: 0, finalAmount: amount, reason, message });
  const folded = foldCode(input.code);
  if (!folded) return no('EMPTY', 'کد تخفیف را وارد کن.');

  const pool = pg();
  if (!pool) return no('NOT_FOUND', 'این کد معتبر نیست.');
  await ensureSchema(pool);

  const { rows } = await pool.query(`SELECT * FROM discount_codes WHERE folded=$1`, [folded]);
  if (!rows[0]) return no('NOT_FOUND', 'این کد معتبر نیست.');
  const c = rowToCode(rows[0]);

  if (!c.enabled) return no('DISABLED', 'این کد دیگر فعال نیست.');
  const now = Date.now();
  if (c.startsAt > 0 && now < c.startsAt) return no('NOT_STARTED', 'این کد هنوز شروع نشده است.');
  if (c.expiresAt > 0 && now > c.expiresAt) return no('EXPIRED', 'مهلت این کد تمام شده است.');
  if (c.usageLimit > 0 && c.usedCount >= c.usageLimit) return no('EXHAUSTED', 'ظرفیت این کد تکمیل شده است.');
  if (c.minAmount > 0 && amount < c.minAmount) {
    return no('BELOW_MIN', 'این کد برای خریدهای بالای ' + c.minAmount.toLocaleString('fa-IR') + ' تومان است.');
  }
  if (c.perUserLimit > 0) {
    const { rows: mine } = await pool.query(
      `SELECT count(*)::int n FROM discount_redemptions WHERE code_id=$1 AND user_id=$2`, [c.id, input.userId]);
    if (Number(mine[0]?.n ?? 0) >= c.perUserLimit) return no('ALREADY_USED', 'از این کد قبلاً استفاده کرده‌ای.');
  }

  const amountOff = discountFor(c, amount);
  /* A code that applies but takes nothing off is not a working code — telling
     the player it was accepted and then charging the full price is the worst of
     both answers. */
  if (amountOff <= 0) return no('NO_EFFECT', 'این کد روی این خرید تخفیفی ندارد.');

  return { ok: true, codeId: c.id, code: c.code, amountOff, finalAmount: Math.max(0, amount - amountOff) };
}

/* SPENDING IT — the only place a use is consumed.
 *
 * Every limit is re-checked HERE against the row as it stands, because the
 * quote the player was shown may be minutes old and the last use may have gone
 * to somebody else in between. The conditional UPDATE is the race: two settles
 * arriving together both run it, and the `used_count < usage_limit` in the
 * WHERE means exactly one of them changes a row.
 *
 * Returns the amount actually taken off, or 0 when the code could not be spent
 * — the caller then charges the full price rather than handing over goods at a
 * discount nobody recorded. */
export async function redeemDiscount(input: { code: string; userId: string; amount: number; ref: string }): Promise<{ amountOff: number; codeId: string | null; duplicate: boolean }> {
  const pool = pg();
  if (!pool) return { amountOff: 0, codeId: null, duplicate: false };
  await ensureSchema(pool);
  const folded = foldCode(input.code);
  if (!folded || !input.ref) return { amountOff: 0, codeId: null, duplicate: false };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    /* Already redeemed for this exact order: a replayed settlement must return
       what the first one did, not discount the price a second time. */
    const { rows: seen } = await client.query(
      `SELECT code_id, amount_off FROM discount_redemptions WHERE ref=$1`, [input.ref]);
    if (seen[0]) {
      await client.query('COMMIT');
      return { amountOff: Number(seen[0].amount_off ?? 0), codeId: String(seen[0].code_id), duplicate: true };
    }

    const { rows } = await client.query(`SELECT * FROM discount_codes WHERE folded=$1 FOR UPDATE`, [folded]);
    if (!rows[0]) { await client.query('ROLLBACK'); return { amountOff: 0, codeId: null, duplicate: false }; }
    const c = rowToCode(rows[0]);
    const now = Date.now();
    const amount = Math.max(0, Math.floor(Number(input.amount) || 0));
    const dead = !c.enabled
      || (c.startsAt > 0 && now < c.startsAt)
      || (c.expiresAt > 0 && now > c.expiresAt)
      || (c.usageLimit > 0 && c.usedCount >= c.usageLimit)
      || (c.minAmount > 0 && amount < c.minAmount);
    if (dead) { await client.query('ROLLBACK'); return { amountOff: 0, codeId: null, duplicate: false }; }

    if (c.perUserLimit > 0) {
      const { rows: mine } = await client.query(
        `SELECT count(*)::int n FROM discount_redemptions WHERE code_id=$1 AND user_id=$2`, [c.id, input.userId]);
      if (Number(mine[0]?.n ?? 0) >= c.perUserLimit) { await client.query('ROLLBACK'); return { amountOff: 0, codeId: null, duplicate: false }; }
    }

    const amountOff = discountFor(c, amount);
    if (amountOff <= 0) { await client.query('ROLLBACK'); return { amountOff: 0, codeId: null, duplicate: false }; }

    /* The count and the limit are compared inside the statement, so the last
       use cannot be handed to two people at once. */
    const upd = await client.query(
      `UPDATE discount_codes SET used_count = used_count + 1
        WHERE id=$1 AND ($2 = 0 OR used_count < $2)`, [c.id, c.usageLimit]);
    if ((upd.rowCount ?? 0) === 0) { await client.query('ROLLBACK'); return { amountOff: 0, codeId: null, duplicate: false }; }

    await client.query(
      `INSERT INTO discount_redemptions(id, code_id, user_id, ref, amount_off, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      ['dr_' + Math.random().toString(36).slice(2) + Date.now().toString(36), c.id, input.userId, input.ref, amountOff, now]);
    await client.query('COMMIT');
    return { amountOff, codeId: c.id, duplicate: false };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('discount_redeem_failed', { ref: input.ref, error: e instanceof Error ? e.message : 'unknown' });
    return { amountOff: 0, codeId: null, duplicate: false };
  } finally { client.release(); }
}

/* GIVING IT BACK. A gateway invoice that expired, or an order that failed after
 * the code was spent, must not leave the player having burned a single-use code
 * on nothing. */
export async function releaseDiscount(ref: string): Promise<boolean> {
  const pool = pg();
  if (!pool || !ref) return false;
  await ensureSchema(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`DELETE FROM discount_redemptions WHERE ref=$1 RETURNING code_id`, [ref]);
    if (!rows[0]) { await client.query('ROLLBACK'); return false; }
    await client.query(`UPDATE discount_codes SET used_count = GREATEST(used_count - 1, 0) WHERE id=$1`, [rows[0].code_id]);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return false;
  } finally { client.release(); }
}

/* ---- the operator's side ------------------------------------------------ */

export async function listDiscountCodes(): Promise<DiscountCode[]> {
  const pool = pg(); if (!pool) return [];
  await ensureSchema(pool);
  const { rows } = await pool.query(`SELECT * FROM discount_codes ORDER BY created_at DESC LIMIT 500`);
  return rows.map(rowToCode);
}

export async function saveDiscountCode(input: Partial<DiscountCode> & { code: string }): Promise<DiscountCode> {
  const pool = pg();
  if (!pool) throw new DiscountError('NO_DB', 'پایگاه داده در دسترس نیست.');
  await ensureSchema(pool);
  const code = String(input.code ?? '').trim();
  const folded = foldCode(code);
  if (!folded) throw new DiscountError('CODE_EMPTY', 'کد را بنویس.');
  const kind: DiscountKind = input.kind === 'amount' ? 'amount' : 'percent';
  const value = Math.max(0, Math.floor(Number(input.value) || 0));
  if (!value) throw new DiscountError('VALUE_EMPTY', 'مقدار تخفیف را بنویس.');
  if (kind === 'percent' && value > 100) throw new DiscountError('PERCENT_TOO_BIG', 'درصد تخفیف نمی‌تواند بیشتر از ۱۰۰ باشد.');
  const id = String(input.id ?? ('dc_' + Math.random().toString(36).slice(2) + Date.now().toString(36)));
  const now = Date.now();
  const row = {
    id, code, folded, kind, value,
    min_amount: Math.max(0, Math.floor(Number(input.minAmount) || 0)),
    max_discount: Math.max(0, Math.floor(Number(input.maxDiscount) || 0)),
    starts_at: Math.max(0, Math.floor(Number(input.startsAt) || 0)),
    expires_at: Math.max(0, Math.floor(Number(input.expiresAt) || 0)),
    usage_limit: Math.max(0, Math.floor(Number(input.usageLimit) || 0)),
    per_user_limit: Math.max(0, Math.floor(Number(input.perUserLimit ?? 1) || 0)),
    enabled: input.enabled !== false,
    note: String(input.note ?? '').slice(0, 300),
    created_at: Math.max(0, Math.floor(Number(input.createdAt) || 0)) || now
  };
  /* The folded form is unique, so «EID1404» cannot be created twice under two
     spellings and then behave like two different codes. */
  await pool.query(
    `INSERT INTO discount_codes(id,code,folded,kind,value,min_amount,max_discount,starts_at,expires_at,usage_limit,per_user_limit,enabled,note,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (folded) DO UPDATE SET
       code=$2, kind=$4, value=$5, min_amount=$6, max_discount=$7, starts_at=$8, expires_at=$9,
       usage_limit=$10, per_user_limit=$11, enabled=$12, note=$13`,
    [row.id, row.code, row.folded, row.kind, row.value, row.min_amount, row.max_discount, row.starts_at,
     row.expires_at, row.usage_limit, row.per_user_limit, row.enabled, row.note, row.created_at]);
  const { rows } = await pool.query(`SELECT * FROM discount_codes WHERE folded=$1`, [folded]);
  return rowToCode(rows[0]);
}

export async function deleteDiscountCode(id: string): Promise<boolean> {
  const pool = pg(); if (!pool) return false;
  await ensureSchema(pool);
  const { rowCount } = await pool.query(`DELETE FROM discount_codes WHERE id=$1`, [id]);
  return (rowCount ?? 0) > 0;
}

/** Test seam. */
export function _resetDiscountSchema(): void { _ready = false; }
