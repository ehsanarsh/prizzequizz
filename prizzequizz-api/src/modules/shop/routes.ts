import type { Router } from '../../http/router.js';
import { json } from '../../http/response.js';
import { listItems } from '../../services/shopService.js';

export function registerShopRoutes(router: Router, base: string): void {
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
