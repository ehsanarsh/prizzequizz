/* TURNING A DEPOSIT INTO A DELIVERY.
 *
 * This is where the money becomes goods, so it is the file to be most careful
 * in. Everything upstream is evidence-gathering — the unique amount, the
 * reserved window, the operator reading a bank SMS. By the time anything here
 * runs, the question «did this money arrive for this order» has been answered
 * by a person, and the job is to act on that answer exactly once.
 *
 * Four guards, in the order they matter:
 *
 * 1. ONE DEPOSIT PER ORDER. `bindToSession` is a conditional UPDATE and
 *    `session_id` carries a unique index. Two operators clearing the same
 *    queue cannot both settle one payment, and a bug in this file still
 *    cannot: the database refuses the second row.
 *
 * 2. ONE DELIVERY PER PAYMENT. Delivery goes through the same
 *    `order_fulfilments` claim the gateway uses, keyed `intent:{id}`. A
 *    resumed settlement hands nothing over twice.
 *
 * 3. A MISMATCHED AMOUNT IS NEVER SILENT. The payable figure is the ONLY
 *    thing tying a transfer to an order. Settling a session against a
 *    different amount is a judgement call a person makes, with a reason, and
 *    it is written to the admin audit.
 *
 * 4. NOTHING HERE IS REACHABLE BY A PLAYER. `settleCardToCardIntent` marks an
 *    intent paid with no signature to check, because there is nothing to sign
 *    — the bank does not call us back. Every route into this file is behind
 *    the `c2c` admin tab.
 */
import { RESERVING_STATUSES, getSession, listSessions, setSessionStatus, type C2cSession } from './sessionStore.js';
import {
  bindToSession, getTransaction, setTransactionStatus, TransactionError, type BankTransaction
} from './transactionStore.js';
import { getCard, type C2cCard } from './cardService.js';
import { formatRialFa, formatTomanFa } from '../money.js';
import { getPaymentIntent, settleCardToCardIntent } from '../paymentService.js';
import { recordAdmin } from '../adminAuditService.js';
import { repositories } from '../../repositories/index.js';
import { logger } from '../logger.js';

export class SettlementError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'SettlementError'; }
}

/* How far from the exact figure the panel still bothers to offer a session.
 * 10,000 rial is 1,000 toman — a fat-fingered digit, not a different order. */
export const NEAR_TOLERANCE_RIAL = 10_000;

export interface Candidate {
  session: C2cSession;
  card: C2cCard | null;
  player: { id: string; displayName: string; username: string } | null;
  exact: boolean;
  /** Everything a person should know BEFORE clicking, in Persian. */
  warnings: string[];
  amountRialText: string;
  baseTomanText: string;
}

/* What makes a candidate worth a second look. Not refusals — the operator may
 * well settle every one of these — but things they must not discover after. */
function warningsFor(session: C2cSession, tx: BankTransaction, card: C2cCard | null): string[] {
  const out: string[] = [];
  if (session.status === 'PAID') out.push('این پرداخت قبلاً تسویه شده است.');
  if (session.status === 'CANCELLED') out.push('کاربر این پرداخت را لغو کرده بود، ولی مبلغ هنوز رزرو است.');
  if (session.status === 'EXPIRED') out.push('مهلت این پرداخت تمام شده بود؛ مبلغ هنوز رزرو است.');
  if (session.status === 'RELEASED') out.push('رزرو این مبلغ آزاد شده — ممکن است به کاربر دیگری داده شده باشد.');
  if (session.amountRial !== tx.amountRial) {
    out.push(`مبلغ واریز با مبلغ این پرداخت یکی نیست: ${formatRialFa(tx.amountRial)} در برابر ${formatRialFa(session.amountRial)}.`);
  }
  if (card && tx.cardId && tx.cardId !== card.id) {
    out.push('واریز به کارت دیگری انجام شده است.');
  }
  if (Date.parse(session.reservedUntil) < Date.parse(tx.occurredAt)) {
    out.push('واریز بعد از پایان دورهٔ رزرو این پرداخت انجام شده است.');
  }
  return out;
}

