/* PAYING FOR SOMETHING, THE TWO WAYS A PLAYER CAN PAY.
 *
 * The old model was a wallet: you topped it up at the gateway, and every
 * purchase came out of the balance. That is gone. There is no topping up any
 * more — the صندوق جایزه only ever fills with prizes the player won.
 *
 * So a purchase now has to name its own funding:
 *
 *   vault    debit the صندوق جایزه, exactly as a wallet purchase used to work
 *   gateway  send the player to the payment gateway for THIS purchase, and
 *            hand over the goods when the gateway says it was paid — without
 *            the money ever passing through the صندوق
 *
 * That second one is the whole reason this file exists. A gateway payment used
 * to settle by crediting a deposit; now it settles by delivering an order. The
 * order travels with the payment intent, so a callback arriving minutes later
 * on a different process still knows what was bought.
 *
 * Fulfilment is idempotent on the order reference: a gateway that calls back
 * twice, or a player who refreshes the return page, must not be given the item
 * twice.
 */
import { isLeagueTicketTier } from './leagueService.js';
import { isValidTier, ticketName, grantTickets } from './ticketService.js';
import { getTicketPrices } from './economyConfig.js';
import { getItem, rewardsOf, rewardLabel } from './shopService.js';
import { purchase as shopPurchase } from './shopPurchaseService.js';
import { redeemDiscount, releaseDiscount, quoteDiscount } from './discountService.js';
import { postEntry, getAccount, WalletError } from './walletLedgerService.js';
import { recordPurchase } from './missionService.js';
import { claimFulfilment, settleFulfilment, abandonFulfilment, _resetFulfilmentGuard } from './fulfilmentGuard.js';
import { logger } from './logger.js';

export type PayMethod = 'vault' | 'gateway';

export interface PurchaseOrder {
  kind: 'ticket' | 'shop';
  /** ticket tier, when kind === 'ticket' */
  tier?: string;
  /** shop item id, when kind === 'shop' */
  itemId?: string;
  qty: number;
}

export interface OrderQuote {
  order: PurchaseOrder;
  /** Toman. Coin-priced shop items quote 0 here and carry currency 'coins'. */
  amount: number;
  currency: 'cash' | 'coins';
  label: string;
}

export class OrderError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'OrderError'; }
}

export function parseOrder(raw: unknown): PurchaseOrder | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const kind = String(o.kind ?? '');
  const qty = Math.max(1, Math.min(20, Math.floor(Number(o.qty) || 1)));
  if (kind === 'ticket') {
    const tier = String(o.tier ?? '').trim();
    return tier ? { kind: 'ticket', tier, qty } : null;
  }
  if (kind === 'shop') {
    const itemId = String(o.itemId ?? '').trim();
    return itemId ? { kind: 'shop', itemId, qty } : null;
  }
  return null;
}

/** What this order costs and what to call it, without charging anything. */
export async function quote(order: PurchaseOrder): Promise<OrderQuote> {
  if (order.kind === 'ticket') {
    if (!isValidTier(order.tier!)) throw new OrderError('TICKET_TIER_INVALID', 'نوع بلیط نامعتبر است.');
    /* A league ticket is the reward for a week on the board. Being able to buy
     * one would make the ladder a price list, so the refusal is here — before
     * anything is quoted, let alone charged. */
    if (isLeagueTicketTier(order.tier!)) {
      throw new OrderError('LEAGUE_TICKET_NOT_FOR_SALE', 'بلیط لیگ خریدنی نیست — فقط از جدول هفتگی به دست می‌آید.');
    }
    const unit = getTicketPrices()[order.tier!] ?? 0;
    return { order, amount: unit * order.qty, currency: 'cash', label: ticketName(order.tier!) + (order.qty > 1 ? ` ×${order.qty}` : '') };
  }
  const item = await getItem(order.itemId!);
  if (!item) throw new OrderError('ITEM_NOT_FOUND', 'این محصول وجود ندارد.');
  if (!item.enabled) throw new OrderError('ITEM_DISABLED', 'این محصول فعلاً موجود نیست.');
  const unit = Math.max(0, Math.floor(item.price));
  return {
    order,
    amount: unit * order.qty,
    currency: item.currency === 'coins' ? 'coins' : 'cash',
    label: item.name + (order.qty > 1 ? ` ×${order.qty}` : '')
  };
}

/* WHAT THE PAYMENT SHEET IS TOLD.
 *
 * This was written inline in the route, and a route is a place nothing can
 * reach: the browser tests stub the API, so every line of it could be broken
 * without a single test noticing. It is here because here it can be tested.
 *
 * Note what it returns: `amount` is what will be CHARGED and `listPrice` is
 * what it was before the code. The sheet needs both — a discounted price shown
 * on its own is a number the player has to take on trust — and neither is the
 * browser's to work out. */
