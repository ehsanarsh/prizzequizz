/* Gift / promo codes: an admin mints a code with a reward; a user redeems it
 * once. Redemption is atomic and idempotent per (code,user) — the same user can
 * never redeem twice, and the global max-uses is enforced with a guarded UPDATE.
 * Cash/ticket rewards go through the same authoritative paths as everything else
 * (wallet ledger / ticket service). Falls back to an in-memory store with no DB.
 */
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';
import { postEntry } from './walletLedgerService.js';
import { refundTicket } from './ticketService.js';

export interface GiftCode {
  code: string; rewardType: 'cash' | 'coins' | 'ticket' | 'xp' | 'cup';
  amount: number; tier?: string; maxUses: number; uses: number;
  expiresAt?: string | null; createdAt: string;
}

let _ready = false;
function pg() { try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; } }
async function ensure(pool: ReturnType<typeof getPgPool>) {
  if (_ready) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS gift_codes (
    code VARCHAR(48) PRIMARY KEY, reward_type VARCHAR(16) NOT NULL, amount BIGINT NOT NULL DEFAULT 0,
    tier VARCHAR(16), max_uses INT NOT NULL DEFAULT 1, uses INT NOT NULL DEFAULT 0,
    expires_at TIMESTAMP, created_at TIMESTAMP NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS gift_code_redemptions (
    code VARCHAR(48) NOT NULL, user_id UUID NOT NULL, redeemed_at TIMESTAMP NOT NULL DEFAULT now(),
    PRIMARY KEY (code, user_id))`);
  _ready = true;
}

const memCodes = new Map<string, GiftCode>();
const memRedemptions = new Set<string>();

export class GiftError extends Error { constructor(public code: string, message: string) { super(message); } }

const VALID_TYPES = ['cash', 'coins', 'ticket', 'xp', 'cup'];

export async function createGiftCode(input: { code?: string; rewardType: string; amount: number; tier?: string; maxUses: number; expiresAt?: string | null }): Promise<GiftCode> {
  const code = (input.code || randomCode()).toUpperCase().replace(/\s+/g, '');
  if (!VALID_TYPES.includes(input.rewardType)) throw new GiftError('REWARD_TYPE_INVALID', 'نوع جایزه نامعتبر است.');
  if (input.rewardType === 'ticket' && !input.tier) throw new GiftError('TIER_REQUIRED', 'برای جایزهٔ بلیت، نوع بلیت لازم است.');
  const row: GiftCode = { code, rewardType: input.rewardType as GiftCode['rewardType'], amount: Math.max(0, Math.round(input.amount || 0)), tier: input.tier, maxUses: Math.max(1, Math.round(input.maxUses || 1)), uses: 0, expiresAt: input.expiresAt || null, createdAt: new Date().toISOString() };
  const pool = pg();
  if (pool) {
    await ensure(pool);
    await pool.query(`INSERT INTO gift_codes(code,reward_type,amount,tier,max_uses,expires_at) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (code) DO UPDATE SET reward_type=$2, amount=$3, tier=$4, max_uses=$5, expires_at=$6`,
      [row.code, row.rewardType, row.amount, row.tier ?? null, row.maxUses, row.expiresAt]);
  } else { memCodes.set(code, row); }
  return row;
}

export async function listGiftCodes(): Promise<GiftCode[]> {
  const pool = pg();
  if (!pool) return [...memCodes.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  await ensure(pool);
  const { rows } = await pool.query(`SELECT * FROM gift_codes ORDER BY created_at DESC LIMIT 200`);
  return rows.map(fromRow);
}

export async function redeemGiftCode(userId: string, codeRaw: string): Promise<{ rewardType: string; amount: number; tier?: string }> {
  const code = String(codeRaw || '').toUpperCase().replace(/\s+/g, '');
  if (!code) throw new GiftError('CODE_REQUIRED', 'کد هدیه را وارد کن.');
  const pool = pg();
  let gift: GiftCode;
  if (pool) {
    await ensure(pool);
    const g = await pool.query(`SELECT * FROM gift_codes WHERE code=$1`, [code]);
    if (!g.rows[0]) throw new GiftError('CODE_NOT_FOUND', 'کد هدیه معتبر نیست.');
    gift = fromRow(g.rows[0]);
    if (gift.expiresAt && new Date(gift.expiresAt).getTime() < Date.now()) throw new GiftError('CODE_EXPIRED', 'کد هدیه منقضی شده است.');
    // claim a per-user redemption slot (unique PK → one per user)
    try { await pool.query(`INSERT INTO gift_code_redemptions(code,user_id) VALUES ($1,$2)`, [code, userId]); }
    catch { throw new GiftError('ALREADY_REDEEMED', 'این کد را قبلاً استفاده کرده‌ای.'); }
    // consume a global use with a guard; roll back the redemption if exhausted
    const upd = await pool.query(`UPDATE gift_codes SET uses = uses + 1 WHERE code=$1 AND uses < max_uses RETURNING uses`, [code]);
    if (!upd.rows[0]) { await pool.query(`DELETE FROM gift_code_redemptions WHERE code=$1 AND user_id=$2`, [code, userId]); throw new GiftError('CODE_EXHAUSTED', 'ظرفیت این کد پر شده است.'); }
  } else {
    gift = memCodes.get(code)!;
    if (!gift) throw new GiftError('CODE_NOT_FOUND', 'کد هدیه معتبر نیست.');
    if (gift.expiresAt && new Date(gift.expiresAt).getTime() < Date.now()) throw new GiftError('CODE_EXPIRED', 'کد هدیه منقضی شده است.');
    const key = `${code}:${userId}`;
    if (memRedemptions.has(key)) throw new GiftError('ALREADY_REDEEMED', 'این کد را قبلاً استفاده کرده‌ای.');
    if (gift.uses >= gift.maxUses) throw new GiftError('CODE_EXHAUSTED', 'ظرفیت این کد پر شده است.');
    memRedemptions.add(key); gift.uses += 1;
  }
  await grant(userId, gift, code);
  return { rewardType: gift.rewardType, amount: gift.amount, tier: gift.tier };
}

async function grant(userId: string, gift: GiftCode, code: string): Promise<void> {
  const idem = `gift:${code}:${userId}`;
  if (gift.rewardType === 'cash') {
    await postEntry({ userId, entryType: 'bonus', kind: 'credit', amount: gift.amount, idempotencyKey: idem, refType: 'gift', refId: code, description: `کد هدیه ${code}` });
    return;
  }
  if (gift.rewardType === 'ticket' && gift.tier) { await refundTicket(userId, gift.tier); return; }
  const user = await repositories.users.findById(userId);
  if (!user) return;
  if (gift.rewardType === 'coins') user.coins = Number(user.coins ?? 0) + gift.amount;
  if (gift.rewardType === 'xp') user.xp = Number(user.xp ?? 0) + gift.amount;
  if (gift.rewardType === 'cup') user.weeklyScore = Number(user.weeklyScore ?? 0) + gift.amount;
  await repositories.users.save(user);
}

function fromRow(r: any): GiftCode {
  return { code: r.code, rewardType: r.reward_type, amount: Number(r.amount), tier: r.tier ?? undefined, maxUses: Number(r.max_uses), uses: Number(r.uses), expiresAt: r.expires_at?.toISOString?.() ?? r.expires_at ?? null, createdAt: r.created_at?.toISOString?.() ?? String(r.created_at) };
}
function randomCode(): string { return 'PZ' + Math.random().toString(36).slice(2, 8).toUpperCase(); }
