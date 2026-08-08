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
import { grantTickets } from './ticketService.js';
import { repositories } from '../repositories/index.js';
import { recordPurchase } from './missionService.js';
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

/* Purchases already settled, so a repeat returns the same answer instead of
 * charging again. Keyed by the caller's idempotency key. */
const _seen = new Map<string, PurchaseResult>();

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
}): Promise<PurchaseResult> {
  const { userId, itemId } = input;
  const key = String(input.idempotencyKey || '').trim();
  if (!key) throw new ShopError('IDEMPOTENCY_REQUIRED', 'کلید یکتا لازم است.');
  const cached = _seen.get(key);
  if (cached) return { ...cached, duplicate: true };

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
  if (price > 0) {
    if (item.currency === 'cash') {
      const acct = await getAccount(userId).catch(() => ({ available: Number(user.wallet) || 0 } as any));
      if (Number(acct.available) < price) throw new ShopError('INSUFFICIENT_FUNDS', 'موجودی کیف پولت کافی نیست.');
      await postEntry({
        userId, entryType: 'shop_purchase', kind: 'debit', amount: price,
        idempotencyKey: 'shop:' + key, description: 'خرید از فروشگاه: ' + item.name
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
      await grantTickets(userId, k2.slice('ticket-'.length) || 'green', n);
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
  _seen.set(key, result);
  /* Bounded: this only has to outlive a retry, not the process. */
  if (_seen.size > 5000) for (const k2 of [..._seen.keys()].slice(0, 1000)) _seen.delete(k2);

  logger.info('shop_purchase', { userId, itemId: item.id, effectKey: item.effectKey, value, price, currency: item.currency });
  return result;
}

/** Test seam. */
export function _resetPurchaseMemory(): void { _seen.clear(); }
