/* BLUPAL — a card-to-card payment gateway, spoken over HTTP.
 *
 * The player is given a card number and an amount that is unique to their
 * invoice; they transfer it from their own bank app; BluPal recognises the
 * deposit and tells us. We never see a card, and no money passes through the
 * صندوق جایزه — a gateway payment buys a specific order and nothing else.
 *
 * TWO THINGS IN THIS FILE ARE LOAD-BEARING, AND BOTH ARE ABOUT NOT BEING LIED TO.
 *
 * 1. THE WEBHOOK CARRIES NO SIGNATURE. There is no HMAC, no shared secret, no
 *    token anywhere in BluPal's contract — their own advice is «check the
 *    invoice_id against your database», which only proves WE created that
 *    invoice, not that anybody paid it. Anyone who learns the webhook URL could
 *    POST a «payment.completed» and be handed goods.
 *    So nothing here ever trusts a webhook body. `verifyPaid` asks BluPal, with
 *    our own key, over our own connection. The webhook is a doorbell.
 *
 * 2. BLUPAL COUNTS IN RIAL. PrizzeQuizz counts in toman, everywhere. The
 *    conversion lives in exactly two functions below and nowhere else; a stray
 *    ×10 in a payment path is a ten-fold error in real money.
 */
import { logger } from './logger.js';

const DEFAULT_BASE = 'https://blupal.net/api';

/** Rial per toman. Not a setting — it is the definition of the two units. */
const RIAL_PER_TOMAN = 10;
export function tomanToRial(toman: number): number { return Math.round(Math.max(0, Number(toman) || 0)) * RIAL_PER_TOMAN; }
export function rialToToman(rial: number): number { return Math.round((Math.max(0, Number(rial) || 0)) / RIAL_PER_TOMAN); }

/* BluPal's own limits, in the unit BluPal states them in. Checked before the
 * request so a player gets a sentence instead of a 400 from someone else's
 * server. */
export const MIN_RIAL = 100_000;        // 10,000 toman
export const MAX_RIAL = 500_000_000;    // 50,000,000 toman

export type BlupalStatus = 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELED';
export type BlupalMode = 'sandbox' | 'live';

export interface BlupalInvoice {
  invoiceId: number;
  /** What the order costs, in toman. */
  amountToman: number;
  /** What the player must actually transfer, to the rial — base + a random
   *  three-digit tail that is how BluPal recognises this one payment. */
  finalAmountRial: number;
  status: BlupalStatus;
  paymentLink: string;
  cardNumber: string;
  mode: BlupalMode;
  expiresAt: string | null;
}

export class BlupalError extends Error {
  constructor(public code: string, message: string, public httpStatus = 502) { super(message); }
}

function apiKey(): string { return String(process.env.BLUPAL_API_KEY || '').trim(); }
function baseUrl(): string {
  const raw = String(process.env.BLUPAL_BASE_URL || '').trim() || DEFAULT_BASE;
  return raw.replace(/\/+$/, '');
}
export function blupalConfigured(): boolean { return !!apiKey(); }

/* WHICH WORLD THIS KEY LIVES IN, read off the key itself rather than kept as a
 * separate setting that could disagree with it. A test key can only ever make
 * test invoices, so a system holding a test key must never hand over real
 * goods on a «paid» invoice — and `verifyPaid` refuses any invoice whose mode
 * is not this one. */
export function blupalMode(): BlupalMode { return apiKey().startsWith('blu_live_') ? 'live' : 'sandbox'; }

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (!blupalConfigured()) throw new BlupalError('BLUPAL_NOT_CONFIGURED', 'درگاه پرداخت پیکربندی نشده است.', 503);
  const url = baseUrl() + path;
  /* BluPal's own webhook timeout is ten seconds; ours to them is shorter,
   * because a player is watching a spinner while this runs. */
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', 'X-API-Key': apiKey() },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal
    });
  } catch (e) {
    throw new BlupalError('BLUPAL_UNREACHABLE', 'درگاه پرداخت در دسترس نیست. کمی بعد دوباره تلاش کن.', 502);
  } finally { clearTimeout(timer); }

  const text = await res.text().catch(() => '');
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* handled below */ }

  if (!res.ok || !json || json.success === false) {
    const code = String(json?.error || 'BLUPAL_HTTP_' + res.status);
    /* Their message is already Persian and aimed at a person; pass it through
     * rather than inventing a worse one. */
    const msg = String(json?.message || 'پرداخت انجام نشد.');
    logger.warn('blupal_request_failed', { path, status: res.status, code });
    throw new BlupalError(code, msg, res.status >= 500 ? 502 : 422);
  }
  return json as T;
}

