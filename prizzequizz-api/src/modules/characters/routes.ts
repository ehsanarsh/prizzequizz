/* CHARACTER SELECTION — player-facing roster + the panel that owns it.
 *
 * The player side is deliberately tiny: read the roster, equip one, open a box.
 * Every rule about what is unlocked lives in the service and is re-checked
 * there, so these handlers never have to trust the client's copy of the state. */
import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { bodyObject } from '../../utils/validation.js';
import {
  buildRoster, equipCharacter, listCharacters, saveCharacter, deleteCharacter,
  getCharacter, characterStats, grantToUsers, allUserIds, CharacterError,
  UNLOCK_SOURCES, CHARACTER_IMAGE_MAX_BYTES
} from '../../services/characterSelectionService.js';
import type { UnlockSource } from '../../services/characterSelectionService.js';
import {
  listBoxes, getBox, saveBox, deleteBox, drawFromBox, drawForUsers, oddsFor,
  DUPLICATE_POLICIES, BoxError
} from '../../services/characterBoxService.js';

/** Maps a thrown service error onto the right status code. */
function fail(res: any, e: unknown): void {
  if (e instanceof CharacterError || e instanceof BoxError) {
    const notFound = e.code.endsWith('NOT_FOUND');
    const locked = e.code === 'LOCKED' || e.code === 'LIMIT_REACHED' || e.code === 'BOX_DISABLED'
      || e.code === 'NOT_STARTED' || e.code === 'ENDED' || e.code === 'DISABLED' || e.code === 'BOX_EMPTY';
    return error(res, notFound ? 404 : locked ? 409 : 422, e.code, e.message);
  }
  error(res, 500, 'CHARACTER_FAILED', (e as Error)?.message || 'خطای غیرمنتظره.');
}

