/* CARD-TO-CARD — the payment page, the transaction queue behind it, and the
 * destination cards behind that.
 *
 * The forwarder devices and the bank patterns arrive with the stages that
 * produce them, rather than as empty screens waiting for data that cannot
 * exist yet. Everything the queue needs to work by hand is here, deliberately
 * BEFORE any Android code: the whole money path — session, deposit, match,
 * delivery, accounting — is proven with the operator's own test transfer
 * rather than with a player's money.
 *
 * The policy numbers (deadline, reservation window, suffix mode, per-player
 * cap) are NOT here: they live on the existing payment settings, under the
 * `payments` tab, because that is where an operator already goes to change how
 * money is taken. A second settings screen for five numbers would be a second
 * place to look.
 */
import type { RequestContext, Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { recordAdmin } from '../../services/adminAuditService.js';
import { bodyObject } from '../../utils/validation.js';
import {
  CARD_STATUSES, CardError, findCardByRef, formatPan, getCard, listCards, removeCard, saveCard,
  takenTodayRial, type C2cCard
} from '../../services/c2c/cardService.js';
import { listSessions, type C2cSessionStatus } from '../../services/c2c/sessionStore.js';
import {
  BANK_TX_STATUSES, DEST_REF_KINDS, TransactionError, getTransaction, insertTransaction,
  listTransactions, type BankTxStatus, type BankTransaction, type DestRefKind
} from '../../services/c2c/transactionStore.js';
import {
  SettlementError, candidatesFor, ignoreTransaction, settle
} from '../../services/c2c/settlementService.js';
import { MoneyError, formatRialFa, formatTomanFa, rialToToman, tomanToRial } from '../../services/money.js';
import { repositories } from '../../repositories/index.js';
import {
  AMOUNT_UNITS, PATTERN_STATUSES, PatternError, TRIAL_CONFIRMATIONS, listPatterns, removePattern,
  savePattern, setPatternStatus, type AmountUnit, type PatternStatus
} from '../../services/c2c/patternStore.js';
import { listMessages, type MessageStatus } from '../../services/c2c/messageStore.js';
import { ingestSms } from '../../services/c2c/matchService.js';
import { compileTemplate, FIELD_NAMES, TemplateError } from '../../services/c2c/templateCompiler.js';
import { id as newId } from '../../utils/id.js';
import { c2cAlerts, dailyReport } from '../../services/c2c/reportService.js';
import {
  DeviceError, OFFLINE_AFTER_MS, PAIRING_MAX_ATTEMPTS, createPairingCode, isOffline,
  listDevices, revokeDevice
} from '../../services/c2c/deviceStore.js';
import { SessionError, cancelSession, viewSession } from '../../services/c2c/sessionService.js';

/* The operator's own card number, so it is not a secret from them — but a list
 * on a shared screen is not where it belongs either. The full number rides
 * along for the edit form; the panel shows the masked one until asked. */
async function describe(card: C2cCard): Promise<Record<string, unknown>> {
  const taken = await takenTodayRial(card.id);
  const live = await listSessions({ cardId: card.id, status: 'AWAITING', limit: 500 });
  return {
    ...card,
    panFormatted: formatPan(card.pan),
    panMasked: '**** **** **** ' + card.pan.slice(-4),
    takenTodayRial: taken,
    capLeftRial: card.dailyCapRial > 0 ? Math.max(0, card.dailyCapRial - taken) : null,
    /* How much of this card's amount space is spoken for at any one price.
     * The operator needs to see it CLIMB, not discover it at 100%. */
    openSessions: live.length
  };
}

function requireUser(ctx: RequestContext): string | null {
  if (!ctx.userId) { error(ctx.res, 401, 'UNAUTHORIZED', 'برای این کار باید وارد شوی.'); return null; }
  return ctx.userId;
}

function sessionError(ctx: RequestContext, e: unknown): void {
  if (e instanceof SessionError) {
    /* NOT_FOUND is also the answer for somebody else's session: a 403 would
     * confirm that the id exists, which is the one thing an id-guesser wants. */
    error(ctx.res, e.code === 'C2C_SESSION_NOT_FOUND' ? 404 : 409, e.code, e.message);
    return;
  }
  throw e;
}


/* THE UNIT IS ASKED FOR, NEVER GUESSED.
 *
 * The operator's own banks disagree: Refah's SMS reports rial, others print
 * toman. A default here would be right most of the time and wrong by a factor
 * of ten the rest — and a ten-times error on a deposit is either a player
 * handed ten times the goods or one told their money never arrived.
 */
function amountToRial(raw: unknown, unit: unknown, field: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new TransactionError('AMOUNT_INVALID', `${field} نامعتبر است.`);
  const u = String(unit ?? '');
  if (u !== 'rial' && u !== 'toman') {
    throw new TransactionError('AMOUNT_UNIT_REQUIRED', `واحد ${field} را مشخص کن — ریال یا تومان.`);
  }
  return u === 'rial' ? Math.floor(n) : tomanToRial(n);
}

/* Everything the queue row shows, so the panel never does arithmetic or
 * formatting of its own on money. */
async function describeTx(tx: BankTransaction): Promise<Record<string, unknown>> {
  const card = tx.cardId ? await getCard(tx.cardId) : null;
  /* Through money.ts, so the one place a factor of ten exists stays the one
   * place. It REFUSES a rial figure that is not a whole number of toman —
   * which most payable amounts are not, since they carry a uniqueness suffix —
   * and that refusal is the answer here: there is no round toman figure to
   * show, so none is shown. */
  let amountTomanText = '';
  try { amountTomanText = formatTomanFa(rialToToman(tx.amountRial)); } catch { amountTomanText = ''; }
  return {
    ...tx,
    amountRialText: formatRialFa(tx.amountRial),
    amountTomanText,
    balanceRialText: tx.balanceRial == null ? '' : formatRialFa(tx.balanceRial),
    cardLabel: card ? `${card.bankName || card.bankKey} — ${formatPan(card.pan)}` : ''
  };
}

function settlementError(ctx: RequestContext, e: unknown): void {
  if (e instanceof SettlementError || e instanceof TransactionError) {
    /* 409 across the board: every one of these means «the world is not in the
     * state you were looking at», which is a refresh, not a bad request. */
    error(ctx.res, 409, e.code, e.message);
    return;
  }
  if (e instanceof MoneyError) { error(ctx.res, 422, e.code, e.message); return; }
  /* A template the operator got wrong is a form error, not a conflict: the
   * message says which part, and they fix it and press save again. */
  if (e instanceof PatternError || e instanceof TemplateError) { error(ctx.res, 422, e.code, e.message); return; }
  if (e instanceof DeviceError) { error(ctx.res, 422, e.code, e.message); return; }
  throw e;
}

export function registerC2cRoutes(router: Router, base: string): void {

  /* ---------- The player's own payment page ----------
   * Polled while the page is open, with the backoff the client applies
   * (2s → 5s → 15s). No limiter of its own: the global one already counts per
   * CALLER and per PATH, and this path carries the session id, so a polling
   * page gets its own 120/minute bucket — well clear of that backoff, and
   * still a wall for a client stuck in a tight loop. */
  router.add('GET', `${base}/c2c/sessions/:id`, async (ctx) => {
    const uid = requireUser(ctx); if (!uid) return;
    try {
      json(ctx.res, 200, await viewSession(ctx.params.id!, uid));
    } catch (e) { sessionError(ctx, e); }
  });

  router.add('POST', `${base}/c2c/sessions/:id/cancel`, async (ctx) => {
    const uid = requireUser(ctx); if (!uid) return;
    try {
      json(ctx.res, 200, await cancelSession(ctx.params.id!, uid));
    } catch (e) { sessionError(ctx, e); }
  });


  /* ---------- The transaction queue ----------
   * Deposits the game knows about. Filled by hand here; filled from forwarded
   * bank SMS once the forwarder exists. Same rows, same settlement path. */
  router.add('GET', `${base}/admin/c2c/transactions`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2c' })) return;
    const q = ctx.query;
    const status = q.get('status');
    const rows = await listTransactions({
      status: (BANK_TX_STATUSES as readonly string[]).includes(String(status)) ? (status as BankTxStatus) : undefined,
      from: q.get('from') || undefined,
      to: q.get('to') || undefined,
      amountRial: Number(q.get('amountRial')) || undefined,
      limit: Number(q.get('limit') ?? 100)
    });
    json(ctx.res, 200, {
      rows: await Promise.all(rows.map(describeTx)),
      statuses: BANK_TX_STATUSES,
      destRefKinds: DEST_REF_KINDS
      /* The reconciliation total used to be returned here too. It moved to
       * `/reports/daily`, which computes the same thing and also splits it by
       * day and by whether a person was involved — so keeping a second,
       * thinner copy would be two ways to answer one question, and the day
       * they disagree is the day nobody knows which to believe. */
    });
  });

  /* «ثبت دستی پیامک» — the forwarder is offline, or does not exist yet. */
  router.add('POST', `${base}/admin/c2c/transactions/manual`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2c' })) return;
    const b = bodyObject(ctx.body) as any;
    try {
      const amountRial = amountToRial(b.amount, b.amountUnit, 'مبلغ');
      const balanceRial = b.balance == null || b.balance === ''
        ? null : amountToRial(b.balance, b.balanceUnit ?? b.amountUnit, 'مانده');
      const destRef = String(b.destRef ?? '').trim();
      /* Resolve which of our cards this landed on, so the queue row can say it
       * and the operator is not asked to repeat what the reference already
       * says. An unrecognised reference is not refused — real money arrived,
       * and a row nobody can enter is a row that goes in a notebook instead. */
      const card = b.cardId ? await getCard(String(b.cardId)) : await findCardByRef(destRef);
      const tx = await insertTransaction({
        bankKey: String(b.bankKey ?? card?.bankKey ?? '').trim(),
        amountRial,
        destRef,
        destRefKind: (DEST_REF_KINDS as readonly string[]).includes(String(b.destRefKind))
          ? (b.destRefKind as DestRefKind) : 'account',
        cardId: card?.id ?? null,
        balanceRial,
        sourceRef: String(b.sourceRef ?? '').trim(),
        reference: String(b.reference ?? '').trim(),
        occurredAt: b.occurredAt ? new Date(String(b.occurredAt)).toISOString() : undefined,
        enteredBy: String((ctx as any).adminAccount?.username ?? 'admin'),
        note: String(b.note ?? ''),
        rawText: String(b.rawText ?? '')
      });
      await recordAdmin({
        adminId: (ctx as any).adminAccount?.id, action: 'c2c_transaction_entered',
        meta: { txId: tx.id, amountRial: tx.amountRial, bankKey: tx.bankKey, cardId: tx.cardId }
      });
      json(ctx.res, 201, {
        transaction: await describeTx(tx),
        /* The payments this could be, immediately — the operator entered it to
         * settle it, and making them run a second search is busywork. Offered,
         * never applied: matrix row ۷ says an amount that does not match is
         * never confirmed automatically. */
        candidates: await candidatesFor(tx)
      });
    } catch (e) { settlementError(ctx, e); }
  });

  router.add('GET', `${base}/admin/c2c/transactions/:id/candidates`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2c' })) return;
    const tx = await getTransaction(ctx.params.id!);
    if (!tx) return error(ctx.res, 404, 'BANK_TX_NOT_FOUND', 'این تراکنش پیدا نشد.');
    json(ctx.res, 200, { transaction: await describeTx(tx), candidates: await candidatesFor(tx) });
  });

  /* Assign AND settle: one action, because they are one decision. Splitting
   * them would leave money bound to an order nobody delivered. */
  router.add('POST', `${base}/admin/c2c/transactions/:id/assign`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2c' })) return;
    const b = bodyObject(ctx.body) as any;
    const sessionId = String(b.sessionId ?? '').trim();
    if (!sessionId) return error(ctx.res, 400, 'SESSION_REQUIRED', 'پرداخت مقصد را انتخاب کن.');
    try {
      const r = await settle({
        txId: ctx.params.id!, sessionId,
        adminId: (ctx as any).adminAccount?.id,
        reason: b.reason != null ? String(b.reason) : undefined,
        acceptAmountMismatch: b.acceptAmountMismatch === true
      });
      json(ctx.res, 200, {
        transaction: await describeTx(r.transaction),
        session: r.session, delivered: r.delivered, warnings: r.warnings
      });
    } catch (e) { settlementError(ctx, e); }
  });

  router.add('POST', `${base}/admin/c2c/transactions/:id/ignore`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2c' })) return;
    const b = bodyObject(ctx.body) as any;
    try {
      const tx = await ignoreTransaction(ctx.params.id!, String(b.reason ?? ''), (ctx as any).adminAccount?.id);
      json(ctx.res, 200, await describeTx(tx));
    } catch (e) { settlementError(ctx, e); }
  });

  /* ---------- The payments themselves ----------
   * Who is waiting, and what has been settled. Read-only: a payment changes
   * because a deposit arrived, never because someone edited it here. */
  router.add('GET', `${base}/admin/c2c/sessions`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2c' })) return;
    const q = ctx.query;
    const status = q.get('status') || undefined;
    const rows = await listSessions({
      status: status as C2cSessionStatus | undefined,
      userId: q.get('userId') || undefined,
      amountRial: Number(q.get('amountRial')) || undefined,
      limit: Number(q.get('limit') ?? 100)
    });
    const out = [];
    for (const s of rows) {
      const card = await getCard(s.cardId);
      const user = await repositories.users.findById(s.userId).catch(() => null);
      out.push({
        ...s,
        amountRialText: formatRialFa(s.amountRial),
        baseTomanText: formatTomanFa(s.baseAmountToman),
        cardLabel: card ? `${card.bankName || card.bankKey} — ${formatPan(card.pan)}` : '',
        player: user ? { id: user.id, displayName: (user as any).displayName ?? '', username: (user as any).username ?? '' } : null
      });
    }
    json(ctx.res, 200, { rows: out });
  });


  /* ---------- The bank patterns ----------
   * The operator adds their own banks here. What they type is a TEMPLATE, not
   * a regex — see templateCompiler for why that distinction is the whole
   * safety story. */
  router.add('GET', `${base}/admin/c2c/patterns`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2c' })) return;
    const rows = await listPatterns();
    json(ctx.res, 200, {
      rows: rows.map((p) => ({
        ...p,
        /* The panel needs to SEE which patterns are not yet proven both ways:
         * a missing withdrawal sample is exactly why a bank stays on trial. */
        provenNegative: !!p.sampleWithdrawal,
        readyToPromote: p.status === 'trial' && !!p.sampleWithdrawal && p.matchedCount >= TRIAL_CONFIRMATIONS
      })),
      statuses: PATTERN_STATUSES,
      amountUnits: AMOUNT_UNITS,
      fields: FIELD_NAMES,
      trialConfirmations: TRIAL_CONFIRMATIONS
    });
  });

  /* Compile and run a template WITHOUT saving — the «test before you save»
   * box. Read-only: it never writes a pattern and never settles anything. */
  router.add('POST', `${base}/admin/c2c/patterns/try`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2c' })) return;
    const b = bodyObject(ctx.body) as any;
    try {
      const compiled = compileTemplate(String(b.template ?? ''));
      const { matchTemplate, toRial } = await import('../../services/c2c/templateCompiler.js');
      const unit: AmountUnit = b.amountUnit === 'toman' ? 'toman' : 'rial';
      const read = (sample: unknown) => {
        const hit = matchTemplate(compiled, String(sample ?? ''));
        if (!hit) return { matched: false };
        let amountRial = 0; let rialText = ''; let tomanText = '';
        try {
          amountRial = toRial(hit.amountRaw, unit);
          rialText = formatRialFa(amountRial);
          tomanText = formatTomanFa(rialToToman(amountRial));
        } catch { rialText = '—'; tomanText = '—'; }
        /* BOTH units, always. The operator confirms «۲۵۰٬۰۰۰ ریال ≡ ۲۵٬۰۰۰
         * تومان» is what was really transferred — which is the only check that
         * catches the unit being set the wrong way round. */
        return { matched: true, values: hit.values, amountRial, amountRialText: rialText, amountTomanText: tomanText };
      };
      json(ctx.res, 200, {
        regexSource: compiled.source,
        fields: compiled.fields,
        deposit: read(b.sampleDeposit),
        withdrawal: read(b.sampleWithdrawal)
      });
    } catch (e) { settlementError(ctx, e); }
  });

  router.add('POST', `${base}/admin/c2c/patterns`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2c' })) return;
    const b = bodyObject(ctx.body) as any;
    try {
      const r = await savePattern({
        id: b.id || undefined,
        bankKey: String(b.bankKey ?? ''),
        label: b.label != null ? String(b.label) : undefined,
        senders: Array.isArray(b.senders) ? b.senders.map(String) : undefined,
        template: String(b.template ?? ''),
        amountUnit: b.amountUnit,
        rejectKeywords: Array.isArray(b.rejectKeywords) ? b.rejectKeywords.map(String) : undefined,
        sampleDeposit: String(b.sampleDeposit ?? ''),
        sampleWithdrawal: String(b.sampleWithdrawal ?? ''),
        priority: b.priority != null ? Number(b.priority) : undefined
      });
      await recordAdmin({
        adminId: (ctx as any).adminAccount?.id, action: b.id ? 'c2c_pattern_updated' : 'c2c_pattern_created',
        meta: { patternId: r.pattern.id, bankKey: r.pattern.bankKey, status: r.pattern.status, amountUnit: r.pattern.amountUnit }
      });
      json(ctx.res, b.id ? 200 : 201, r);
    } catch (e) { settlementError(ctx, e); }
  });

  router.add('POST', `${base}/admin/c2c/patterns/:id/status`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2c' })) return;
    const b = bodyObject(ctx.body) as any;
    const status = String(b.status ?? '');
    if (!(PATTERN_STATUSES as readonly string[]).includes(status)) {
      return error(ctx.res, 422, 'PATTERN_STATUS_INVALID', 'وضعیت نامعتبر است.');
    }
    const p = await setPatternStatus(ctx.params.id!, status as PatternStatus);
    if (!p) return error(ctx.res, 404, 'PATTERN_NOT_FOUND', 'الگو پیدا نشد.');
    /* Promoting to live is the moment matches stop needing a person, so it is
     * the one worth finding in the audit a year from now. */
    await recordAdmin({
      adminId: (ctx as any).adminAccount?.id, action: 'c2c_pattern_status',
      meta: { patternId: p.id, bankKey: p.bankKey, status, matchedCount: p.matchedCount, provenNegative: !!p.sampleWithdrawal }
    });
    json(ctx.res, 200, p);
  });

  router.add('DELETE', `${base}/admin/c2c/patterns/:id`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2c' })) return;
    try {
      const removed = await removePattern(ctx.params.id!);
      if (!removed) return error(ctx.res, 404, 'PATTERN_NOT_FOUND', 'الگو پیدا نشد.');
      await recordAdmin({ adminId: (ctx as any).adminAccount?.id, action: 'c2c_pattern_removed', meta: { patternId: ctx.params.id } });
      json(ctx.res, 200, { removed: true });
    } catch (e) { settlementError(ctx, e); }
  });

  /* ---------- Messages ----------
   * Pasting a bank SMS runs the WHOLE chain — filter, parse, match, maybe
   * settle — through exactly the code the forwarder will use. That is how the
   * automatic path is exercised and trusted before any Android code exists. */
  router.add('GET', `${base}/admin/c2c/messages`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2c' })) return;
    const status = ctx.query.get('status') || undefined;
    const rows = await listMessages({
      status: status as MessageStatus | undefined,
      limit: Number(ctx.query.get('limit') ?? 100)
    });
    json(ctx.res, 200, { rows });
  });

  router.add('POST', `${base}/admin/c2c/messages`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2c' })) return;
    const b = bodyObject(ctx.body) as any;
    const body = String(b.body ?? '').trim();
    if (!body) return error(ctx.res, 422, 'BODY_REQUIRED', 'متن پیامک را وارد کن.');
    try {
      const r = await ingestSms({
        /* «manual:…» so a pasted message can never collide with a real
         * device's id space, and so the queue shows where it came from. */
        deviceId: 'manual',
        messageId: String(b.messageId ?? '').trim() || 'manual-' + newId(),
        sender: String(b.sender ?? ''),
        body,
        receivedAt: b.receivedAt ? new Date(String(b.receivedAt)).toISOString() : undefined
      });
      await recordAdmin({
        adminId: (ctx as any).adminAccount?.id, action: 'c2c_sms_pasted',
        meta: { outcome: r.outcome, txId: r.transaction?.id, sessionId: r.sessionId }
      });
      json(ctx.res, 200, {
        outcome: r.outcome,
        reason: r.reason ?? '',
        message: r.message ?? null,
        transaction: r.transaction ? await describeTx(r.transaction) : null,
        sessionId: r.sessionId ?? null,
        candidates: r.transaction && r.outcome === 'queued' ? await candidatesFor(r.transaction) : []
      });
    } catch (e) { settlementError(ctx, e); }
  });


  /* ---------- Forwarder devices ----------
   * A device is anything that can sign — the Android app first, and any
   * other client that speaks the same protocol later. iOS cannot be one
   * directly: it has no SMS-reading API at all, so an iPhone reaches this
   * table only through something else that forwards on its behalf. */
  router.add('GET', `${base}/admin/c2c/devices`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2c' })) return;
    const now = Date.now();
    const devices = await listDevices();
    json(ctx.res, 200, {
      rows: devices.map((d) => ({
        id: d.id, label: d.label, status: d.status, appVersion: d.appVersion,
        lastSeenAt: d.lastSeenAt, lastSmsAt: d.lastSmsAt, queueDepth: d.queueDepth,
        batteryOptimized: d.batteryOptimized, messagesReceived: d.messagesReceived,
        pairedAt: d.pairedAt, revokedAt: d.revokedAt,
        /* Computed here, so «offline» means the same thing on every screen
         * and the panel never has to know the threshold. */
        offline: isOffline(d, now),
        minutesSinceSeen: d.lastSeenAt ? Math.floor((now - Date.parse(d.lastSeenAt)) / 60_000) : null
      })),
      offlineAfterMinutes: Math.round(OFFLINE_AFTER_MS / 60_000),
      /* The operator's phone is their DAILY phone, so Android will sleep the
       * forwarder sooner or later. The panel has to say this out loud rather
       * than let a quiet device look like a quiet day. */
      anyOffline: devices.some((d) => isOffline(d, now)),
      anyBatteryOptimized: devices.some((d) => d.status === 'ACTIVE' && d.batteryOptimized)
    });
  });

  router.add('POST', `${base}/admin/c2c/devices/pairing-code`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2c' })) return;
    const p = await createPairingCode(String((ctx as any).adminAccount?.username ?? 'admin'));
    await recordAdmin({ adminId: (ctx as any).adminAccount?.id, action: 'c2c_pairing_code_created', meta: {} });
    json(ctx.res, 201, {
      code: p.code, expiresAt: p.expiresAt, maxAttempts: PAIRING_MAX_ATTEMPTS,
      note: 'این کد یک‌بار مصرف است و ۱۰ دقیقه اعتبار دارد.'
    });
  });

  router.add('POST', `${base}/admin/c2c/devices/:id/revoke`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2c' })) return;
    const d = await revokeDevice(ctx.params.id!);
    if (!d) return error(ctx.res, 404, 'DEVICE_NOT_FOUND', 'دستگاه پیدا نشد.');
    /* Takes effect on the device's very next request, not on the next deploy
     * — which is the whole point of being able to do it from here. */
    await recordAdmin({ adminId: (ctx as any).adminAccount?.id, action: 'c2c_device_revoked', meta: { deviceId: d.id, label: d.label } });
    json(ctx.res, 200, { revoked: true, id: d.id });
  });


  /* ---------- The morning question ----------
   * «Did the money add up, and is anything broken.» One endpoint, because the
   * operator asks both in the same breath. */
  router.add('GET', `${base}/admin/c2c/reports/daily`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2c' })) return;
    const report = await dailyReport(ctx.query.get('from') || undefined, ctx.query.get('to') || undefined);
    json(ctx.res, 200, {
      ...report,
      /* Derived live from real rows. A quiet system returns an empty array —
       * a panel that invents warnings is a panel whose warnings get ignored. */
      alerts: await c2cAlerts()
    });
  });

  router.add('GET', `${base}/admin/c2c/alerts`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2c' })) return;
    json(ctx.res, 200, { alerts: await c2cAlerts(), at: new Date().toISOString() });
  });

  router.add('GET', `${base}/admin/c2c/cards`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2ccards' })) return;
    const cards = await listCards();
    json(ctx.res, 200, {
      rows: await Promise.all(cards.map(describe)),
      statuses: CARD_STATUSES
    });
  });

  router.add('POST', `${base}/admin/c2c/cards`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2ccards' })) return;
    const b = bodyObject(ctx.body) as any;
    try {
      const card = await saveCard({
        id: b.id || undefined,
        pan: b.pan != null ? String(b.pan) : undefined,
        accountNo: b.accountNo != null ? String(b.accountNo) : undefined,
        bankKey: b.bankKey != null ? String(b.bankKey) : undefined,
        bankName: b.bankName != null ? String(b.bankName) : undefined,
        holderName: b.holderName != null ? String(b.holderName) : undefined,
        status: b.status,
        priority: b.priority != null ? Number(b.priority) : undefined,
        dailyCapRial: b.dailyCapRial != null ? Number(b.dailyCapRial) : undefined,
        minAmountToman: b.minAmountToman != null ? Number(b.minAmountToman) : undefined
      });
      await recordAdmin({ adminId: (ctx as any).adminAccount?.id, action: b.id ? 'c2c_card_updated' : 'c2c_card_created', meta: { cardId: card.id, status: card.status, priority: card.priority } });
      json(ctx.res, b.id ? 200 : 201, await describe(card));
    } catch (e) {
      if (e instanceof CardError) return error(ctx.res, 422, e.code, e.message);
      throw e;
    }
  });

  router.add('DELETE', `${base}/admin/c2c/cards/:id`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2ccards' })) return;
    /* A card with sessions against it is history, not clutter: deleting it
     * would orphan the payments made to it. Turning it off is the way to stop
     * using one. */
    const used = await listSessions({ cardId: ctx.params.id!, limit: 1 });
    if (used.length) {
      return error(ctx.res, 409, 'CARD_IN_USE',
        'این کارت پرداخت ثبت‌شده دارد و حذف نمی‌شود. وضعیتش را «غیرفعال» کن.');
    }
    const removed = await removeCard(ctx.params.id!);
    if (!removed) return error(ctx.res, 404, 'CARD_NOT_FOUND', 'کارت یافت نشد.');
    await recordAdmin({ adminId: (ctx as any).adminAccount?.id, action: 'c2c_card_removed', meta: { cardId: ctx.params.id } });
    json(ctx.res, 200, { removed: true });
  });
}
