import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { createPaymentIntent, getPaymentIntent, listPaymentIntents, paymentDiagnostics, verifyPaymentIntent } from '../../services/paymentService.js';
import type { PaymentIntentStatus, PaymentProvider } from '../../types/domain.js';
import { bodyObject, optionalString, requiredNumber } from '../../utils/validation.js';

export function registerPaymentRoutes(router: Router, base: string): void {
  router.add('POST', `${base}/payments/intents`, async (ctx) => {
    const body = bodyObject(ctx.body);
    const intent = await createPaymentIntent({ userId: ctx.userId ?? 'u1', amount: requiredNumber(body, 'amount'), callbackUrl: optionalString(body, 'callbackUrl'), idempotencyKey: optionalString(body, 'idempotencyKey') });
    json(ctx.res, 201, intent);
  });

  router.add('GET', `${base}/payments/intents/:id`, async (ctx) => {
    const intent = await getPaymentIntent(ctx.params.id!, ctx.userId ?? 'u1');
    if (!intent) return error(ctx.res, 404, 'PAYMENT_INTENT_NOT_FOUND', 'Payment intent not found.');
    json(ctx.res, 200, intent);
  });

  router.add('POST', `${base}/payments/intents/:id/verify`, async (ctx) => {
    const status = ((ctx.body as any)?.status === 'failed' ? 'failed' : 'paid') as 'paid' | 'failed';
    const intent = await verifyPaymentIntent(ctx.params.id!, status);
    if (!intent || intent.userId !== (ctx.userId ?? 'u1')) return error(ctx.res, 404, 'PAYMENT_INTENT_NOT_FOUND', 'Payment intent not found.');
    json(ctx.res, 200, intent);
  });

  router.add('GET', `${base}/payments/sandbox/:id/pay`, async (ctx) => {
    const intent = await verifyPaymentIntent(ctx.params.id!, ctx.query.get('status') === 'failed' ? 'failed' : 'paid');
    if (!intent) return error(ctx.res, 404, 'PAYMENT_INTENT_NOT_FOUND', 'Payment intent not found.');
    json(ctx.res, 200, { paid: intent.status === 'paid', intent });
  });

  router.add('GET', `${base}/admin/payments/diagnostics`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await paymentDiagnostics());
  });

  router.add('GET', `${base}/admin/payments/intents`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await listPaymentIntents({ userId: ctx.query.get('userId') || undefined, status: (ctx.query.get('status') || undefined) as PaymentIntentStatus | undefined, provider: (ctx.query.get('provider') || undefined) as PaymentProvider | undefined, limit: Number(ctx.query.get('limit') ?? 100) }));
  });
}
