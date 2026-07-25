import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { equipCharacterItem, getCharacterCatalog, getUserCharacter, listAdminCharacterItems, listCharacterUnlockEvents, purchaseCharacterItem, randomizeCharacter, unlockCharacterItem, updateCharacterItemStatus, upsertCharacterItem } from '../../services/characterService.js';
import { CHARACTER_CATEGORIES, getBuild, getPart, listParts, removePart, savePart, saveBuild } from '../../services/characterPartsService.js';
import type { CharacterItemStatus } from '../../types/domain.js';
import { bodyObject, requiredString } from '../../utils/validation.js';

export function registerCharacterRoutes(router: Router, base: string): void {
  router.add('GET', `${base}/characters/catalog`, async (ctx) => json(ctx.res, 200, await getCharacterCatalog('active')));
  router.add('GET', `${base}/characters/me`, async (ctx) => json(ctx.res, 200, await getUserCharacter(ctx.userId ?? 'u1')));
  router.add('POST', `${base}/characters/equip`, async (ctx) => json(ctx.res, 200, await equipCharacterItem(ctx.userId ?? 'u1', bodyObject(ctx.body) as any)));
  router.add('POST', `${base}/characters/unlock`, async (ctx) => json(ctx.res, 200, await unlockCharacterItem(ctx.userId ?? 'u1', requiredString(bodyObject(ctx.body), 'itemId'))));
  router.add('POST', `${base}/characters/purchase`, async (ctx) => json(ctx.res, 200, await purchaseCharacterItem(ctx.userId ?? 'u1', requiredString(bodyObject(ctx.body), 'itemId'))));
  router.add('POST', `${base}/characters/randomize`, async (ctx) => json(ctx.res, 200, await randomizeCharacter(ctx.userId ?? 'u1')));

  router.add('GET', `${base}/admin/characters/catalog`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await listAdminCharacterItems((ctx.query.get('status') || undefined) as CharacterItemStatus | undefined));
  });

  router.add('POST', `${base}/admin/characters/items`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const body = bodyObject(ctx.body) as any;
    json(ctx.res, 201, await upsertCharacterItem({ ...body, id: requiredString(body, 'id') }));
  });

  router.add('PATCH', `${base}/admin/characters/items/:id/status`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const status = String((ctx.body as any)?.status ?? 'active') as CharacterItemStatus;
    if (!['active','draft','archived'].includes(status)) return error(ctx.res, 422, 'CHARACTER_STATUS_INVALID', 'Invalid character item status.');
    const updated = await updateCharacterItemStatus(ctx.params.id!, status);
    if (!updated) return error(ctx.res, 404, 'CHARACTER_ITEM_NOT_FOUND', 'Character item not found.');
    json(ctx.res, 200, updated);
  });

  router.add('POST', `${base}/admin/characters/users/:userId/unlock`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const itemId = requiredString(bodyObject(ctx.body), 'itemId');
    json(ctx.res, 200, await unlockCharacterItem(ctx.params.userId!, itemId, 'admin'));
  });

  router.add('GET', `${base}/admin/characters/users/:userId/events`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await listCharacterUnlockEvents(ctx.params.userId!, Number(ctx.query.get('limit') ?? 100)));
  });

  // ================= CHARACTER BUILDER (layered parts) =================
  // Public: the ordered category list + all enabled parts, so the client can
  // render the layered canvas without any hard-coded catalog.
  router.add('GET', `${base}/character-builder/parts`, async (ctx) => {
    const category = ctx.query.get('category') || undefined;
    const parts = await listParts({ category, enabledOnly: true });
    const byCategory: Record<string, any[]> = {};
    for (const c of CHARACTER_CATEGORIES) byCategory[c] = [];
    for (const p of parts) (byCategory[p.category] ??= []).push({ id: p.id, category: p.category, name: p.name, imageUrl: p.imageUrl, zIndex: p.zIndex });
    json(ctx.res, 200, { categories: CHARACTER_CATEGORIES, parts: parts.map((p) => ({ id: p.id, category: p.category, name: p.name, imageUrl: p.imageUrl, zIndex: p.zIndex })), byCategory });
  });

  // The signed-in user's saved build (selected part id per category).
  router.add('GET', `${base}/character-builder/build`, async (ctx) => {
    json(ctx.res, 200, { build: await getBuild(ctx.userId ?? 'u1') });
  });

  router.add('PUT', `${base}/character-builder/build`, async (ctx) => {
    const body = bodyObject(ctx.body) as any;
    const build = (body.build && typeof body.build === 'object') ? body.build : body;
    json(ctx.res, 200, { build: await saveBuild(ctx.userId ?? 'u1', build) });
  });

  // ---- Admin catalog management (like the shop) ----
  router.add('GET', `${base}/admin/character-parts`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'characterbuilder' })) return;
    const category = ctx.query.get('category') || undefined;
    json(ctx.res, 200, { categories: CHARACTER_CATEGORIES, parts: await listParts({ category }) });
  });

  router.add('POST', `${base}/admin/character-parts`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'characterbuilder' })) return;
    const body = bodyObject(ctx.body) as any;
    try {
      const part = await savePart({
        id: body.id, category: requiredString(body, 'category'), name: requiredString(body, 'name'),
        imageUrl: requiredString(body, 'imageUrl'),
        zIndex: body.zIndex != null ? Number(body.zIndex) : undefined,
        enabled: body.enabled != null ? !!body.enabled : undefined,
        sortOrder: body.sortOrder != null ? Number(body.sortOrder) : undefined
      });
      json(ctx.res, body.id ? 200 : 201, part);
    } catch (e) { error(ctx.res, 422, 'PART_INVALID', (e as Error).message || 'Invalid part.'); }
  });

  router.add('DELETE', `${base}/admin/character-parts/:id`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'characterbuilder' })) return;
    const removed = await removePart(ctx.params.id!);
    if (!removed) return error(ctx.res, 404, 'PART_NOT_FOUND', 'Character part not found.');
    json(ctx.res, 200, { removed });
  });

  // Toggle enabled quickly (show/hide in the builder without deleting).
  router.add('PATCH', `${base}/admin/character-parts/:id`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'characterbuilder' })) return;
    const existing = await getPart(ctx.params.id!);
    if (!existing) return error(ctx.res, 404, 'PART_NOT_FOUND', 'Character part not found.');
    const body = bodyObject(ctx.body) as any;
    const part = await savePart({
      id: existing.id, category: existing.category, name: body.name != null ? String(body.name) : existing.name,
      imageUrl: existing.imageUrl,
      zIndex: body.zIndex != null ? Number(body.zIndex) : existing.zIndex,
      enabled: body.enabled != null ? !!body.enabled : existing.enabled,
      sortOrder: body.sortOrder != null ? Number(body.sortOrder) : existing.sortOrder
    });
    json(ctx.res, 200, part);
  });
}
