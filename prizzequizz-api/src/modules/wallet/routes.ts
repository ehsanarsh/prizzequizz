import type { Router, RequestContext } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { repositories } from '../../repositories/index.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { notifications } from '../../services/notificationService.js';
import { createPaymentIntent, listPaymentIntents } from '../../services/paymentService.js';
import {
  WALLET_LIMITS, WalletError, adminAdjust, auditLog, getAccount, getDashboard, internalTransfer,
  listAudit, listEntries, listWithdraws, postEntry, reportSummary, reportSuspicious, reportTopUsers,
  requestWithdraw, transitionWithdraw, verifyConsistency, withdrawOtpCode
} from '../../services/walletLedgerService.js';
import { TicketError, consumeTicket, purchaseTicket, refundTicket } from '../../services/ticketService.js';
import { GiftError, redeemGiftCode } from '../../services/giftCodeService.js';
import { recordAdmin } from '../../services/adminAuditService.js';
import { id } from '../../utils/id.js';
import { parseOrder, quote, payFromVault, isGatewayPayable, asOrderError } from '../../services/purchaseOrderService.js';
import { payoutOptions, issuedCodeFor, getPartner } from '../../services/payoutPartnerService.js';
import { sendWithdrawOtp, OtpError, otpRequired } from '../../services/withdrawOtpService.js';
import { bodyObject, optionalString, requiredNumber, requiredString } from '../../utils/validation.js';

