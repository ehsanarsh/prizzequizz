import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { betaDiagnostics, betaStatus, createBetaInvite, listBetaInvites, listBetaUsers, redeemBetaInvite, updateBetaInviteStatus } from '../../services/betaService.js';
import type { BetaInviteStatus } from '../../types/domain.js';
import { bodyObject, optionalString, requiredString } from '../../utils/validation.js';

export function registerBetaRoutes(router: Router, base: string): void {
  router.add('GET', `${base}/beta/status`, async (ctx) => json(ctx.res, 200, await betaStatus(ctx.userId ?? 'u1')));
  router.add('POST', `${base}/beta/redeem`, async (ctx) => {
    const body = bodyObject(ctx.body);
    json(ctx.res, 200, await redeemBetaInvite(ctx.userId ?? 'u1', requiredString(body, 'code')));
  });

  router.add('GET', `${base}/admin/beta/diagnostics`, async (ctx) => { if (!requireAdmin(ctx)) return; json(ctx.res, 200, await betaDiagnostics()); });
  router.add('GET', `${base}/admin/beta/invites`, async (ctx) => { if (!requireAdmin(ctx)) return; json(ctx.res, 200, await listBetaInvites(Number(ctx.query.get('limit') ?? 100))); });
  router.add('POST', `${base}/admin/beta/invites`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const body = bodyObject(ctx.body);
    json(ctx.res, 201, await createBetaInvite({ code: optionalString(body, 'code'), maxUses: Number((body as any).maxUses ?? 1), expiresAt: optionalString(body, 'expiresAt'), note: optionalString(body, 'note'), createdBy: ctx.userId ?? 'system' }));
  });
  router.add('PATCH', `${base}/admin/beta/invites/:code/status`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const status = String((ctx.body as any)?.status ?? 'disabled') as BetaInviteStatus;
    if (!['active','disabled','expired'].includes(status)) return error(ctx.res, 422, 'BETA_STATUS_INVALID', 'Invalid beta invite status.');
    const updated = await updateBetaInviteStatus(ctx.params.code!, status);
    if (!updated) return error(ctx.res, 404, 'BETA_INVITE_NOT_FOUND', 'Beta invite not found.');
    json(ctx.res, 200, updated);
  });
  router.add('GET', `${base}/admin/beta/users`, async (ctx) => { if (!requireAdmin(ctx)) return; json(ctx.res, 200, await listBetaUsers(Number(ctx.query.get('limit') ?? 100))); });
}
