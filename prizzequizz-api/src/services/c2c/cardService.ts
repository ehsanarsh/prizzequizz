/* THE CARDS MONEY IS SENT TO.
 *
 * Each row is one of the operator's own bank cards. Two identifiers, and both
 * are needed for different halves of the flow:
 *
 *   pan         the 16 digits the player copies and sends money to
 *   account_no  what the bank prints in its SMS — Sepah, Refah and Tejarat all
 *               report the ACCOUNT, never the card
 *
 * Getting `pan` wrong is the worst failure this whole system has: the player's
 * money goes to a stranger and nothing on our side ever knows. So a card is
 * checked for length AND Luhn before it can be saved — a single mistyped digit
 * fails Luhn about nine times in ten, which is the difference between a typo
 * caught in the panel and a payment sent into the void.
 *
 * `min_amount_toman` is here rather than in a global setting because it is a
 * property of the receiving BANK: below it, no SMS is sent at all, so a payment
 * to this card cannot be confirmed. Different banks, different floors.
 */
import { getPgPool } from '../../database/postgres.js';
import { id } from '../../utils/id.js';
import { logger } from '../logger.js';

export const CARD_STATUSES = ['ACTIVE', 'INACTIVE', 'MAINTENANCE'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

/** The bank's SMS floor, in Toman. Below this a deposit is silent. */
export const DEFAULT_MIN_AMOUNT_TOMAN = 50_000;

export interface C2cCard {
  id: string;
  pan: string;
  accountNo: string;
  bankKey: string;
  holderName: string;
  bankName: string;
  status: CardStatus;
  priority: number;
  /** 0 = no cap. */
  dailyCapRial: number;
  minAmountToman: number;
  createdAt: string;
  updatedAt: string;
}

export class CardError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'CardError'; }
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
export async function ensureCardSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS c2c_cards (
      id TEXT PRIMARY KEY,
      pan TEXT NOT NULL,
      account_no TEXT NOT NULL DEFAULT '',
      bank_key TEXT NOT NULL DEFAULT '',
      holder_name TEXT NOT NULL DEFAULT '',
      bank_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      priority INT NOT NULL DEFAULT 100,
      daily_cap_rial BIGINT NOT NULL DEFAULT 0 CHECK (daily_cap_rial >= 0),
      min_amount_toman BIGINT NOT NULL DEFAULT ${DEFAULT_MIN_AMOUNT_TOMAN} CHECK (min_amount_toman >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS idx_c2c_cards_pick ON c2c_cards(status, priority);
  `);
  _schemaReady = true;
}

const mem = new Map<string, C2cCard>();

function rowToCard(r: any): C2cCard {
  return {
    id: r.id, pan: r.pan, accountNo: r.account_no ?? '', bankKey: r.bank_key ?? '',
    holderName: r.holder_name ?? '', bankName: r.bank_name ?? '',
    status: (CARD_STATUSES as readonly string[]).includes(r.status) ? r.status : 'INACTIVE',
    priority: Number(r.priority ?? 100),
    dailyCapRial: Number(r.daily_cap_rial ?? 0),
    minAmountToman: Number(r.min_amount_toman ?? DEFAULT_MIN_AMOUNT_TOMAN),
    createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    updatedAt: r.updated_at?.toISOString?.() ?? String(r.updated_at)
  };
}

/** Digits only, with the invisible direction marks banks embed stripped out. */
export function digitsOnly(raw: string): string {
  return String(raw ?? '')
    .replace(/[​-‏‪-‮⁦-⁩]/g, '')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\D/g, '');
}

/** Luhn — the checksum every bank card carries, and every typo fails. */
export function isValidPan(raw: string): boolean {
  const d = digitsOnly(raw);
  if (d.length !== 16) return false;
  let sum = 0;
  for (let i = 0; i < 16; i++) {
    let n = Number(d[15 - i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

/** «۶۲۷۴ ۱۲۱۷ ۷۷۰۴ ۴۲۵۶» — grouped for reading, never for pasting. */
export function formatPan(pan: string): string {
  const d = digitsOnly(pan);
  return (d.match(/.{1,4}/g) ?? [d]).join(' ');
}

export async function listCards(): Promise<C2cCard[]> {
  const pool = pg();
  if (pool) {
    await ensureCardSchema(pool);
    const { rows } = await pool.query(`SELECT * FROM c2c_cards ORDER BY priority, created_at`);
    return rows.map(rowToCard);
  }
  return [...mem.values()].sort((a, b) => a.priority - b.priority || (a.createdAt < b.createdAt ? -1 : 1));
}

export async function getCard(cardId: string): Promise<C2cCard | null> {
  return (await listCards()).find((c) => c.id === cardId) ?? null;
}

export async function saveCard(input: Partial<C2cCard> & { pan?: string }): Promise<C2cCard> {
  const existing = input.id ? await getCard(input.id) : null;
  const pan = input.pan != null ? digitsOnly(input.pan) : (existing?.pan ?? '');
  if (!isValidPan(pan)) {
    throw new CardError('CARD_PAN_INVALID', 'شمارهٔ کارت باید ۱۶ رقم و معتبر باشد؛ رقمی اشتباه وارد شده است.');
  }
  const accountNo = input.accountNo != null ? digitsOnly(input.accountNo) : (existing?.accountNo ?? '');
  if (!accountNo) {
    /* Without it, an SMS naming the account can never be tied back to this
     * card, and every payment to it lands in the manual queue. */
    throw new CardError('CARD_ACCOUNT_REQUIRED', 'شمارهٔ حساب لازم است — پیامک بانک حساب را می‌نویسد، نه کارت را.');
  }
  const status = (CARD_STATUSES as readonly string[]).includes(String(input.status))
    ? (input.status as CardStatus) : (existing?.status ?? 'ACTIVE');
  const now = new Date().toISOString();
  const card: C2cCard = {
    id: input.id || id(),
    pan,
    accountNo,
    bankKey: String(input.bankKey ?? existing?.bankKey ?? '').trim().slice(0, 40),
    holderName: String(input.holderName ?? existing?.holderName ?? '').trim().slice(0, 120),
    bankName: String(input.bankName ?? existing?.bankName ?? '').trim().slice(0, 80),
    status,
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : (existing?.priority ?? 100),
    dailyCapRial: Math.max(0, Math.round(Number(input.dailyCapRial ?? existing?.dailyCapRial ?? 0)) || 0),
    minAmountToman: Math.max(0, Math.round(Number(input.minAmountToman ?? existing?.minAmountToman ?? DEFAULT_MIN_AMOUNT_TOMAN)) || 0),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  const pool = pg();
  if (pool) {
    await ensureCardSchema(pool);
    await pool.query(
      `INSERT INTO c2c_cards(id,pan,account_no,bank_key,holder_name,bank_name,status,priority,daily_cap_rial,min_amount_toman,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET pan=$2,account_no=$3,bank_key=$4,holder_name=$5,bank_name=$6,status=$7,priority=$8,daily_cap_rial=$9,min_amount_toman=$10,updated_at=$12`,
      [card.id, card.pan, card.accountNo, card.bankKey, card.holderName, card.bankName, card.status,
       card.priority, card.dailyCapRial, card.minAmountToman, card.createdAt, card.updatedAt]);
  } else mem.set(card.id, card);
  logger.info('c2c_card_saved', { cardId: card.id, status: card.status, priority: card.priority });
  return card;
}

export async function removeCard(cardId: string): Promise<boolean> {
  const pool = pg();
  if (pool) {
    await ensureCardSchema(pool);
    const { rowCount } = await pool.query(`DELETE FROM c2c_cards WHERE id=$1`, [cardId]);
    return (rowCount ?? 0) > 0;
  }
  return mem.delete(cardId);
}

/** What has actually arrived on this card today, in Rial. */
export async function takenTodayRial(cardId: string): Promise<number> {
  const pool = pg();
  if (pool) {
    await ensureCardSchema(pool);
    const { rows } = await pool.query(
      `SELECT coalesce(sum(amount_rial),0)::bigint AS taken FROM c2c_sessions
        WHERE card_id=$1 AND status='PAID' AND updated_at >= date_trunc('day', now())`, [cardId]).catch(() => ({ rows: [{ taken: 0 }] } as any));
    return Number(rows[0]?.taken ?? 0);
  }
  const { _memPaidTodayRial } = await import('./sessionStore.js');
  return _memPaidTodayRial(cardId);
}

export interface CardRejection { card: C2cCard; why: string }

/**
 * The cards this amount may be sent to, best first — and, for the ones it may
 * not, why. The reasons are what the payment sheet tells the player and what
 * the panel shows the operator, so they are not thrown away.
 */
export async function eligibleCards(amountToman: number): Promise<{ eligible: C2cCard[]; rejected: CardRejection[] }> {
  const all = await listCards();
  const eligible: C2cCard[] = [];
  const rejected: CardRejection[] = [];
  for (const card of all) {
    if (card.status !== 'ACTIVE') { rejected.push({ card, why: card.status === 'MAINTENANCE' ? 'CARD_MAINTENANCE' : 'CARD_INACTIVE' }); continue; }
    /* The floor is measured on the ROUND amount, never on the payable figure
     * with its uniqueness suffix: leaning on 99 Rial to clear a bank's
     * threshold is a payment that stops being confirmable the day the suffix
     * mode changes, with nothing to point at. */
    if (amountToman <= card.minAmountToman) { rejected.push({ card, why: 'BELOW_SMS_FLOOR' }); continue; }
    if (card.dailyCapRial > 0 && (await takenTodayRial(card.id)) >= card.dailyCapRial) {
      rejected.push({ card, why: 'DAILY_CAP_REACHED' }); continue;
    }
    eligible.push(card);
  }
  return { eligible, rejected };
}

/** The lowest floor among cards that could ever take money — what the player is told. */
export async function lowestFloorToman(): Promise<number | null> {
  const active = (await listCards()).filter((c) => c.status === 'ACTIVE');
  if (!active.length) return null;
  return Math.min(...active.map((c) => c.minAmountToman));
}

/** Test seam. */
export function _resetCards(): void { mem.clear(); _schemaReady = false; }
