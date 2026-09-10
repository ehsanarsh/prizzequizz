/* BUYING FROM THE SHOP.
 *
 * The shop had a catalogue and no way to pay for anything — every item was a
 * price tag with nothing behind it, which is why hearts could not be bought.
 * This is the missing half: take the money, grant the effect, and write both
 * to the ledger so a purchase can be traced afterwards.
 *
 * Every purchase carries an idempotency key. A tapped-twice button, a retried
 * request on a flaky connection, or a client that resends must charge once.
 */
import { getItem, rewardsOf, rewardLabel } from './shopService.js';
import { postEntry, getAccount } from './walletLedgerService.js';
import { addHearts } from './heartService.js';
import { grantLifeline } from './lifelineService.js';
import { isLeagueTicketTier } from './leagueService.js';
import { grantTickets } from './ticketService.js';
import { repositories } from '../repositories/index.js';
import { recordPurchase } from './missionService.js';
import * as fulfilments from './orderFulfilmentService.js';
import type { FulfilSource } from './orderFulfilmentService.js';
import { logger } from './logger.js';

export class ShopError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface PurchaseResult {
  itemId: string;
  name: string;
  icon: string;
  effectKey: string;
  effectValue: number;
  /* Exactly what this purchase handed over, in order, already multiplied by
     the quantity — so the game can say «۳ بلیط سبز و ۴۰۰ سکه خریداری شد»
     without knowing anything about how the item was configured. */
  granted: Array<{ key: string; value: number; label: string }>;
  price: number;
  currency: 'coins' | 'cash';
  duplicate: boolean;
  /** What the header should now read. */
  balances: { wallet: number; coins: number; hearts: number };
}

/* Purchases already settled are remembered in `order_fulfilments`, so a repeat
 * returns the same answer instead of charging again. It used to be a bounded
 * Map in this process, which forgot the oldest five thousand keys and every
 * key at all on a restart. */

async function balancesOf(userId: string): Promise<{ wallet: number; coins: number; hearts: number }> {
  const user = await repositories.users.findById(userId);
  let wallet = Number(user?.wallet ?? 0);
  /* `available` is the spendable part — locked funds are mid-withdrawal and
     must not read as money the player can shop with. */
  try { wallet = (await getAccount(userId)).available; } catch { /* ledger optional */ }
  return { wallet, coins: Number(user?.coins ?? 0), hearts: Number(user?.hearts ?? 0) };
}

