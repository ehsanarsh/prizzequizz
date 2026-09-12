import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { WalletError } from '../../services/walletLedgerService.js';
import { createPaymentIntent, getPaymentIntent, listPaymentIntents, paymentDiagnostics, settlePaymentIntent, settleBlupalIntent, findIntentByBlupalInvoice, blupalActive } from '../../services/paymentService.js';
import { BlupalError } from '../../services/blupalService.js';
import { listGatewaysMasked, saveGateway, removeGateway, getPaymentSettings, updatePaymentSettings, testConnection, gatewayReports } from '../../services/paymentGatewayService.js';
import type { PaymentIntentStatus, PaymentProvider } from '../../types/domain.js';
import { bodyObject, optionalString, requiredNumber } from '../../utils/validation.js';

export function registerPaymentRoutes(router: Router, base: string): void {
  router.add('POST', `${base}/payments/intents`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'Login required.');
    const body = bodyObject(ctx.body);
    try {
      const intent = await createPaymentIntent({ userId: ctx.userId, amount: requiredNumber(body, 'amount'), callbackUrl: optionalString(body, 'callbackUrl'), idempotencyKey: optionalString(body, 'idempotencyKey') });
      json(ctx.res, 201, intent);
    } catch (e) {
      if (e instanceof WalletError) return error(ctx.res, 400, e.code, e.message);
      throw e;
    }
  });

  router.add('GET', `${base}/payments/intents/:id`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'Login required.');
    const intent = await getPaymentIntent(ctx.params.id!, ctx.userId);
    if (!intent) return error(ctx.res, 404, 'PAYMENT_INTENT_NOT_FOUND', 'Payment intent not found.');
    json(ctx.res, 200, intent);
  });

  /* «Have I been charged yet?» — asked by the player coming back from the
   * payment page, who should not have to sit and wait for a webhook.
   *
   * The client still cannot flip anything: it names an intent it owns, and the
   * server goes and asks the GATEWAY. Nothing in the request decides the
   * answer, which is the hole that once let players credit themselves. */
  router.add('POST', `${base}/payments/intents/:id/verify`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'Login required.');
    const intent = await getPaymentIntent(ctx.params.id!, ctx.userId);
    if (!intent) return error(ctx.res, 404, 'PAYMENT_INTENT_NOT_FOUND', 'Payment intent not found.');
    if ((intent.metadata as any)?.gatewayType !== 'blupal') return json(ctx.res, 200, intent);
    try {
      const r = await settleBlupalIntent(intent.id);
      json(ctx.res, 200, { ...(r.intent ?? intent), paid: r.paid, reason: r.reason });
    } catch (e) {
      /* The gateway being unreachable is not a failed payment. Answering with
       * the intent as it stands lets the player try again in a moment, instead
       * of being told something went wrong with their money. */
      if (e instanceof BlupalError) return json(ctx.res, 200, { ...intent, paid: false, reason: 'gateway_unreachable' });
      throw e;
    }
  });

  /* BLUPAL'S WEBHOOK. Open on purpose: it carries no signature, because BluPal
   * does not send one — there is no secret in their contract to check against.
   *
   * So the body is treated as a nudge and never as evidence. The only thing
   * taken from it is an invoice number, and all that does is say WHICH invoice
   * to go and ask BluPal about, over our own connection with our own key. A
   * stranger posting invoice ids all day can make this endpoint do lookups and
   * nothing else — no id, real or invented, can deliver anything that BluPal
   * does not independently confirm was paid, for the exact amount we recorded.
   *
   * Always answers 200. A webhook that is told «error» is a webhook that will
   * be retried forever, and none of the refusals here are things a retry fixes. */
  router.add('POST', `${base}/payments/blupal/webhook`, async (ctx) => {
    const b = bodyObject(ctx.body) as any;
    const invoiceId = Number(b.invoice_id ?? b.invoiceId ?? 0);
    if (!invoiceId) return json(ctx.res, 200, { ok: true, ignored: 'no_invoice_id' });
    const intent = await findIntentByBlupalInvoice(invoiceId);
    if (!intent) return json(ctx.res, 200, { ok: true, ignored: 'unknown_invoice' });
    try {
      const r = await settleBlupalIntent(intent.id);
      json(ctx.res, 200, { ok: true, paid: r.paid, reason: r.reason });
    } catch (e) {
      /* Their service refusing us is the one case a retry DOES fix, so this is
       * the one case that is allowed to look like a failure to them. */
      if (e instanceof BlupalError) return error(ctx.res, 503, e.code, e.message);
      throw e;
    }
  });

  /* What the client needs to know before it opens the payment sheet: whether a
   * card-to-card gateway is configured at all, and whether it is the real one.
   * The key itself never appears — only which world it belongs to. */
  router.add('GET', `${base}/payments/gateway`, async (ctx) => {
    const a = blupalActive();
    json(ctx.res, 200, { cardToCard: a.configured, mode: a.mode, live: a.mode === 'live' });
  });

  // Gateway-side settlement: requires the HMAC signature the gateway (or the
  // sandbox pay link) carries. This is the ONLY path that credits a deposit.
  router.add('GET', `${base}/payments/sandbox/:id/pay`, async (ctx) => {
    const status = ctx.query.get('status') === 'failed' ? 'failed' : 'paid';
    const sig = ctx.query.get('sig') ?? '';
    try {
      const intent = await settlePaymentIntent(ctx.params.id!, sig, status);
      if (!intent) return error(ctx.res, 404, 'PAYMENT_INTENT_NOT_FOUND', 'Payment intent not found.');
      json(ctx.res, 200, { paid: intent.status === 'paid', intent });
    } catch (e) {
      if (e instanceof WalletError) return error(ctx.res, 403, e.code, e.message);
      throw e;
    }
  });

  // Real-gateway callback endpoint (POST, signed): a production PSP webhook
  // posts {intentId, status, signature}; signature must be the HMAC this server
  // computes with PAYMENT_WEBHOOK_SECRET.
  router.add('POST', `${base}/payments/callback`, async (ctx) => {
    const body = bodyObject(ctx.body);
    const intentId = String((body as any).intentId ?? '');
    const status = (body as any).status === 'failed' ? 'failed' : 'paid';
    const sig = String((body as any).signature ?? '');
    try {
      const intent = await settlePaymentIntent(intentId, sig, status);
      if (!intent) return error(ctx.res, 404, 'PAYMENT_INTENT_NOT_FOUND', 'Payment intent not found.');
      json(ctx.res, 200, { ok: true, status: intent.status });
    } catch (e) {
      if (e instanceof WalletError) return error(ctx.res, 403, e.code, e.message);
      throw e;
    }
  });

  router.add('GET', `${base}/admin/payments/diagnostics`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await paymentDiagnostics());
  });

  router.add('GET', `${base}/admin/payments/intents`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'payments' })) return;
    json(ctx.res, 200, await listPaymentIntents({ userId: ctx.query.get('userId') || undefined, status: (ctx.query.get('status') || undefined) as PaymentIntentStatus | undefined, provider: (ctx.query.get('provider') || undefined) as PaymentProvider | undefined, limit: Number(ctx.query.get('limit') ?? 100) }));
  });

  // ---- Multi-gateway management (tab 'payments') ----
  router.add('GET', `${base}/admin/payments/gateways`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'payments' })) return;
    json(ctx.res, 200, { rows: await listGatewaysMasked() });
  });
  router.add('POST', `${base}/admin/payments/gateways`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'payments' })) return;
    const b = bodyObject(ctx.body) as any;
    if (!b.name || !b.type) return error(ctx.res, 422, 'FIELDS_REQUIRED', 'نام و نوع درگاه لازم است.');
    const input: any = { id: b.id, name: String(b.name), type: String(b.type), merchantId: b.merchantId != null ? String(b.merchantId) : undefined, callbackUrl: b.callbackUrl != null ? String(b.callbackUrl) : undefined, enabled: b.enabled != null ? !!b.enabled : undefined, sandbox: b.sandbox != null ? !!b.sandbox : undefined, priority: b.priority != null ? Number(b.priority) : undefined };
    // Only overwrite secrets when a fresh (non-masked) value is provided.
    if (b.apiKey && !String(b.apiKey).startsWith('••••')) input.apiKey = String(b.apiKey);
    if (b.secret && !String(b.secret).startsWith('••••')) input.secret = String(b.secret);
    json(ctx.res, b.id ? 200 : 201, await saveGateway(input));
  });
  router.add('DELETE', `${base}/admin/payments/gateways/:id`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'payments' })) return;
    const ok = await removeGateway(ctx.params.id!);
    if (!ok) return error(ctx.res, 404, 'GATEWAY_NOT_FOUND', 'درگاه یافت نشد.');
    json(ctx.res, 200, { removed: true });
  });
  router.add('POST', `${base}/admin/payments/gateways/:id/test`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'payments' })) return;
    json(ctx.res, 200, await testConnection(ctx.params.id!));
  });
  router.add('GET', `${base}/admin/payments/settings`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'payments' })) return;
    json(ctx.res, 200, await getPaymentSettings());
  });
  router.add('PUT', `${base}/admin/payments/settings`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'payments' })) return;
    json(ctx.res, 200, await updatePaymentSettings(bodyObject(ctx.body) as any));
  });
  router.add('GET', `${base}/admin/payments/reports`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'payments' })) return;
    json(ctx.res, 200, { rows: await gatewayReports() });
  });
}