export function registerCharacterRoutes(router: Router, base: string): void {
  // ======================= PLAYER =======================

  /* The whole selection screen in one call: every character (locked ones
   * included, with the reason), which one is equipped, and the player's level
   * so the client can render progress toward the next unlock. */
  router.add('GET', `${base}/characters`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    try { json(ctx.res, 200, await buildRoster(ctx.userId)); } catch (e) { fail(ctx.res, e); }
  });

  router.add('POST', `${base}/characters/:id/equip`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    try {
      const character = await equipCharacter(ctx.userId, ctx.params.id!);
      json(ctx.res, 200, { equipped: true, character });
    } catch (e) { fail(ctx.res, e); }
  });

  /* Boxes a player may open right now. Weights and odds are NOT published —
   * knowing the exact table would let someone farm a box. */
  router.add('GET', `${base}/characters/boxes`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const now = Date.now();
    const open = (await listBoxes()).filter((b) =>
      b.enabled
      && (!b.startsAt || Date.parse(b.startsAt) <= now)
      && (!b.endsAt || Date.parse(b.endsAt) >= now));
    json(ctx.res, 200, {
      boxes: open.map((b) => ({ id: b.id, name: b.name, endsAt: b.endsAt, maxPerUser: b.maxPerUser, size: b.entries.length }))
    });
  });

  router.add('POST', `${base}/characters/boxes/:id/open`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    try { json(ctx.res, 200, await drawFromBox(ctx.params.id!, ctx.userId)); } catch (e) { fail(ctx.res, e); }
  });

  // ======================= ADMIN: ROSTER =======================

  router.add('GET', `${base}/admin/characters`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'characters' })) return;
    const [characters, stats] = await Promise.all([
      listCharacters({ includeDisabled: true }),
      characterStats()
    ]);
    const byId = new Map(stats.rows.map((r) => [r.id, r]));
    json(ctx.res, 200, {
      characters: characters.map((c) => ({ ...c, stats: byId.get(c.id) ?? null })),
      totalEquipped: stats.totalEquipped,
      imageMaxBytes: CHARACTER_IMAGE_MAX_BYTES,
      unlockSources: UNLOCK_SOURCES
    });
  });

  router.add('POST', `${base}/admin/characters`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'characters' })) return;
    const body = bodyObject(ctx.body) as any;
    try { json(ctx.res, body.id ? 200 : 201, await saveCharacter(body)); } catch (e) { fail(ctx.res, e); }
  });

  /* Quick toggles (enable/disable, reorder) without resending the artwork —
   * the payload for a character with an inline PNG is large. */
  router.add('PATCH', `${base}/admin/characters/:id`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'characters' })) return;
    const existing = await getCharacter(ctx.params.id!);
    if (!existing) return error(ctx.res, 404, 'NOT_FOUND', 'این کاراکتر وجود ندارد.');
    const body = bodyObject(ctx.body) as any;
    try { json(ctx.res, 200, await saveCharacter({ ...body, id: existing.id })); } catch (e) { fail(ctx.res, e); }
  });

  router.add('DELETE', `${base}/admin/characters/:id`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'characters' })) return;
    const removed = await deleteCharacter(ctx.params.id!);
    if (!removed) return error(ctx.res, 404, 'NOT_FOUND', 'این کاراکتر وجود ندارد.');
    json(ctx.res, 200, { removed });
  });

  router.add('GET', `${base}/admin/characters/stats`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'characters' })) return;
    json(ctx.res, 200, await characterStats());
  });

  /* Award a character. `target` is one of:
   *   { userId }          → one player
   *   { userIds: [...] }  → a list
   *   { all: true }       → everyone
   * `source` records WHY, which is what the statistics separate on. */
  router.add('POST', `${base}/admin/characters/:id/grant`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'characters' })) return;
    const body = bodyObject(ctx.body) as any;
    const source: UnlockSource = UNLOCK_SOURCES.includes(body.source) ? body.source : 'admin';

    let userIds: string[] = [];
    if (body.all === true) userIds = await allUserIds();
    else if (Array.isArray(body.userIds)) userIds = body.userIds.map((u: any) => String(u).trim()).filter(Boolean);
    else if (body.userId) userIds = [String(body.userId).trim()];

    if (!userIds.length) return error(ctx.res, 422, 'NO_TARGET', 'هیچ کاربری برای اهدا مشخص نشده است.');
    try {
      const r = await grantToUsers(ctx.params.id!, userIds, source);
      json(ctx.res, 200, { ...r, targeted: userIds.length, source });
    } catch (e) { fail(ctx.res, e); }
  });

  // ======================= ADMIN: RANDOM BOXES =======================

  router.add('GET', `${base}/admin/character-boxes`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'charboxes' })) return;
    const boxes = await listBoxes();
    json(ctx.res, 200, {
      // Odds are attached here so the panel never has to recompute them and
      // risk showing different numbers than the engine uses.
      boxes: boxes.map((b) => ({ ...b, odds: oddsFor(b) })),
      duplicatePolicies: DUPLICATE_POLICIES
    });
  });

  router.add('POST', `${base}/admin/character-boxes`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'charboxes' })) return;
    const body = bodyObject(ctx.body) as any;
    try {
      const box = await saveBox(body);
      json(ctx.res, body.id ? 200 : 201, { ...box, odds: oddsFor(box) });
    } catch (e) { fail(ctx.res, e); }
  });

  router.add('DELETE', `${base}/admin/character-boxes/:id`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'charboxes' })) return;
    const removed = await deleteBox(ctx.params.id!);
    if (!removed) return error(ctx.res, 404, 'NOT_FOUND', 'این باکس وجود ندارد.');
    json(ctx.res, 200, { removed });
  });

  /* Run a box on the panel's behalf. Limits are bypassed here on purpose: this
   * is an operator handing out a prize, not a player spending an entry. */
  router.add('POST', `${base}/admin/character-boxes/:id/draw`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'charboxes' })) return;
    const body = bodyObject(ctx.body) as any;
    const box = await getBox(ctx.params.id!);
    if (!box) return error(ctx.res, 404, 'NOT_FOUND', 'این باکس وجود ندارد.');

    let userIds: string[] = [];
    if (body.all === true) userIds = await allUserIds();
    else if (Array.isArray(body.userIds)) userIds = body.userIds.map((u: any) => String(u).trim()).filter(Boolean);
    else if (body.userId) userIds = [String(body.userId).trim()];
    if (!userIds.length) return error(ctx.res, 422, 'NO_TARGET', 'هیچ کاربری برای قرعه‌کشی مشخص نشده است.');

    try { json(ctx.res, 200, await drawForUsers(ctx.params.id!, userIds)); } catch (e) { fail(ctx.res, e); }
  });
}
