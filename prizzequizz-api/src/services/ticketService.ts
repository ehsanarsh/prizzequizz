/* Tickets are a DB-backed asset stored in users.tickets (JSONB) — SEPARATE from
 * the wallet balance. Every mutation is atomic and race-safe:
 *   - Postgres: a single conditional UPDATE (jsonb_set with a guard), so two
 *     concurrent consumes can never take the same ticket.
 *   - Memory driver: a per-user promise mutex around load-modify-save.
 * Purchasing a ticket debits the wallet (real ledger entry) and increments the
 * count in one flow with a compensating refund if the grant fails. Consuming a
 * ticket (match entry) and refunding one (no opponent) never touch the wallet.
 */
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';
import { getTicketPrices } from './economyConfig.js';
import { postEntry } from './walletLedgerService.js';
import { WalletError } from './walletLedgerService.js';

export class TicketError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

const memLocks = new Map<string, Promise<unknown>>();
function memLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = memLocks.get(userId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  memLocks.set(userId, next.catch(() => undefined));
  return next;
}

function isValidTier(tier: string): boolean { return Object.prototype.hasOwnProperty.call(getTicketPrices(), tier); }

export async function getTickets(userId: string): Promise<Record<string, number>> {
  const u = await repositories.users.findById(userId);
  return normalizeTickets(u?.tickets);
}

function normalizeTickets(t: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(getTicketPrices())) out[k] = Number(t?.[k] ?? 0) || 0;
  // preserve any legacy/extra tiers already stored
  if (t && typeof t === 'object') for (const k of Object.keys(t)) if (!(k in out)) out[k] = Number(t[k] ?? 0) || 0;
  return out;
}

/* Atomically add `delta` (+1 grant / −1 consume) to one tier. With a guard when
 * decrementing so the count can never go negative. Returns the new tickets map,
 * or null if the guard failed (nothing to consume). */
async function adjustTicket(userId: string, tier: string, delta: number): Promise<Record<string, number> | null> {
  const pool = pg();
  if (pool) {
    const guard = delta < 0 ? `AND COALESCE((tickets->>$2)::int,0) >= ${-delta}` : '';
    const { rows } = await pool.query(
      `UPDATE users
         SET tickets = jsonb_set(COALESCE(tickets,'{}'::jsonb), ARRAY[$2],
             to_jsonb(COALESCE((tickets->>$2)::int,0) + $3), true),
             updated_at = now()
       WHERE id = $1 ${guard}
       RETURNING tickets`,
      [userId, tier, delta]);
    if (!rows[0]) return null;
    return normalizeTickets(rows[0].tickets);
  }
  return memLock(userId, async () => {
    const u = await repositories.users.findById(userId);
    if (!u) return null;
    const tickets = normalizeTickets(u.tickets);
    const cur = tickets[tier] ?? 0;
    if (delta < 0 && cur + delta < 0) return null;
    tickets[tier] = cur + delta;
    u.tickets = tickets as any;
    await repositories.users.save(u);
    return tickets;
  });
}

export async function purchaseTicket(input: { userId: string; tier: string; ip?: string; device?: string; platform?: string; idempotencyKey: string }): Promise<{ tier: string; price: number; tickets: Record<string, number>; balance: number; duplicate: boolean }> {
  if (!isValidTier(input.tier)) throw new TicketError('TICKET_TIER_INVALID', 'نوع بلیط نامعتبر است.');
  const price = getTicketPrices()[input.tier]!;
  // 1) debit the wallet (atomic + idempotent per purchase)
  const posted = await postEntry({
    userId: input.userId, entryType: 'ticket_purchase', kind: 'debit', amount: price,
    idempotencyKey: input.idempotencyKey, refType: 'ticket', refId: input.tier,
    description: `خرید ${ticketName(input.tier)}`, ip: input.ip, device: input.device, platform: input.platform
  });
  if (posted.duplicate) {
    return { tier: input.tier, price, tickets: await getTickets(input.userId), balance: posted.account.available, duplicate: true };
  }
  // 2) grant the ticket; on failure refund the debit so money is never lost
  const tickets = await adjustTicket(input.userId, input.tier, +1);
  if (!tickets) {
    await postEntry({ userId: input.userId, entryType: 'refund', kind: 'credit', amount: price, idempotencyKey: `ticket_refund:${posted.entry.id}`, refType: 'ticket', refId: input.tier, description: 'برگشت وجه: صدور بلیت ناموفق بود' });
    throw new TicketError('TICKET_GRANT_FAILED', 'صدور بلیت ناموفق بود؛ مبلغ برگشت خورد.');
  }
  return { tier: input.tier, price, tickets, balance: posted.account.available, duplicate: false };
}

export async function consumeTicket(userId: string, tier: string): Promise<Record<string, number>> {
  if (!isValidTier(tier)) throw new TicketError('TICKET_TIER_INVALID', 'نوع بلیط نامعتبر است.');
  const tickets = await adjustTicket(userId, tier, -1);
  if (!tickets) throw new TicketError('NO_TICKET', `${ticketName(tier)} نداری.`);
  return tickets;
}

export async function refundTicket(userId: string, tier: string): Promise<Record<string, number>> {
  const tickets = await adjustTicket(userId, tier, +1);
  return tickets ?? await getTickets(userId);
}

function ticketName(tier: string): string {
  const m: Record<string, string> = { green: 'بلیط سبز', blue: 'بلیط آبی', red: 'بلیط قرمز', bronze: 'بلیت برنزی', silver: 'بلیت نقره‌ای', gold: 'بلیت طلایی' };
  return m[tier] ?? `بلیط ${tier}`;
}

export { WalletError };