/* Request metadata for audit + ledger rows (never trusted for money math). */
function reqMeta(ctx: RequestContext): { ip: string; device: string; platform: string } {
  const fwd = String(ctx.req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  return {
    ip: fwd || ctx.req.socket.remoteAddress || 'unknown',
    device: String(ctx.req.headers['user-agent'] ?? 'unknown').slice(0, 160),
    platform: String(ctx.req.headers['x-platform'] ?? 'web').slice(0, 40)
  };
}

function requireUser(ctx: RequestContext): string | null {
  if (!ctx.userId) { error(ctx.res, 401, 'UNAUTHORIZED', 'Login required.'); return null; }
  return ctx.userId;
}

/* Per-user wallet rate limits on top of the global IP limiter. */
const rlBuckets = new Map<string, { count: number; resetAt: number }>();
function userRateLimit(ctx: RequestContext, userId: string, group: string, max: number, windowMs: number): boolean {
  const key = `${userId}:${group}`;
  const now = Date.now();
  const b = rlBuckets.get(key);
  if (!b || b.resetAt < now) { rlBuckets.set(key, { count: 1, resetAt: now + windowMs }); return true; }
  b.count += 1;
  if (b.count > max) { error(ctx.res, 429, 'WALLET_RATE_LIMITED', 'تعداد درخواست‌ها بیش از حد مجاز است؛ کمی بعد دوباره تلاش کن.'); return false; }
  return true;
}

function walletError(ctx: RequestContext, e: unknown): void {
  if (e instanceof WalletError) { error(ctx.res, e.code === 'INSUFFICIENT_FUNDS' ? 402 : 400, e.code, e.message); return; }
  throw e;
}

// Ticket prices come from the live economy config (admin-editable).

export function registerWalletRoutes(router: Router, base: string): void {
  // ---------- Dashboard (balances + totals; backward-compatible fields kept) ----------
  router.add('GET', `${base}/wallet`, async (ctx) => {
    const uid = requireUser(ctx); if (!uid) return;
    const [dash, user, recent] = await Promise.all([getDashboard(uid), repositories.users.findById(uid), listEntries(uid, { page: 1, pageSize: 10, playerVisibleOnly: true })]);
    json(ctx.res, 200, {
      ...dash,
      wallet: (dash as any).available, // legacy field name
      coins: user?.coins ?? 0, hearts: user?.hearts ?? 0, tickets: user?.tickets ?? { bronze: 0, silver: 0, gold: 0 },
      recent: recent.rows
    });
  });

  // ---------- Ledger history: filter / search / sort / pagination ----------
  router.add('GET', `${base}/wallet/transactions`, async (ctx) => {
    const uid = requireUser(ctx); if (!uid) return;
    if (!userRateLimit(ctx, uid, 'read', 120, 60_000)) return;
    const q = ctx.query;
    /* The player's own statement, so the house lines never appear in it — the
     * fee above all. A player is shown the prize they actually receive, not an
     * itemised account of what the game kept. */
    const out = await listEntries(uid, {
      playerVisibleOnly: true,
      type: q.get('type') || undefined, q: q.get('q') || undefined,
      from: q.get('from') || undefined, to: q.get('to') || undefined,
      sort: q.get('sort') === 'asc' ? 'asc' : 'desc',
      page: Number(q.get('page') ?? 1), pageSize: Number(q.get('pageSize') ?? 20)
    });
    json(ctx.res, 200, out);
  });

  /* ---------- Top-up: GONE ----------
   * The صندوق جایزه fills with prizes and nothing else. This endpoint stays
   * only to answer honestly: an old client still calling it must be told the
   * feature was removed rather than get a payment link that credits a balance
   * the game no longer has. */
  router.add('POST', `${base}/wallet/deposits`, async (ctx) => {
    const uid = requireUser(ctx); if (!uid) return;
    error(ctx.res, 410, 'DEPOSIT_REMOVED', 'شارژ حذف شده است. صندوق جایزه فقط با جایزه‌های بردت پر می‌شود.');
  });

  /* ---------- Buying something: price it, then pay for it ----------
   * The player picks the funding in a sheet before anything is charged, so
   * both endpoints take the SAME order and only the method differs. The price
   * is always read from the catalogue here — never taken from the client. */
  router.add('POST', `${base}/orders/quote`, async (ctx) => {
    const uid = requireUser(ctx); if (!uid) return;
    const order = parseOrder(bodyObject(ctx.body).order ?? ctx.body);
    if (!order) return error(ctx.res, 400, 'ORDER_INVALID', 'سفارش نامعتبر است.');
    try {
      const q = await quote(order);
      const acct = await getAccount(uid).catch(() => ({ available: 0 } as any));
      const vault = Number(acct.available) || 0;
      json(ctx.res, 200, {
        order: q.order, amount: q.amount, currency: q.currency, label: q.label,
        vaultBalance: vault,
        /* What the sheet should offer. A coin-priced item has neither. */
        canPayFromVault: q.currency === 'coins' ? true : vault >= q.amount,
        canPayByGateway: isGatewayPayable(q)
      });
    } catch (e) {
      const oe = asOrderError(e);
      if (oe) return error(ctx.res, 400, oe.code, oe.message);
      throw e;
    }
  });

  router.add('POST', `${base}/orders/pay`, async (ctx) => {
    const uid = requireUser(ctx); if (!uid) return;
    if (!userRateLimit(ctx, uid, 'order', 60, 3_600_000)) return;
    const body = bodyObject(ctx.body);
    const order = parseOrder(body.order);
    if (!order) return error(ctx.res, 400, 'ORDER_INVALID', 'سفارش نامعتبر است.');
    const method = String(body.method ?? 'vault') === 'gateway' ? 'gateway' : 'vault';
    const idem = `order:${uid}:${optionalString(body, 'idempotencyKey') ?? id()}`;
    const meta = reqMeta(ctx);
    try {
      if (method === 'gateway') {
        const intent = await createPaymentIntent({ userId: uid, order, callbackUrl: optionalString(body, 'callbackUrl'), idempotencyKey: optionalString(body, 'idempotencyKey') });
        await auditLog({ userId: uid, action: 'order_gateway_started', api: 'POST /orders/pay', ...meta, request: { order }, response: { intentId: intent.id, amount: intent.amount } });
        return json(ctx.res, 201, { method, intentId: intent.id, amount: intent.amount, status: intent.status, paymentUrl: intent.paymentUrl });
      }
      const r = await payFromVault(uid, order, idem);
      await auditLog({ userId: uid, action: 'order_paid_from_vault', api: 'POST /orders/pay', ...meta, request: { order }, response: { amount: r.quote.amount, duplicate: r.duplicate } });
      json(ctx.res, 200, { method, amount: r.quote.amount, label: r.quote.label, granted: r.granted, duplicate: r.duplicate, balance: r.balance });
    } catch (e) {
      await auditLog({ userId: uid, action: 'order_failed', api: 'POST /orders/pay', ...meta, request: { order, method }, error: e instanceof Error ? e.message : 'unknown' });
      const oe = asOrderError(e);
      if (oe) return error(ctx.res, 400, oe.code, oe.message);
      walletError(ctx, e);
    }
  });

  /* ---------- Getting a prize out: the doors that are actually open ----------
   * Only partners with stock appear. Offering one with an empty shelf would be
   * promising something that cannot be handed over. */
  router.add('GET', `${base}/wallet/payout-options`, async (ctx) => {
    const uid = requireUser(ctx); if (!uid) return;
    /* otpRequired lets the client skip the code sheet entirely when the
     * operator has switched it off, instead of showing a step that does nothing. */
    json(ctx.res, 200, { bank: true, partners: await payoutOptions(), otpRequired: await otpRequired() });
  });

  /* The code itself, once the payout has actually been made. A reserved code
   * is never revealed — it is not the player's until the operator pays out. */
  router.add('GET', `${base}/wallet/withdrawals/:id/code`, async (ctx) => {
    const uid = requireUser(ctx); if (!uid) return;
    const c = await issuedCodeFor(ctx.params.id!, uid);
    if (!c) return error(ctx.res, 404, 'CODE_NOT_READY', 'کد هنوز صادر نشده است.');
    const p = await getPartner(c.partnerId);
    json(ctx.res, 200, { code: c.code, amount: c.amount, partner: p?.name ?? '', instructions: p?.instructions ?? '', issuedAt: c.issuedAt });
  });

  // ---------- Withdrawals ----------
  router.add('POST', `${base}/wallet/withdrawals`, async (ctx) => {
    const uid = requireUser(ctx); if (!uid) return;
    if (!userRateLimit(ctx, uid, 'withdraw', 5, 3_600_000)) return;
    const body = bodyObject(ctx.body);
    const meta = reqMeta(ctx);
    const amount = Math.round(requiredNumber(body, 'amount'));
    try {
      /* A partner payout has no bank destination to give, so `destination` is
       * only required for the bank door. */
      const payoutMethod = String(body.payoutMethod ?? 'bank') === 'partner' ? 'partner' as const : 'bank' as const;
      const req = await requestWithdraw({
        userId: uid, amount, payoutMethod, partnerId: optionalString(body, 'partnerId'),
        destination: payoutMethod === 'bank' ? requiredString(body, 'destination') : optionalString(body, 'destination'),
        nationalId: optionalString(body, 'nationalId'), holderName: optionalString(body, 'holderName'),
        otp: optionalString(body, 'otp'), idempotencyKey: optionalString(body, 'idempotencyKey'), ...meta
      });
      await auditLog({ userId: uid, action: 'withdraw_requested', api: 'POST /wallet/withdrawals', ...meta, request: { amount, payoutMethod }, response: { requestId: req.id } });
      await notifications.create({ userId: uid, type: 'wallet_update', title: 'درخواست دریافت جایزه ثبت شد', body: payoutMethod === 'partner' ? `${amount.toLocaleString('fa-IR')} تومان به‌صورت کد ${req.partnerName ?? ''} در صف بررسی است.` : `${amount.toLocaleString('fa-IR')} تومان بلوکه شد و در صف بررسی است.`, data: { requestId: req.id, url: '/wallet' }, push: true });
      json(ctx.res, 201, req);
    } catch (e) {
      await auditLog({ userId: uid, action: 'withdraw_request_failed', api: 'POST /wallet/withdrawals', ...meta, request: { amount }, error: e instanceof Error ? e.message : 'unknown' });
      walletError(ctx, e);
    }
  });

  // Step 1 of a withdrawal: "send" the one-time confirmation code to the user's
  // REGISTERED mobile. For now the code is fixed (1234) and delivered as an
  // in-app notification simulating the SMS; the confirm step still verifies it
  // server-side, so a withdrawal can't be recorded without it.
  router.add('POST', `${base}/wallet/withdrawals/send-otp`, async (ctx) => {
    const uid = requireUser(ctx); if (!uid) return;
    if (!userRateLimit(ctx, uid, 'withdraw_otp', 6, 3_600_000)) return;
    const user = await repositories.users.findById(uid).catch(() => null);
    const phone = user?.phone ? String(user.phone) : '';
    try {
      const r = await sendWithdrawOtp(uid, phone);
      /* Also to the in-app bell, so a player whose SMS is slow still has it. */
      if (r.mode === 'sms') {
        await notifications.create({ userId: uid, type: 'wallet_update', title: 'کد تأیید دریافت جایزه', body: 'کد تأیید برایت پیامک شد.', data: { url: '/wallet' }, push: true }).catch(() => undefined);
      }
      json(ctx.res, 200, { sent: true, phone: r.phoneMasked, mode: r.mode, expiresInSeconds: r.expiresInSeconds, testCode: r.testCode });
    } catch (e) {
      if (e instanceof OtpError) return error(ctx.res, 429, e.code, e.message);
      throw e;
    }
  });

  router.add('GET', `${base}/wallet/withdrawals`, async (ctx) => {
    const uid = requireUser(ctx); if (!uid) return;
    json(ctx.res, 200, await listWithdraws({ userId: uid, status: ctx.query.get('status') || undefined, page: Number(ctx.query.get('page') ?? 1), pageSize: Number(ctx.query.get('pageSize') ?? 20) }));
  });

  // ---------- Ticket purchase: atomic wallet debit + DB ticket grant ----------
  router.add('POST', `${base}/wallet/tickets/purchase`, async (ctx) => {
    const uid = requireUser(ctx); if (!uid) return;
    if (!userRateLimit(ctx, uid, 'ticket', 30, 3_600_000)) return;
    const body = bodyObject(ctx.body);
    const tier = requiredString(body, 'tier');
    const meta = reqMeta(ctx);
    const idem = `ticket:${uid}:${optionalString(body, 'idempotencyKey') ?? id()}`;
    try {
      const r = await purchaseTicket({ userId: uid, tier, idempotencyKey: idem, ...meta });
      if (!r.duplicate) await notifications.create({ userId: uid, type: 'wallet_update', title: 'بلیت خریداری شد', body: `بلیت ${tier} با ${r.price.toLocaleString('fa-IR')} تومان فعال شد.`, data: { tier, url: '/wallet' }, push: true });
      await auditLog({ userId: uid, action: 'ticket_purchased', api: 'POST /wallet/tickets/purchase', ...meta, request: { tier }, response: { price: r.price, duplicate: r.duplicate } });
      json(ctx.res, 200, { tier: r.tier, price: r.price, duplicate: r.duplicate, balance: r.balance, tickets: r.tickets });
    } catch (e) {
      await auditLog({ userId: uid, action: 'ticket_purchase_failed', api: 'POST /wallet/tickets/purchase', ...meta, request: { tier }, error: e instanceof Error ? e.message : 'unknown' });
      if (e instanceof TicketError) return error(ctx.res, 400, e.code, e.message);
      walletError(ctx, e);
    }
  });

  // ---------- Consume a ticket (paid-match entry) — NEVER touches the wallet ----------
  router.add('POST', `${base}/wallet/tickets/consume`, async (ctx) => {
    const uid = requireUser(ctx); if (!uid) return;
    const tier = requiredString(bodyObject(ctx.body), 'tier');
    try {
      const tickets = await consumeTicket(uid, tier);
      await auditLog({ userId: uid, action: 'ticket_consumed', api: 'POST /wallet/tickets/consume', ...reqMeta(ctx), request: { tier } });
      json(ctx.res, 200, { tier, tickets });
    } catch (e) {
      if (e instanceof TicketError) return error(ctx.res, e.code === 'NO_TICKET' ? 402 : 400, e.code, e.message);
      throw e;
    }
  });

  // ---------- Redeem a gift/promo code (once per user) ----------
  router.add('POST', `${base}/gift-codes/redeem`, async (ctx) => {
    const uid = requireUser(ctx); if (!uid) return;
    if (!userRateLimit(ctx, uid, 'gift', 15, 3_600_000)) return;
    try {
      const r = await redeemGiftCode(uid, requiredString(bodyObject(ctx.body), 'code'));
      await notifications.create({ userId: uid, type: 'wallet_update', title: 'کد هدیه اعمال شد 🎁', body: 'جایزهٔ کد هدیه به حسابت اضافه شد.', data: { url: '/wallet' }, push: true });
      json(ctx.res, 200, r);
    } catch (e) {
      if (e instanceof GiftError) return error(ctx.res, 400, e.code, e.message);
      throw e;
    }
  });

  // ---------- Refund a ticket (e.g. no opponent was found) ----------
  router.add('POST', `${base}/wallet/tickets/refund`, async (ctx) => {
    const uid = requireUser(ctx); if (!uid) return;
    const tier = requiredString(bodyObject(ctx.body), 'tier');
    const tickets = await refundTicket(uid, tier);
    await auditLog({ userId: uid, action: 'ticket_refunded', api: 'POST /wallet/tickets/refund', ...reqMeta(ctx), request: { tier } });
    json(ctx.res, 200, { tier, tickets });
  });

  // =====================================================================
  // Admin panel
  // =====================================================================
  router.add('GET', `${base}/admin/wallet/accounts`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const q = (ctx.query.get('q') ?? '').toLowerCase();
    const users = await repositories.users.list(500);
    const rows = [];
    for (const u of users) {
      if (q && !(`${u.username} ${u.displayName} ${u.id} ${u.phone}`.toLowerCase().includes(q))) continue;
      rows.push({ userId: u.id, username: u.username, displayName: u.displayName, status: u.status ?? 'active', account: await getAccount(u.id) });
    }
    json(ctx.res, 200, { rows: rows.slice(0, 100), total: rows.length });
  });

  router.add('GET', `${base}/admin/wallet/users/:id/ledger`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await listEntries(ctx.params.id!, { type: ctx.query.get('type') || undefined, page: Number(ctx.query.get('page') ?? 1), pageSize: Number(ctx.query.get('pageSize') ?? 50) }));
  });

  router.add('GET', `${base}/admin/wallet/withdrawals`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const res = await listWithdraws({ status: ctx.query.get('status') || undefined, userId: ctx.query.get('userId') || undefined, page: Number(ctx.query.get('page') ?? 1), pageSize: Number(ctx.query.get('pageSize') ?? 50) });
    // Enrich each request with the requesting user's identity so the admin can
    // see, per request: which user, their phone, username and wallet — alongside
    // the national id / account-holder name / SHEBA captured at request time.
    const rows = await Promise.all(res.rows.map(async (w) => {
      const u = await repositories.users.findById(w.userId).catch(() => null);
      return { ...w, phone: u?.phone ?? null, username: u?.username ?? null, displayName: u?.displayName ?? null, walletBalance: u?.wallet ?? null };
    }));
    json(ctx.res, 200, { ...res, rows });
  });

  for (const action of ['approve', 'reject', 'paid', 'failed'] as const) {
    router.add('POST', `${base}/admin/wallet/withdrawals/:id/${action}`, async (ctx) => {
      if (!requireAdmin(ctx)) return;
      const body = bodyObject(ctx.body ?? {});
      const meta = reqMeta(ctx);
      try {
        const w = await transitionWithdraw(ctx.params.id!, action, { id: ctx.userId!, reason: optionalString(body, 'reason'), paymentReference: optionalString(body, 'paymentReference') });
        await auditLog({ userId: w.userId, actorId: ctx.userId, action: `withdraw_${action}`, api: `POST /admin/wallet/withdrawals/:id/${action}`, ...meta, request: body, response: { status: w.status } });
        const msg: Record<string, { t: string; b: string }> = {
          approve: { t: 'برداشت تأیید شد', b: `برداشت ${w.amount.toLocaleString('fa-IR')} تومان تأیید شد و در صف پرداخت است.` },
          reject: { t: 'برداشت رد شد', b: `درخواست برداشت رد شد و مبلغ آزاد شد.${w.rejectReason ? ' علت: ' + w.rejectReason : ''}` },
          paid: { t: 'برداشت پرداخت شد', b: `${w.amount.toLocaleString('fa-IR')} تومان به حساب مقصد واریز شد.` },
          failed: { t: 'پرداخت برداشت ناموفق بود', b: 'مبلغ به کیف پول برگشت؛ دوباره تلاش کن یا با پشتیبانی در تماس باش.' }
        };
        await notifications.create({ userId: w.userId, type: 'wallet_update', title: msg[action]!.t, body: msg[action]!.b, data: { requestId: w.id, url: '/wallet' }, push: true });
        json(ctx.res, 200, w);
      } catch (e) { walletError(ctx, e); }
    });
  }

  router.add('POST', `${base}/admin/wallet/adjust`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const body = bodyObject(ctx.body);
    const meta = reqMeta(ctx);
    try {
      const targetId = requiredString(body, 'userId');
      const before = (await getAccount(targetId)).available;
      const result = await adminAdjust({ userId: targetId, amount: requiredNumber(body, 'amount'), reason: requiredString(body, 'reason'), operatorId: ctx.userId! });
      await auditLog({ userId: result.entry.userId, actorId: ctx.userId, action: 'admin_adjust', api: 'POST /admin/wallet/adjust', ...meta, request: body, response: { entryId: result.entry.id, balance: result.account.available } });
      // Durable admin audit with before/after/delta of the wallet balance.
      await recordAdmin({ adminId: ctx.userId, targetUserId: targetId, action: 'wallet_adjust', before, after: result.account.available, reason: String(body.reason ?? ''), meta: { entryId: result.entry.id, amount: result.entry.amount } });
      await notifications.create({ userId: result.entry.userId, type: 'wallet_update', title: 'اصلاح حساب انجام شد', body: `حساب شما توسط پشتیبانی اصلاح شد (${result.entry.kind === 'credit' ? '+' : '-'}${result.entry.amount.toLocaleString('fa-IR')} تومان).`, data: { url: '/wallet' }, push: true });
      json(ctx.res, 200, result);
    } catch (e) { walletError(ctx, e); }
  });

  router.add('POST', `${base}/admin/wallet/transfer`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const body = bodyObject(ctx.body);
    try {
      const result = await internalTransfer({ fromUserId: requiredString(body, 'fromUserId'), toUserId: requiredString(body, 'toUserId'), amount: requiredNumber(body, 'amount'), reason: requiredString(body, 'reason'), operatorId: ctx.userId! });
      await auditLog({ actorId: ctx.userId, action: 'internal_transfer', api: 'POST /admin/wallet/transfer', ...reqMeta(ctx), request: body, response: { outEntry: result.out.entry.id, inEntry: result.in.entry.id } });
      json(ctx.res, 200, { out: result.out.entry, in: result.in.entry });
    } catch (e) { walletError(ctx, e); }
  });

  router.add('GET', `${base}/admin/wallet/reports`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await reportSummary({ granularity: ctx.query.get('granularity') === 'monthly' ? 'monthly' : 'daily', from: ctx.query.get('from') || undefined, to: ctx.query.get('to') || undefined }));
  });

  router.add('GET', `${base}/admin/wallet/reports/top-users`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await reportTopUsers(Number(ctx.query.get('limit') ?? 20)));
  });

  router.add('GET', `${base}/admin/wallet/reports/suspicious`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await reportSuspicious());
  });

  router.add('GET', `${base}/admin/wallet/reports/failed`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const [txns, intents] = await Promise.all([
      repositories.transactions.list({ status: 'failed', limit: 200 }),
      listPaymentIntents({ status: 'failed', limit: 200 })
    ]);
    json(ctx.res, 200, { failedTransactions: txns, failedPayments: intents });
  });

  router.add('GET', `${base}/admin/wallet/audit`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await listAudit({ userId: ctx.query.get('userId') || undefined, action: ctx.query.get('action') || undefined, limit: Number(ctx.query.get('limit') ?? 100) }));
  });

  router.add('GET', `${base}/admin/wallet/consistency`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await verifyConsistency(ctx.query.get('userId') || undefined));
  });
}
