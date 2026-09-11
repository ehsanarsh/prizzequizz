/* THE PAYMENT SESSION, AS THE PLAYER EXPERIENCES IT.
 *
 * `amountAllocator` reserves an amount and `sessionStore` keeps the row; this
 * is the part that turns those into something a person can act on — the card
 * to send to, the exact figure to send, how long they have, and what to tell
 * support if it goes wrong.
 *
 * Two decisions here are about honesty rather than mechanism:
 *
 * 1. THE DEADLINE IS SERVER TIME. The page counts down, and a phone whose
 *    clock is wrong would otherwise show a deadline that has nothing to do
 *    with the one being enforced. Every response carries `serverTime`, so the
 *    client measures the offset once and counts from its own monotonic clock.
 *
 * 2. AN EXPIRED SESSION SAYS ITS MONEY IS STILL RECOGNISED. The amount stays
 *    reserved long after the page gives up, so «مهلت تمام شد» must not read as
 *    «پولت گم شد». Whoever transferred a minute late needs to know it will
 *    still be found.
 */
import { formatPan, getCard, type C2cCard } from './cardService.js';
import { allocate, AllocationError } from './amountAllocator.js';
import {
  getSession, liveSessionForIntent, setSessionStatus, type C2cSession
} from './sessionStore.js';
import { formatRialFa, formatTomanFa, rialForClipboard } from '../money.js';
import type { PaymentIntent } from '../../types/domain.js';
import { find as findFulfilment } from '../orderFulfilmentService.js';
import { abandonPaymentIntent } from '../paymentService.js';
import { logger } from '../logger.js';

export class SessionError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'SessionError'; }
}

/** Everything the payment page needs, and nothing it has to work out itself. */
export interface Checkout {
  sessionId: string;
  intentId: string | null;
  status: C2cSession['status'];
  trackingCode: string;
  order: { label: string; qty: number };
  amounts: {
    baseToman: number;
    discountToman: number;
    finalToman: number;
    finalTomanText: string;
    payableRial: number;
    payableRialText: string;
    /** No separators — a banking app's amount box is not for reading. */
    payableRialRaw: string;
  };
  card: { pan: string; panFormatted: string; holderName: string; bankName: string };
  expiresAt: string;
  serverTime: string;
  secondsLeft: number;
  notice: string;
  autoActivate: string;
}

/* Said once, here, so the page and any later message cannot drift apart. */
const NOTICE = 'مبلغ را دقیقاً و بدون تغییر واریز کنید؛ حتی یک ریال اختلاف باعث می‌شود پرداخت شناسایی نشود.';
const AUTO = 'بعد از واریز، خریدت خودکار فعال می‌شود. می‌توانی این صفحه را ببندی.';

function secondsLeft(expiresAt: string): number {
  return Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 1000));
}

function toCheckout(session: C2cSession, card: C2cCard, label: string, qty: number): Checkout {
  return {
    sessionId: session.id,
    intentId: session.intentId,
    status: session.status,
    trackingCode: session.trackingCode,
    order: { label, qty },
    amounts: {
      baseToman: session.baseAmountToman,
      /* PrizzeQuizz has no discount concept yet — `quote()` prices straight
       * from the catalogue. The row exists because the page has a place for it
       * and a missing field is harder to add later than a zero. */
      discountToman: 0,
      finalToman: session.baseAmountToman,
      finalTomanText: formatTomanFa(session.baseAmountToman),
      payableRial: session.amountRial,
      payableRialText: formatRialFa(session.amountRial),
      payableRialRaw: rialForClipboard(session.amountRial)
    },
    card: {
      pan: card.pan,
      panFormatted: formatPan(card.pan),
      holderName: card.holderName,
      bankName: card.bankName || card.bankKey
    },
    expiresAt: session.expiresAt,
    serverTime: new Date().toISOString(),
    secondsLeft: secondsLeft(session.expiresAt),
    notice: NOTICE,
    autoActivate: AUTO
  };
}

/**
 * Open a payment page for an intent that a card-to-card gateway will settle.
 *
 * Throws rather than returning a half-made page: if no amount can be reserved,
 * the player must be told why now — not shown a figure that nothing will ever
 * recognise.
 */
export async function openForIntent(intent: PaymentIntent): Promise<Checkout> {
  const order = (intent.metadata as any)?.order ?? {};
  const label = String((intent.metadata as any)?.orderLabel ?? 'خرید');
  const qty = Math.max(1, Number(order?.qty) || 1);

  /* A retried request is the SAME payment. Allocating again would hand out a
   * second figure for one order and hold two slots in the card's amount space
   * — one of them for an amount nobody is ever going to send. */
  const live = await liveSessionForIntent(intent.id);
  if (live && Date.parse(live.expiresAt) > Date.now()) {
    const card = await getCard(live.cardId);
    if (card) return toCheckout(live, card, label, qty);
    /* The card was deleted under a live session — impossible through the admin
     * API, which refuses exactly this, so it means direct database surgery.
     * Falling through re-allocates onto a card that exists rather than showing
     * a page with no destination on it. */
    logger.error('c2c_session_card_missing', { sessionId: live.id, cardId: live.cardId });
  }

  const { session, card, supersededSessionIds } = await allocate({
    userId: intent.userId,
    baseAmountToman: intent.amount,
    intentId: intent.id
  });
  if (supersededSessionIds.length) {
    logger.info('c2c_sessions_superseded', { userId: intent.userId, count: supersededSessionIds.length });
  }
  logger.info('c2c_checkout_opened', {
    sessionId: session.id, intentId: intent.id, amountRial: session.amountRial, cardId: card.id
  });
  return toCheckout(session, card, label, qty);
}

