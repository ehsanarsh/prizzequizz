import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { equipCharacterItem, getCharacterCatalog, getUserCharacter, listAdminCharacterItems, listCharacterUnlockEvents, purchaseCharacterItem, randomizeCharacter, unlockCharacterItem, updateCharacterItemStatus, upsertCharacterItem } from '../../services/characterService.js';
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
}