export interface OrderSheet {
  order: PurchaseOrder;
  amount: number;
  listPrice: number;
  currency: 'cash' | 'coins';
  label: string;
  discount: number;
  discountCode: string;
  discountError: string;
  vaultBalance: number;
  canPayFromVault: boolean;
  canPayByGateway: boolean;
}

export async function quoteForSheet(input: { userId: string; order: PurchaseOrder; code?: string; vaultBalance: number }): Promise<OrderSheet> {
  const q = await quote(input.order);
  const code = String(input.code ?? '').trim();
  /* Pricing a code is not spending it: this runs on every press of the button,
     so it has to be free to call. A coin price has nothing to discount. */
  const d = (code && q.currency === 'cash')
    ? await quoteDiscount({ code, userId: input.userId, amount: q.amount })
    : null;
  const discount = d?.ok ? d.amountOff : 0;
  const amount = Math.max(0, q.amount - discount);
  const vault = Math.max(0, Number(input.vaultBalance) || 0);
  return {
    order: q.order, amount, listPrice: q.amount, currency: q.currency, label: q.label,
    discount, discountCode: d?.ok ? d.code! : '',
    /* A code that was typed and refused has to say why, or the player retypes
       the same thing and concludes the shop is broken. */
    discountError: (code && !d?.ok) ? (d?.message ?? 'این کد معتبر نیست.') : '',
    vaultBalance: vault,
    /* Judged against what will be CHARGED. A صندوق that cannot cover the list
       price may well cover what is left after a code — refusing it would hide a
       door the player can walk through. */
    canPayFromVault: q.currency === 'coins' ? true : vault >= amount,
    canPayByGateway: isGatewayPayable(q)
  };
}

/** Is this order something a gateway can be asked to take money for? */
export function isGatewayPayable(q: OrderQuote): boolean {
  return q.currency === 'cash' && q.amount > 0;
}

/* ---------------------------------------------------------------------------
 * Fulfilment — hand over the goods. NEVER charges; the caller has already
 * arranged payment one way or the other.
 * ------------------------------------------------------------------------- */
export interface Fulfilment {
  granted: Array<{ key: string; value: number; label: string }>;
  duplicate: boolean;
}

export async function fulfil(userId: string, order: PurchaseOrder, ref: string): Promise<Fulfilment> {
  if (order.kind === 'ticket') {
    /* grantTickets is not idempotent on its own, so the reference is what
     * stops a replayed callback issuing a second ticket. The mark is in
     * Postgres, so it still stops it after a restart. */
    const claim = await claimFulfilment(ref);
    if (!claim.fresh) {
      /* Tell the duplicate what the first caller actually handed over, rather
       * than an empty list that reads like nothing was ever delivered. */
      const before = (claim.payload as Fulfilment['granted'] | null) ?? [];
      return { granted: before, duplicate: true };
    }
    const granted = [{ key: 'ticket-' + order.tier, value: order.qty, label: ticketName(order.tier!) }];
    try {
      await grantTickets(userId, order.tier!, order.qty);
      await recordPurchase(userId, { tickets: order.qty });
    } catch (e) {
      /* Drop the claim so a retry can still deliver what the player paid for. */
      await abandonFulfilment(ref);
      throw e;
    }
    await settleFulfilment(ref, granted);
    return { granted, duplicate: false };
  }
  /* The shop already knows how to grant a bundle and is idempotent on its key;
   * `paidExternally` is what tells it the money has come from somewhere other
   * than the صندوق. */
  const r = await shopPurchase({ userId, itemId: order.itemId!, qty: order.qty, idempotencyKey: ref, paidExternally: true });
  return { granted: r.granted ?? [], duplicate: !!r.duplicate };
}

/* The marks themselves live in fulfilmentGuard, which keeps them in Postgres so
 * they outlive the process. They used to be a Set in memory here; a deploy
 * during a gateway's retry run would have emptied it and paid out twice. */
/** Test seam. */
export const _resetFulfilled = _resetFulfilmentGuard;

/* ---------------------------------------------------------------------------
 * Paying from the صندوق جایزه.
 * ------------------------------------------------------------------------- */