/**
 * The payments this deposit might belong to, best first.
 *
 * Deliberately a LIST and never a decision: matrix row ۸ says two live
 * sessions cannot share an amount on one card, so an exact hit is usually
 * alone — but «usually» is not something to hand goods out on. A person picks.
 */
export async function candidatesFor(tx: BankTransaction): Promise<Candidate[]> {
  const rows = await listSessions({
    amountRial: tx.amountRial, amountToleranceRial: NEAR_TOLERANCE_RIAL, limit: 50
  });
  const out: Candidate[] = [];
  for (const session of rows) {
    const card = await getCard(session.cardId);
    const user = await repositories.users.findById(session.userId).catch(() => null);
    out.push({
      session,
      card,
      player: user ? { id: user.id, displayName: (user as any).displayName ?? '', username: (user as any).username ?? '' } : null,
      exact: session.amountRial === tx.amountRial,
      warnings: warningsFor(session, tx, card),
      amountRialText: formatRialFa(session.amountRial),
      baseTomanText: formatTomanFa(session.baseAmountToman)
    });
  }
  /* Exact before near, then the payment most likely still being waited on. */
  const rank = (c: Candidate) => (c.exact ? 0 : 1) * 10 + (c.session.status === 'AWAITING' ? 0 : c.session.status === 'PAID' ? 5 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || (a.session.createdAt > b.session.createdAt ? -1 : 1));
}

export interface SettleInput {
  txId: string;
  sessionId: string;
  adminId?: string;
  /** Required to settle against a different figure. Written to the audit. */
  reason?: string;
  acceptAmountMismatch?: boolean;
}

export interface SettleResult {
  transaction: BankTransaction;
  session: C2cSession;
  delivered: boolean;
  warnings: string[];
}

/**
 * Settle one deposit against one payment.
 *
 * Idempotent and RESUMABLE: a transaction already bound to this same session —
 * a restart between binding and delivery, matrix row ۶ — is carried the rest
 * of the way instead of refused. Refusing would leave real money bound to an
 * order that was never delivered, with no way through the panel to finish it.
 */
