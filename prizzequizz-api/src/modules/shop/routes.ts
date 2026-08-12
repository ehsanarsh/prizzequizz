import type { Router } from '../../http/router.js';
import { json } from '../../http/response.js';
import { listItems, rewardsOf, rewardLabel } from '../../services/shopService.js';
import { ShopError, purchase } from '../../services/shopPurchaseService.js';
import { ticketPrizeTable } from '../../services/prizeService.js';
import { getPromos, updatePromos, PromoError, PROMO_IMAGE_MAX_BYTES } from '../../services/ticketPromoService.js';
import { activeBanners, listBanners, saveBanner, removeBanner, BannerError, BANNER_SLOTS, BANNER_SLOT_LABELS } from '../../services/bannerService.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { error } from '../../http/response.js';

export function registerShopRoutes(router: Router, base: string): void {
  /* PUBLIC PRIZE TABLE — what a winner takes home at each ticket tier.
   * The server does the maths and sends the final figure only: no percentage,
   * no fee amount, nothing for a client to recompute. Because it reads the live
   * admin Game Config, changing the commission in the panel changes every quote
   * in the app on the next request. */
  router.add('GET', `${base}/economy/prizes`, async (ctx) => {
    json(ctx.res, 200, { tickets: ticketPrizeTable() });
  });

  /* The admin-owned banner shown on each of the three ticket screens. */
  /* Banners: any screen, image / GIF / video. The old three-slot promo
   * endpoints below are kept so a client that has not updated still works. */
  router.add('GET', `${base}/banners`, async (ctx) => {
    json(ctx.res, 200, await activeBanners());
  });
  router.add('GET', `${base}/admin/banners`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, { banners: await listBanners(), slots: BANNER_SLOTS, labels: BANNER_SLOT_LABELS });
  });
  router.add('POST', `${base}/admin/banners`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    try { json(ctx.res, 200, await saveBanner((ctx.body ?? {}) as any)); }
    catch (e) { if (e instanceof BannerError) return error(ctx.res, 400, e.code, e.message); throw e; }
  });
  router.add('DELETE', `${base}/admin/banners/:id`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, { removed: await removeBanner(ctx.params.id!) });
  });

  router.add('GET', `${base}/economy/ticket-promos`, async (ctx) => {
    json(ctx.res, 200, await getPromos());
  });

  router.add('GET', `${base}/admin/ticket-promos`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'shop' })) return;
    json(ctx.res, 200, { promos: await getPromos(), maxImageBytes: PROMO_IMAGE_MAX_BYTES });
  });

  router.add('PUT', `${base}/admin/ticket-promos`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'shop' })) return;
    try {
      json(ctx.res, 200, { promos: await updatePromos(ctx.body ?? {}) });
    } catch (e) {
      if (e instanceof PromoError) return error(ctx.res, 422, e.code, e.message);
      throw e;
    }
  });

  // Public catalog the in-game shop reads. Only ENABLED items, grouped by
  // category in display order.
  router.add('GET', `${base}/shop/items`, async (ctx) => {
    const category = ctx.query.get('category') || undefined;
    const items = await listItems({ category, enabledOnly: true });
    const categories: Record<string, any[]> = {};
    for (const it of items) {
      (categories[it.category] ??= []).push({
        id: it.id, category: it.category, icon: it.icon, name: it.name, description: it.description,
        price: it.price, currency: it.currency, effectKey: it.effectKey, effectValue: it.effectValue, badge: it.badge,
        rewards: rewardsOf(it).map((r) => ({ ...r, label: rewardLabel(r.key) })), image: it.image
      });
    }
    /* `rewards` is what the card lists («۳ بلیط + ۴۰۰ سکه + ۲ کمک») and what the
       receipt is written from. It is always present — a plain item is simply a
       bundle of one — so the client never has to interpret effectKey itself. */
    json(ctx.res, 200, { items: items.map((it) => ({ id: it.id, category: it.category, icon: it.icon, name: it.name, description: it.description, price: it.price, currency: it.currency, effectKey: it.effectKey, effectValue: it.effectValue, badge: it.badge, rewards: rewardsOf(it).map((r) => ({ ...r, label: rewardLabel(r.key) })), image: it.image })), categories });
  });

  /* The half that was missing: paying for an item and receiving it. Without
   * this every price in the shop was decoration. */
  router.add('POST', `${base}/shop/purchase`, async (ctx) => {
    const b = (ctx.body ?? {}) as any;
    try {
      json(ctx.res, 200, await purchase({
        userId: ctx.userId ?? 'u1',
        itemId: String(b.itemId ?? ''),
        qty: Number(b.qty) || 1,
        idempotencyKey: String(b.idempotencyKey ?? '')
      }));
    } catch (e) {
      if (e instanceof ShopError) {
        const status = e.code === 'ITEM_NOT_FOUND' ? 404
          : (e.code === 'INSUFFICIENT_FUNDS' || e.code === 'INSUFFICIENT_COINS') ? 409 : 422;
        return error(ctx.res, status, e.code, e.message);
      }
      throw e;
    }
  });
}