/* PAYING FROM THE صندوق, WITH A CODE IF THERE IS ONE.
 *
 * The code is SPENT FIRST and the charge is made for what is left. That order
 * matters: a player whose صندوق holds exactly the discounted price must be able
 * to pay, and charging the full price first would refuse them for not having
 * money they were never going to be asked for.
 *
 * `redeemDiscount` is keyed on this order's own reference, so a retry of the
 * same payment gets the same discount rather than a second one — and if the
 * charge then fails, the use is handed back, because a single-use code burned
 * on a purchase that never happened is the player's loss, not ours.
 */
export async function payFromVault(userId: string, order: PurchaseOrder, idempotencyKey: string, discountCode?: string): Promise<{ quote: OrderQuote; granted: Fulfilment['granted']; duplicate: boolean; balance: number; discount?: number }> {
  const q = await quote(order);
  if (q.currency === 'coins') {
    /* Coin-priced items never touched the صندوق; the shop debits coins itself. */
    const r = await shopPurchase({ userId, itemId: order.itemId!, qty: order.qty, idempotencyKey });
    const acct = await getAccount(userId).catch(() => ({ available: 0 } as any));
    return { quote: q, granted: r.granted ?? [], duplicate: !!r.duplicate, balance: Number(acct.available) || 0 };
  }
  const off = discountCode
    ? (await redeemDiscount({ code: discountCode, userId, amount: q.amount, ref: idempotencyKey })).amountOff
    : 0;
  const due = Math.max(0, q.amount - off);
  const giveBack = async () => { if (off > 0) await releaseDiscount(idempotencyKey).catch(() => {}); };

  if (due > 0) {
    const acct = await getAccount(userId).catch(() => ({ available: 0 } as any));
    if (Number(acct.available) < due) {
      await giveBack();
      throw new OrderError('INSUFFICIENT_VAULT', 'موجودی صندوق جایزه‌ات کافی نیست. می‌تونی از درگاه پرداخت کنی.');
    }
  }
  if (order.kind === 'ticket') {
    /* A CODE CAN MAKE AN ORDER FREE, AND FREE IS NOT A PAYMENT.
     * The ledger refuses an entry of zero — rightly, a row that moves nothing is
     * not a transaction — so there is simply nothing to post. The goods are
     * handed over on the fulfilment claim alone, which is idempotent on its own
     * reference, so a retried free order still delivers exactly once. */
    if (due === 0) {
      const f = await fulfil(userId, order, 'vault:' + idempotencyKey);
      const acct = await getAccount(userId).catch(() => ({ available: 0 } as any));
      return { quote: q, granted: f.granted, duplicate: f.duplicate, balance: Number(acct.available) || 0, discount: off };
    }
    const posted = await postEntry({
      userId, entryType: 'ticket_purchase', kind: 'debit', amount: due,
      idempotencyKey, refType: 'ticket', refId: order.tier!,
      description: `خرید ${q.label}` + (off > 0 ? ' (با تخفیف)' : ''),
      metadata: { listPrice: q.amount, discount: off }
    });
    if (posted.duplicate) return { quote: q, granted: [], duplicate: true, balance: posted.account.available, discount: off };
    try {
      const f = await fulfil(userId, order, 'vault:' + idempotencyKey);
      return { quote: q, granted: f.granted, duplicate: f.duplicate, balance: posted.account.available, discount: off };
    } catch (e) {
      await postEntry({
        userId, entryType: 'refund', kind: 'credit', amount: due,
        idempotencyKey: `order_refund:${posted.entry.id}`, refType: 'ticket', refId: order.tier!,
        description: 'برگشت وجه: صدور بلیت ناموفق بود'
      });
      await giveBack();
      throw e;
    }
  }
  /* Shop items priced in Toman: the shop's own path debits the صندوق. */
  try {
    const r = await shopPurchase({ userId, itemId: order.itemId!, qty: order.qty, idempotencyKey, discount: off });
    const acct = await getAccount(userId).catch(() => ({ available: 0 } as any));
    return { quote: q, granted: r.granted ?? [], duplicate: !!r.duplicate, balance: Number(acct.available) || 0, discount: off };
  } catch (e) { await giveBack(); throw e; }
}

/** Turn a WalletError from the ledger into the same shape callers expect. */
export function asOrderError(e: unknown): OrderError | null {
  if (e instanceof OrderError) return e;
  if (e instanceof WalletError) return new OrderError(e.code, e.message);
  return null;
}

export function describeOrder(q: OrderQuote): string {
  return q.label;
}

export function logOrder(event: string, fields: Record<string, unknown>): void {
  logger.info(event, fields);
}

export function labelForRewards(itemName: string, rows: Array<{ key: string; value: number }>): string {
  if (!rows.length) return itemName;
  return rows.map((r) => rewardLabel(r.key) + ' ×' + r.value).join(' + ');
}

export { rewardsOf };
