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
import { addCoins, addUserNumber } from './coinService.js';
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

  /* Pay first: a granted item nobody was charged for is the worse failure.
   * What was actually taken in COINS is remembered, because coins have no
   * ledger to point at afterwards — so if the grant then fails, the only way
   * the player can be made whole is to put them straight back. */
  let charged = 0;
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
      /* ASKING AND TAKING ARE ONE STEP. Reading the balance, comparing it and
       * writing the difference back left a gap two purchases could both get
       * through — both saw enough coins, both wrote «what I read minus my
       * price», and one of the two charges vanished. The condition now lives
       * in the write itself, so a refusal means nothing was taken. */
      const left = await addCoins(userId, -price);
      if (left === null) throw new ShopError('INSUFFICIENT_COINS', 'سکه‌ات کافی نیست.');
      charged = price;
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
      await addCoins(userId, n);
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
      await addUserNumber(userId, 'xp', n);
    } else {
      /* Cosmetics and gifts have no balance to move; the purchase is the
         record. They are still listed, so the receipt is complete. */
    }
    granted.push({ key: k2, value: n, label: rewardLabel(k2) });
  }
  } catch (e) {
    /* CHARGED AND GIVEN NOTHING IS THE ONE OUTCOME WORTH UNDOING.
     * A cash purchase leaves a ledger row somebody can point at and reverse;
     * coins have no ledger, so a grant that fails after the coins are taken
     * would simply leave the player poorer with nothing to show and nothing to
     * find. The charge goes straight back, and only then does the failure
     * travel on — which is also what makes it safe for the caller to drop the
     * idempotency claim and let them try again. */
    if (charged > 0) {
      await addCoins(userId, charged).catch((e2) => {
        /* Now it IS a support case, so it says so with everything needed to
         * settle it by hand. */
        logger.error('shop_refund_failed', { userId, itemId: item.id, coins: charged, key,
          message: e2 instanceof Error ? e2.message : 'unknown' });
      });
      logger.warn('shop_purchase_refunded', { userId, itemId: item.id, coins: charged,
        reason: e instanceof Error ? e.message : 'unknown' });
    }
    throw e;
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
