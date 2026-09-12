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
import { claimFulfilment, settleFulfilment, abandonFulfilment, _resetFulfilmentGuard } from './fulfilmentGuard.js';
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

async function balancesOf(userId: string): Promise<{ wallet: number; coins: number; hearts: number }> {
  const user = await repositories.users.findById(userId);
  let wallet = Number(user?.wallet ?? 0);
  /* `available` is the spendable part — locked funds are mid-withdrawal and
     must not read as money the player can shop with. */
  try { wallet = (await getAccount(userId)).available; } catch { /* ledger optional */ }
  return { wallet, coins: Number(user?.coins ?? 0), hearts: Number(user?.hearts ?? 0) };
}

export interface PurchaseInput {
  userId: string; itemId: string; idempotencyKey: string; qty?: number;
  /* The money has already been taken somewhere else — a gateway payment for
   * THIS order. Grant the goods and charge nothing; the صندوق must not move,
   * because the player did not pay from it. */
  paidExternally?: boolean;
}

/* The idempotency key is honoured OUTSIDE the purchase itself, by the same
 * durable guard the gateway's callbacks use: claim the key, buy, record what
 * was handed over. A repeat gets told what the first one delivered instead of
 * being charged again — and it still gets told that after a restart, which a
 * Map in this process could not manage. */
export async function purchase(input: PurchaseInput): Promise<PurchaseResult> {
  const key = String(input.idempotencyKey || '').trim();
  if (!key) throw new ShopError('IDEMPOTENCY_REQUIRED', 'کلید یکتا لازم است.');
  const ref = 'shop:' + key;
  const claim = await claimFulfilment(ref);
  if (!claim.fresh) {
    const prior = claim.payload as PurchaseResult | null;
    if (prior) return { ...prior, duplicate: true };
    /* Claimed but not yet settled: the very same purchase is being served right
     * now, somewhere else. Going ahead would charge twice, which is the one
     * thing the key exists to prevent, so this one is told to come back. */
    throw new ShopError('PURCHASE_IN_FLIGHT', 'همین خرید همین حالا در حال انجام است؛ چند لحظه دیگر دوباره امتحان کن.');
  }
  let result: PurchaseResult;
  try {
    result = await runPurchase(input);
  } catch (e) {
    /* Nothing was handed over, so the key must not stay burnt: a player who
     * refused, topped up, or fixed whatever failed has to be able to retry. */
    await abandonFulfilment(ref);
    throw e;
  }
  await settleFulfilment(ref, result);
  return result;
}

async function runPurchase(input: PurchaseInput): Promise<PurchaseResult> {
  const { userId, itemId } = input;
  const key = String(input.idempotencyKey).trim();
  const qty = Math.max(1, Math.min(20, Math.floor(Number(input.qty) || 1)));
  const item = await getItem(itemId);
  if (!item) throw new ShopError('ITEM_NOT_FOUND', 'این محصول وجود ندارد.');
  if (!item.enabled) throw new ShopError('ITEM_DISABLED', 'این محصول فعلاً موجود نیست.');

  const user = await repositories.users.findById(userId);
  if (!user) throw new ShopError('USER_NOT_FOUND', 'کاربر پیدا نشد.');

  const price = Math.max(0, Math.floor(item.price)) * qty;
  const value = Math.max(0, Math.floor(item.effectValue)) * qty;

  /* Pay first. If the charge fails there is nothing to unwind; if the grant
   * fails afterwards it is a support case with a ledger entry to point at,
   * which is far better than a granted item nobody was charged for. */
  if (price > 0 && !input.paidExternally) {
    if (item.currency === 'cash') {
      const acct = await getAccount(userId).catch(() => ({ available: Number(user.wallet) || 0 } as any));
      if (Number(acct.available) < price) throw new ShopError('INSUFFICIENT_FUNDS', 'موجودی کیف پولت کافی نیست.');
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
      if (have < price) throw new ShopError('INSUFFICIENT_COINS', 'سکه‌ات کافی نیست.');
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

  /* Missions. Only what was really charged and really granted is reported, so
   * a failed purchase can never advance «۱۰۰۰ سکه خرج کن». */
  await recordPurchase(userId, {
    coins: item.currency === 'coins' ? price : 0,
    tickets: ticketsGranted
  });

  const result: PurchaseResult = {
    itemId: item.id, name: item.name, icon: item.icon,
    effectKey: item.effectKey, effectValue: value,
    granted,
    price, currency: item.currency, duplicate: false,
    balances: await balancesOf(userId)
  };
  logger.info('shop_purchase', { userId, itemId: item.id, effectKey: item.effectKey, value, price, currency: item.currency });
  return result;
}

/** Test seam. */
export const _resetPurchaseMemory = _resetFulfilmentGuard;