export interface GrantedRow { key: string; value: number; label: string }

export interface SessionView {
  sessionId: string;
  status: C2cSession['status'];
  trackingCode: string;
  settled: boolean;
  expiresAt: string;
  serverTime: string;
  secondsLeft: number;
  /** Present while the page is still useful; dropped once it is not. */
  checkout?: Checkout;
  /** What the payment actually delivered. `null` until it has. */
  granted: GrantedRow[] | null;
  message: string;
}

/* The delivery record keeps its payload in whichever shape the thing sold uses
 * — a ticket grant is the list itself, a shop bundle wraps it — so the page is
 * not made to know the difference. */
function grantedRows(payload: unknown): GrantedRow[] | null {
  if (Array.isArray(payload)) return payload as GrantedRow[];
  const inner = (payload as { granted?: unknown } | null)?.granted;
  return Array.isArray(inner) ? (inner as GrantedRow[]) : null;
}

/** What a settled session handed over, read from the delivery record itself. */
async function grantedFor(session: C2cSession): Promise<GrantedRow[] | null> {
  if (session.status !== 'PAID' || !session.intentId) return null;
  const record = await findFulfilment('intent:' + session.intentId);
  if (!record || record.status !== 'done') return null;
  return grantedRows(record.payload);
}

/* What the player is told for each state. The expired one is the one that
 * matters: the amount is still reserved for hours, so this must not read as
 * «your money is gone». */
function messageFor(status: C2cSession['status']): string {
  switch (status) {
    case 'AWAITING': return 'منتظر واریز شما هستیم.';
    case 'PAID': return 'پرداختت تأیید شد و خریدت فعال شد. ✅';
    case 'REVIEW': return 'واریزت رسید و در حال بررسی است؛ به‌زودی نتیجه را می‌بینی.';
    case 'CANCELLED': return 'این پرداخت لغو شد.';
    case 'EXPIRED':
    case 'RELEASED':
      return 'مهلت این پرداخت تمام شد. اگر واریز کرده‌ای نگران نباش — تا ۲۴ ساعت شناسایی و فعال می‌شود.';
    default: return '';
  }
}

/**
 * Read a session, applying the deadline as it is read.
 *
 * The sweeper that expires sessions in bulk arrives with the SMS stages; until
 * then — and after, for anything it has not reached yet — a page must not show
 * a countdown that finished five minutes ago as though it were still running.
 * Expiring on read is not a shortcut around the sweeper: both write the same
 * transition, and the amount stays reserved either way.
 */
export async function viewSession(sessionId: string, userId: string): Promise<SessionView> {
  let session = await getSession(sessionId);
  /* A session belonging to someone else is reported as missing, not as
   * forbidden: «this is not yours» still confirms it exists. */
  if (!session || session.userId !== userId) {
    throw new SessionError('C2C_SESSION_NOT_FOUND', 'این پرداخت پیدا نشد.');
  }
  if (session.status === 'AWAITING' && Date.parse(session.expiresAt) <= Date.now()) {
    session = (await setSessionStatus(session.id, 'EXPIRED')) ?? session;
  }

  const view: SessionView = {
    sessionId: session.id,
    status: session.status,
    trackingCode: session.trackingCode,
    settled: session.status === 'PAID',
    expiresAt: session.expiresAt,
    serverTime: new Date().toISOString(),
    secondsLeft: session.status === 'AWAITING' ? secondsLeft(session.expiresAt) : 0,
    granted: await grantedFor(session),
    message: messageFor(session.status)
  };
  if (session.status === 'AWAITING') {
    const card = await getCard(session.cardId);
    if (card) view.checkout = toCheckout(session, card, 'خرید', 1);
  }
  return view;
}

/** «انصراف از این پرداخت». Only the player's own, and only while it is live. */
export async function cancelSession(sessionId: string, userId: string): Promise<SessionView> {
  const session = await getSession(sessionId);
  if (!session || session.userId !== userId) {
    throw new SessionError('C2C_SESSION_NOT_FOUND', 'این پرداخت پیدا نشد.');
  }
  if (session.status === 'PAID') {
    throw new SessionError('C2C_ALREADY_PAID', 'این پرداخت قبلاً تأیید شده است.');
  }
  if (session.status === 'AWAITING') {
    await setSessionStatus(session.id, 'CANCELLED');
    /* The intent dies with the page. Leaving it `pending` would keep the
     * purchase in the payments screen and in the gateway report as money on
     * its way, for an order the player has just walked away from.
     *
     * The AMOUNT is not freed: it stays reserved for the cooling-off window,
     * because somebody who cancels and then transfers anyway — the tap and the
     * transfer are seconds apart — must still be matched, and a freed amount
     * handed straight to the next player would match the wrong person. */
    if (session.intentId) await abandonPaymentIntent(session.intentId, 'cancelled_by_player');
    logger.info('c2c_session_cancelled', { sessionId: session.id, userId });
  }
  return viewSession(sessionId, userId);
}

export { AllocationError };