export async function purchase(input: {
  userId: string; itemId: string; idempotencyKey: string; qty?: number;
  /* The money has already been taken somewhere else — a gateway payment for
   * THIS order. Grant the goods and charge nothing; the صندوق must not move,
   * because the player did not pay from it. */
  paidExternally?: boolean;
  /** Where the money came from, for the income report. Defaults from `paidExternally`. */
  source?: FulfilSource;
  /** The payment intent behind an externally-paid purchase. */
  paymentRef?: string;
}): Promise<PurchaseResult> {
  const { userId, itemId } = input;
  const key = String(input.idempotencyKey || '').trim();
  if (!key) throw new ShopError('IDEMPOTENCY_REQUIRED', 'کلید یکتا لازم است.');

  /* Everything that can refuse the purchase happens BEFORE the claim, so a
   * refusal never burns the key: a player who taps again after topping up
   * gets the same honest error rather than "already in progress". */
  const qty = Math.max(1, Math.min(20, Math.floor(Number(input.qty) || 1)));
  const item = await getItem(itemId);
  if (!item) throw new ShopError('ITEM_NOT_FOUND', 'این محصول وجود ندارد.');
  if (!item.enabled) throw new ShopError('ITEM_DISABLED', 'این محصول فعلاً موجود نیست.');

  const user = await repositories.users.findById(userId);
  if (!user) throw new ShopError('USER_NOT_FOUND', 'کاربر پیدا نشد.');

  const price = Math.max(0, Math.floor(item.price)) * qty;
  const value = Math.max(0, Math.floor(item.effectValue)) * qty;

  const source: FulfilSource = input.source ?? (input.paidExternally ? 'gateway' : 'vault');
  const claim = await fulfilments.claim({
    ref: key, userId, source, kind: 'shop',
    order: { kind: 'shop', itemId, qty }, paymentRef: input.paymentRef
  });
  if (!claim.claimed) {
    const delivered = claim.record.payload as Omit<PurchaseResult, 'balances' | 'duplicate'> | null;
    /* Balances are read fresh: what was granted is history, what the header
     * should now read is not. */
    if (delivered) return { ...delivered, duplicate: true, balances: await balancesOf(userId) };
    throw new ShopError('PURCHASE_IN_PROGRESS', 'این خرید در حال انجام است؛ چند لحظهٔ دیگر دوباره تلاش کن.');
  }

  /* Pay first. A charge that fails leaves nothing to unwind, so the claim is
   * discarded and the key is free again. A grant that fails AFTER the charge
   * is money taken and goods not handed over — the claim stays, so what is
   * owed is written down instead of living in a support ticket. */
  if (price > 0 && !input.paidExternally) {
    if (item.currency === 'cash') {
      const acct = await getAccount(userId).catch(() => ({ available: Number(user.wallet) || 0 } as any));
      if (Number(acct.available) < price) {
        await fulfilments.discard(key);
        throw new ShopError('INSUFFICIENT_FUNDS', 'موجودی کیف پولت کافی نیست.');
      }
      await postEntry({
        userId, entryType: 'shop_purchase', kind: 'debit', amount: price,
        idempotencyKey: 'shop:' + key, description: 'خرید از فروشگاه: ' + item.name,
        /* WHAT WAS SOLD, not just that something was. «فروش آیتم‌ها در فروشگاه
         * به غیر از بلیط مسابقات» — the company's earnings count shop sales but
         * not ticket sales, and both come through here, so the accounting has
         * to be able to tell them apart. The row itself is the only place that
         * can say which: the catalogue can be re-categorised or the item
         * deleted, and a sale that happened last month must not change its
         * meaning because somebody edited the shop today. */
        metadata: { itemId: item.id, category: item.category, name: item.name, qty }
      });
    } else {
      const have = Number(user.coins) || 0;
      if (have < price) {
        await fulfilments.discard(key);
        throw new ShopError('INSUFFICIENT_COINS', 'سکه‌ات کافی نیست.');
      }
      user.coins = have - price;
      await repositories.users.save(user);
    }
  }

  /* ---- grant ----
   * Every row of the item, whether it is a plain one (one row) or a bundle
   * («۳ بلیط + ۴۰۰ سکه + ۲ کمک» — three rows). What actually lands is
   * collected as it happens, so the receipt the player is shown is a record of
   * what was granted rather than a re-reading of what was advertised. */
  const granted: Array<{ key: string; value: number; label: string }> = [];
  let ticketsGranted = 0;
  try {
    for (const row of rewardsOf(item)) {
      const k2 = row.key;
      const n = Math.max(0, Math.floor(row.value)) * qty;
      if (n <= 0) continue;
      if (k2 === 'heart') {
        await addHearts(userId, n);
      } else if (k2 === 'coins') {
        const u = (await repositories.users.findById(userId))!;
        u.coins = (Number(u.coins) || 0) + n;
        await repositories.users.save(u);
      } else if (k2.startsWith('ticket-')) {
        const tier = k2.slice('ticket-'.length) || 'green';
        /* League entry tickets are earned on the weekly board and nowhere else.
         * An operator can add anything to the shop catalogue, so the refusal
         * lives here rather than in what the catalogue happens to contain. */
        if (isLeagueTicketTier(tier)) {
          throw new Error('LEAGUE_TICKET_NOT_FOR_SALE');
        }
        await grantTickets(userId, tier, n);
        ticketsGranted += n;
      } else if (k2 === 'p5050' || k2 === 'psecond' || k2 === 'pstats' || k2 === 'ptime') {
        await grantLifeline(userId, k2, n);
      } else if (k2 === 'xp') {
        const u = (await repositories.users.findById(userId))!;
        u.xp = (Number(u.xp) || 0) + n;
        await repositories.users.save(u);
      } else {
        /* Cosmetics and gifts have no balance to move; the purchase is the
           record. They are still listed, so the receipt is complete. */
      }
      granted.push({ key: k2, value: n, label: rewardLabel(k2) });
    }
  } catch (e) {
    /* Charged and not delivered. The claim stays so the debt is written down
     * and a later attempt can finish it, instead of the key simply vanishing. */
    await fulfilments.fail(key, e instanceof Error ? e.message : 'grant failed');
    throw e;
  }

  const delivered = {
    itemId: item.id, name: item.name, icon: item.icon,
    effectKey: item.effectKey, effectValue: value,
    granted, price, currency: item.currency
  };
  /* The sale is now on the record — including WHAT was sold and what it was
   * worth, because a purchase paid from outside the صندوق leaves no trace in
   * the ledger and would otherwise be invisible to the finance report. */
  await fulfilments.complete(key, {
    payload: delivered,
    amountToman: item.currency === 'cash' ? price : 0,
    currency: item.currency === 'coins' ? 'coins' : 'cash',
    category: item.category
  });

  /* Missions. Only what was really charged and really granted is reported, so
   * a failed purchase can never advance «۱۰۰۰ سکه خرج کن» — and a counter that
   * throws must not cost the player the thing they just paid for. */
  await recordPurchase(userId, {
    coins: item.currency === 'coins' ? price : 0,
    tickets: ticketsGranted
  }).catch((e) => logger.warn('mission_record_failed', { key, message: e instanceof Error ? e.message : 'unknown' }));

  const result: PurchaseResult = { ...delivered, duplicate: false, balances: await balancesOf(userId) };

  logger.info('shop_purchase', { userId, itemId: item.id, effectKey: item.effectKey, value, price, currency: item.currency });
  return result;
}

