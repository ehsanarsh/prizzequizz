import type { Router } from '../../http/router.js';
import { json } from '../../http/response.js';
import { listItems } from '../../services/shopService.js';
import { ticketPrizeTable } from '../../services/prizeService.js';
import { getPromos, updatePromos, PromoError, PROMO_IMAGE_MAX_BYTES } from '../../services/ticketPromoService.js';
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
        price: it.price, currency: it.currency, effectKey: it.effectKey, effectValue: it.effectValue, badge: it.badge
      });
    }
    json(ctx.res, 200, { items: items.map((it) => ({ id: it.id, category: it.category, icon: it.icon, name: it.name, description: it.description, price: it.price, currency: it.currency, effectKey: it.effectKey, effectValue: it.effectValue, badge: it.badge })), categories });
  });
}
