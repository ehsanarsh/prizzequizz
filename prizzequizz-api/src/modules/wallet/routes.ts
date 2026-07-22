import type { Router, RequestContext } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { repositories } from '../../repositories/index.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { notifications } from '../../services/notificationService.js';
import { createPaymentIntent, listPaymentIntents } from '../../services/paymentService.js';
import {
  WALLET_LIMITS, WalletError, adminAdjust, auditLog, getAccount, getDashboard, internalTransfer,
  listAudit, listEntries, listWithdraws, postEntry, reportSummary, reportSuspicious, reportTopUsers,
  requestWithdraw, transitionWithdraw, verifyConsistency
} from '../../services/walletLedgerService.js';
import { TicketError, consumeTicket, purchaseTicket, refundTicket } from '../../services/ticketService.js';
import { id } from '../../utils/id.js';
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
    const [dash, user, recent] = await Promise.all([getDashboard(uid), repositories.users.findById(uid), listEntries(uid, { page: 1, pageSize: 10 })]);
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
    const out = await listEntries(uid, {
      type: q.get('type') || undefined, q: q.get('q') || undefined,
      from: q.get('from') || undefined, to: q.get('to') || undefined,
      sort: q.get('sort') === 'asc' ? 'asc' : 'desc',
      page: Number(q.get('page') ?? 1), pageSize: Number(q.get('pageSize') ?? 20)
    });
    json(ctx.res, 200, out);
  });

  // ---------- Deposit: server-validated payment intent; NO direct crediting ----------
  router.add('POST', `${base}/wallet/deposits`, async (ctx) => {
    const uid = requireUser(ctx); if (!uid) return;
    if (!userRateLimit(ctx, uid, 'deposit', 20, 3_600_000)) return;
    const body = bodyObject(ctx.body);
    const amount = Math.round(requiredNumber(body, 'amount'));
    const meta = reqMeta(ctx);
    try {
      if (amount < WALLET_LIMITS.minDeposit || amount > WALLET_LIMITS.maxDeposit) throw new WalletError('DEPOSIT_AMOUNT_INVALID', `مبلغ شارژ باید بین ${WALLET_LIMITS.minDeposit.toLocaleString('fa-IR')} و ${WALLET_LIMITS.maxDeposit.toLocaleString('fa-IR')} تومان باشد.`);
      const intent = await createPaymentIntent({ userId: uid, amount, idempotencyKey: optionalString(body, 'idempotencyKey') });
      await auditLog({ userId: uid, action: 'deposit_intent_created', api: 'POST /wallet/deposits', ...meta, request: { amount }, response: { intentId: intent.id } });
      json(ctx.res, 201, { intentId: intent.id, amount: intent.amount, status: intent.status, paymentUrl: intent.paymentUrl });
    } catch (e) {
      await auditLog({ userId: uid, action: 'deposit_intent_failed', api: 'POST /wallet/deposits', ...meta, request: { amount }, error: e instanceof Error ? e.message : 'unknown' });
      walletError(ctx, e);
    }
  });

  // ---------- Withdrawals ----------
  router.add('POST', `${base}/wallet/withdrawals`, async (ctx) => {
    const uid = requireUser(ctx); if (!uid) return;
    if (!userRateLimit(ctx, uid, 'withdraw', 5, 3_600_000)) return;
    const body = bodyObject(ctx.body);
    const meta = reqMeta(ctx);
    const amount = Math.round(requiredNumber(body, 'amount'));
    try {
      const req = await requestWithdraw({ userId: uid, amount, destination: requiredString(body, 'destination'), idempotencyKey: optionalString(body, 'idempotencyKey'), ...meta });
      await auditLog({ userId: uid, action: 'withdraw_requested', api: 'POST /wallet/withdrawals', ...meta, request: { amount }, response: { requestId: req.id } });
      await notifications.create({ userId: uid, type: 'wallet_update', title: 'درخواست برداشت ثبت شد', body: `${amount.toLocaleString('fa-IR')} تومان بلوکه شد و در صف بررسی است.`, data: { requestId: req.id, url: '/wallet' }, push: true });
      json(ctx.res, 201, req);
    } catch (e) {
      await auditLog({ userId: uid, action: 'withdraw_request_failed', api: 'POST /wallet/withdrawals', ...meta, request: { amount }, error: e instanceof Error ? e.message : 'unknown' });
      walletError(ctx, e);
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
    json(ctx.res, 200, await listWithdraws({ status: ctx.query.get('status') || undefined, userId: ctx.query.get('userId') || undefined, page: Number(ctx.query.get('page') ?? 1), pageSize: Number(ctx.query.get('pageSize') ?? 50) }));
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
      const result = await adminAdjust({ userId: requiredString(body, 'userId'), amount: requiredNumber(body, 'amount'), reason: requiredString(body, 'reason'), operatorId: ctx.userId! });
      await auditLog({ userId: result.entry.userId, actorId: ctx.userId, action: 'admin_adjust', api: 'POST /admin/wallet/adjust', ...meta, request: body, response: { entryId: result.entry.id, balance: result.account.available } });
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