export async function settle(input: SettleInput): Promise<SettleResult> {
  const tx = await getTransaction(input.txId);
  if (!tx) throw new SettlementError('BANK_TX_NOT_FOUND', 'این تراکنش پیدا نشد.');
  if (tx.status === 'IGNORED') throw new SettlementError('BANK_TX_IGNORED', 'این تراکنش رد شده است؛ اول از حالت رد خارجش کن.');
  if (tx.status === 'SETTLED') throw new SettlementError('BANK_TX_SETTLED', 'این تراکنش قبلاً تسویه شده است.');
  if (tx.status === 'ASSIGNED' && tx.sessionId !== input.sessionId) {
    throw new SettlementError('BANK_TX_ASSIGNED_ELSEWHERE', 'این تراکنش به پرداخت دیگری تخصیص داده شده است.');
  }

  const session = await getSession(input.sessionId);
  if (!session) throw new SettlementError('C2C_SESSION_NOT_FOUND', 'این پرداخت پیدا نشد.');
  if (session.status === 'PAID') {
    throw new SettlementError('SESSION_ALREADY_PAID', 'این پرداخت قبلاً تسویه شده است.');
  }

  /* THE AMOUNT IS THE WHOLE IDENTIFIER. Card-to-card carries no message and
   * no order number, so a figure that does not match is not a detail — it is
   * the evidence failing. A person may still decide it is the right payment,
   * but they say so, and they say why. */
  if (session.amountRial !== tx.amountRial) {
    if (!input.acceptAmountMismatch || !String(input.reason ?? '').trim()) {
      throw new SettlementError('AMOUNT_MISMATCH',
        `مبلغ واریز (${formatRialFa(tx.amountRial)}) با مبلغ این پرداخت (${formatRialFa(session.amountRial)}) یکی نیست. برای تسویه باید تأیید کنی و دلیل بنویسی.`);
    }
  }

  const warnings = warningsFor(session, tx, await getCard(session.cardId));

  let bound = tx;
  if (tx.status === 'NEW') {
    const b = await bindToSession(tx.id, session.id);
    if (!b) {
      /* Someone else took it between the read and the write. */
      throw new SettlementError('BANK_TX_RACED', 'وضعیت این تراکنش همین حالا تغییر کرد؛ صف را تازه کن.');
    }
    bound = b;
  }

  /* Deliver BEFORE the session is marked paid. If the process dies between
   * them the session still reads unsettled and this same call finishes the
   * job — whereas a session marked paid with nothing delivered looks finished
   * to every screen that asks. */
  let delivered = false;
  if (session.intentId) {
    const intent = await getPaymentIntent(session.intentId);
    if (!intent) {
      logger.error('c2c_settle_intent_missing', { txId: tx.id, sessionId: session.id, intentId: session.intentId });
      throw new SettlementError('INTENT_NOT_FOUND', 'سفارش مربوط به این پرداخت پیدا نشد.');
    }
    await settleCardToCardIntent(session.intentId);
    delivered = true;
  } else {
    /* A session with no intent cannot deliver anything. Money is still money:
     * it stays bound so it is not counted twice or lost, and the operator is
     * told plainly rather than shown a green tick. */
    logger.error('c2c_settle_without_intent', { txId: tx.id, sessionId: session.id });
    warnings.push('این پرداخت به هیچ سفارشی وصل نیست؛ کالایی تحویل داده نشد.');
  }

  const paidSession = (await setSessionStatus(session.id, 'PAID')) ?? session;
  const settled = (await setTransactionStatus(tx.id, 'SETTLED', input.reason)) ?? bound;

  await recordAdmin({
    adminId: input.adminId,
    action: 'c2c_transaction_settled',
    meta: {
      txId: tx.id, sessionId: session.id, userId: session.userId,
      amountRial: tx.amountRial, sessionAmountRial: session.amountRial,
      amountMismatch: session.amountRial !== tx.amountRial,
      sessionStatusBefore: session.status,
      reason: input.reason ?? '', delivered
    }
  });
  logger.info('c2c_settled', {
    txId: tx.id, sessionId: session.id, userId: session.userId, amountRial: tx.amountRial, delivered
  });

  return { transaction: settled, session: paidSession, delivered, warnings };
}

/**
 * «این واریز به ما ربطی ندارد.» — the operator's salary, a refund, a mistake.
 *
 * The reason is mandatory and audited: a queue is only trustworthy if the
 * things taken out of it can be explained months later. Nothing is deleted.
 */
export async function ignoreTransaction(txId: string, reason: string, adminId?: string): Promise<BankTransaction> {
  const tx = await getTransaction(txId);
  if (!tx) throw new SettlementError('BANK_TX_NOT_FOUND', 'این تراکنش پیدا نشد.');
  if (tx.status === 'SETTLED') throw new SettlementError('BANK_TX_SETTLED', 'تراکنش تسویه‌شده را نمی‌شود رد کرد.');
  if (!String(reason ?? '').trim()) throw new SettlementError('REASON_REQUIRED', 'برای رد کردن باید دلیل بنویسی.');
  const out = (await setTransactionStatus(txId, 'IGNORED', reason)) ?? tx;
  await recordAdmin({ adminId, action: 'c2c_transaction_ignored', meta: { txId, amountRial: tx.amountRial, reason } });
  logger.info('c2c_transaction_ignored', { txId, amountRial: tx.amountRial });
  return out;
}

export { RESERVING_STATUSES, TransactionError };