function toInvoice(j: any): BlupalInvoice {
  return {
    invoiceId: Number(j.invoice_id),
    amountToman: rialToToman(Number(j.amount)),
    finalAmountRial: Number(j.final_amount),
    status: String(j.status || 'PENDING').toUpperCase() as BlupalStatus,
    paymentLink: String(j.payment_link || ''),
    cardNumber: String(j.card_number || ''),
    mode: String(j.mode || 'sandbox') === 'live' ? 'live' : 'sandbox',
    expiresAt: j.expires_at ? String(j.expires_at) : null
  };
}

/** Open an invoice for an order priced in TOMAN. */
export async function createInvoice(amountToman: number): Promise<BlupalInvoice> {
  const rial = tomanToRial(amountToman);
  if (rial < MIN_RIAL) {
    throw new BlupalError('amount_too_low',
      'کمترین مبلغ قابل پرداخت از درگاه ' + rialToToman(MIN_RIAL).toLocaleString('fa-IR') + ' تومان است.', 422);
  }
  if (rial > MAX_RIAL) {
    throw new BlupalError('amount_too_high',
      'بیشترین مبلغ قابل پرداخت از درگاه ' + rialToToman(MAX_RIAL).toLocaleString('fa-IR') + ' تومان است.', 422);
  }
  const j = await call<any>('POST', '/v1/invoices/create', { amount: rial });
  const inv = toInvoice(j);
  logger.info('blupal_invoice_created', { invoiceId: inv.invoiceId, amountToman, finalAmountRial: inv.finalAmountRial, mode: inv.mode });
  return inv;
}

/** What BluPal says about an invoice right now. */
export async function getInvoice(invoiceId: number): Promise<BlupalInvoice & { transactionId?: number; payerName?: string; payerCard?: string; payerBank?: string }> {
  const j = await call<any>('GET', '/v1/invoices/' + encodeURIComponent(String(invoiceId)));
  return {
    ...toInvoice(j),
    transactionId: j.transaction_id != null ? Number(j.transaction_id) : undefined,
    payerName: j.payer_name ?? undefined,
    payerCard: j.payer_card ?? undefined,
    payerBank: j.payer_bank_name ?? undefined
  };
}

/* THE ONLY QUESTION THAT MAY UNLOCK GOODS.
 *
 * Given what we recorded when the invoice was opened, ask BluPal — not the
 * caller, not a webhook body — whether it is paid, and refuse anything that
 * does not match on every count that matters:
 *
 *   • the gateway itself says PAID
 *   • the amount owed is the amount we recorded, to the rial. A payment for a
 *     different figure is a different payment, however plausible it looks.
 *   • the invoice belongs to the same world as our key. A sandbox invoice can
 *     be «paid» by anyone with a test key and no money; if that could deliver
 *     goods on a live system, the test environment would be a free shop.
 */
export async function verifyPaid(input: { invoiceId: number; expectedFinalAmountRial: number }): Promise<{
  paid: boolean; reason?: string; invoice?: Awaited<ReturnType<typeof getInvoice>>;
}> {
  const inv = await getInvoice(input.invoiceId);
  if (inv.mode !== blupalMode()) {
    logger.warn('blupal_mode_mismatch', { invoiceId: inv.invoiceId, invoiceMode: inv.mode, ourMode: blupalMode() });
    return { paid: false, reason: 'mode_mismatch', invoice: inv };
  }
  if (inv.status !== 'PAID') return { paid: false, reason: 'status_' + inv.status.toLowerCase(), invoice: inv };
  if (Number(inv.finalAmountRial) !== Number(input.expectedFinalAmountRial)) {
    logger.warn('blupal_amount_mismatch', { invoiceId: inv.invoiceId, got: inv.finalAmountRial, expected: input.expectedFinalAmountRial });
    return { paid: false, reason: 'amount_mismatch', invoice: inv };
  }
  return { paid: true, invoice: inv };
}
