import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { calculateUserRisk, listCurrentUserDevices, observeRequestDevice, updateDeviceBindingStatus } from '../../services/deviceRiskService.js';

export function registerDeviceRoutes(router: Router, base: string): void {
  router.add('GET', `${base}/devices/current`, async (ctx) => {
    const observed = await observeRequestDevice(ctx.req, ctx.userId ?? 'u1');
    json(ctx.res, 200, observed);
  });

  router.add('GET', `${base}/devices`, async (ctx) => {
    json(ctx.res, 200, await listCurrentUserDevices(ctx.userId ?? 'u1'));
  });

  router.add('POST', `${base}/devices/risk/recalculate`, async (ctx) => {
    json(ctx.res, 200, await calculateUserRisk(ctx.userId ?? 'u1'));
  });

  router.add('POST', `${base}/devices/:bindingId/trust`, async (ctx) => {
    const bindings = await listCurrentUserDevices(ctx.userId ?? 'u1');
    const binding = bindings.find((item) => item.id === ctx.params.bindingId);
    if (!binding) return error(ctx.res, 404, 'DEVICE_BINDING_NOT_FOUND', 'Device binding not found.');
    const updated = await updateDeviceBindingStatus(binding.id, 'trusted', ctx.userId ?? 'system');
    json(ctx.res, 200, updated ?? binding);
  });
}
