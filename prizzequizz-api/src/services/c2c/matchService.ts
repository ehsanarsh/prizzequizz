/* AN SMS ARRIVES. DOES IT PAY FOR ANYTHING?
 *
 * This is the only place in the system that can hand over goods without a
 * person looking, so the interesting part is not what it matches — it is
 * everything it REFUSES to match automatically. Each refusal below is a way
 * this could otherwise give away tickets:
 *
 *   a pattern on trial            the template itself is not yet proven
 *   two candidate sessions        structurally impossible, so it is a bug
 *   a wrong destination account   the money went somewhere else
 *   a cancelled session           the player walked away; a person decides
 *   a released reservation        that amount may belong to someone else now
 *   above the auto-approve ceiling the operator signs for the big ones
 *
 * Everything refused lands in the panel queue, which already knows how to
 * settle by hand. Nothing is ever lost, and nothing is ever guessed.
 */
import { getPaymentSettings } from '../paymentGatewayService.js';
import { findCardByRef, digitsOnly } from './cardService.js';
import { listSessions, RESERVING_STATUSES, type C2cSession } from './sessionStore.js';
import { insertTransaction, type BankTransaction } from './transactionStore.js';
import { insertMessage, updateMessage, type BankSmsMessage } from './messageStore.js';
import { bumpMatched, livePatterns, type BankSmsPattern } from './patternStore.js';
import { matchTemplate, normalizeSms, toRial, MAX_SMS_LENGTH } from './templateCompiler.js';
import { inspectSensitive } from './smsSensitive.js';
import { settle } from './settlementService.js';
import { logger } from '../logger.js';

export interface IngestInput {
  deviceId?: string;
  messageId: string;
  sender?: string;
  body: string;
  receivedAt?: string;
}

export type IngestOutcome =
  | 'sensitive'        // a credential — dropped whole, nothing stored
  | 'duplicate'        // already have this exact message
  | 'parse_failed'     // stored for a person to read; no pattern knew it
  | 'queued'           // parsed into a deposit, waiting for a person
  | 'settled';         // parsed, matched, goods handed over

export interface IngestResult {
  outcome: IngestOutcome;
  /** Absent for a dropped credential — there is deliberately no row. */
  message?: BankSmsMessage;
  transaction?: BankTransaction;
  sessionId?: string;
  /** Why a person still has to look. Persian, for the panel. */
  reason?: string;
}

function parseOccurredAt(input?: string): string {
  /* The DEVICE's receive time, never the date inside the message: Sepah's
   * «2/23-20:43» has no year and Tejarat's «1405/06/19» is a Persian calendar
   * date. Neither can be turned into an instant without guessing, and a
   * guessed timestamp decides whether a late transfer is still in its
   * reservation window. */
  const t = input ? Date.parse(input) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}

/**
 * Take one message all the way: filter, store, parse, match, maybe settle.
 *
 * Callers are the forwarder endpoint and the panel's «paste an SMS» box. Both
 * go through here so there is one path and not two — the panel is how the
 * whole chain is exercised before the forwarder exists.
 */
export async function ingestSms(input: IngestInput): Promise<IngestResult> {
  const normalised = normalizeSms(input.body).slice(0, MAX_SMS_LENGTH);

  /* FIRST, AND BEFORE ANY ROW EXISTS. A رمز پویا that reaches the table is a
   * credential in a database, and nothing done afterwards takes that back.
   * The forwarder filters too; this does not trust it to have. */
  const sensitive = inspectSensitive(normalised);
  if (sensitive.sensitive) {
    logger.warn('bank_sms_dropped_sensitive', { deviceId: input.deviceId ?? 'manual', why: sensitive.why });
    return { outcome: 'sensitive', reason: 'این پیام رمز یا کد یکبارمصرف دارد و ذخیره نشد.' };
  }

  const message = await insertMessage({ ...input, body: normalised });
  if (!message) return { outcome: 'duplicate', reason: 'این پیام قبلاً ثبت شده بود.' };

  for (const { pattern, compiled } of await livePatterns()) {
    /* The operator's own veto, per bank: «برداشت» at a bank whose deposit and
     * withdrawal otherwise look alike. Checked BEFORE the template, so a
     * keyword can protect against a template that is too generous. */
    if (pattern.rejectKeywords.some((k) => k && normalised.includes(normalizeSms(k)))) continue;

    const hit = matchTemplate(compiled, normalised);
    if (!hit) continue;

    let amountRial: number;
    try { amountRial = toRial(hit.amountRaw, pattern.amountUnit); }
    catch {
      /* The template matched but the figure is not a number — a pattern that
       * is subtly wrong. Left for a person rather than guessed at. */
      logger.error('bank_sms_amount_unreadable', { messageId: message.id, patternId: pattern.id, raw: hit.amountRaw });
      await updateMessage(message.id, { status: 'PARSE_FAILED', patternId: pattern.id, note: 'مبلغ خوانده‌شده عدد نبود' });
      return { outcome: 'parse_failed', message, reason: 'مبلغ این پیام خوانده نشد؛ دستی ثبتش کن.' };
    }

    const destRef = hit.values.account ?? '';
    const card = await findCardByRef(destRef);
    const tx = await insertTransaction({
      bankKey: pattern.bankKey,
      amountRial,
      destRef,
      destRefKind: 'account',
      cardId: card?.id ?? null,
      balanceRial: hit.values.balance ? safeRial(hit.values.balance, pattern) : null,
      sourceRef: hit.values.source ?? '',
      reference: hit.values.reference ?? '',
      occurredAt: parseOccurredAt(input.receivedAt),
      enteredBy: input.deviceId ?? 'manual',
      rawText: normalised
    });
    await updateMessage(message.id, { status: 'PARSED', patternId: pattern.id, transactionId: tx.id });
    await bumpMatched(pattern.id);

    const decision = await decide(tx, pattern, card?.id ?? null);
    if (!decision.auto) {
      logger.info('bank_sms_queued', { txId: tx.id, patternId: pattern.id, why: decision.code });
      return { outcome: 'queued', message, transaction: tx, reason: decision.reason };
    }

    try {
      const r = await settle({ txId: tx.id, sessionId: decision.sessionId!, adminId: 'auto' });
      logger.info('bank_sms_settled', { txId: tx.id, sessionId: decision.sessionId, amountRial });
      return { outcome: 'settled', message, transaction: r.transaction, sessionId: decision.sessionId };
    } catch (e) {
      /* Settlement refused at the last moment — a race with an operator, or a
       * guard this function did not know about. The deposit stays in the
       * queue: money that arrived is never dropped because delivery failed. */
      logger.error('bank_sms_settle_failed', { txId: tx.id, message: e instanceof Error ? e.message : 'unknown' });
      return { outcome: 'queued', message, transaction: tx, reason: 'تطبیق خودکار انجام نشد؛ دستی بررسی کن.' };
    }
  }

  await updateMessage(message.id, { status: 'PARSE_FAILED', note: 'هیچ الگویی این پیام را نشناخت' });
  logger.warn('bank_sms_parse_failed', { messageId: message.id, sender: input.sender ?? '' });
  return {
    outcome: 'parse_failed', message,
    reason: 'هیچ الگویی این پیام را نشناخت. اگر واریز است، دستی ثبتش کن و از روی همین متن الگوی بانک را بساز.'
  };
}

/* A balance that cannot be read is not worth failing a deposit over — it is
 * used for reconciliation, never for matching. */
function safeRial(raw: string, pattern: BankSmsPattern): number | null {
  try { return toRial(raw, pattern.amountUnit); } catch { return null; }
}

interface Decision {
  auto: boolean;
  sessionId?: string;
  code: string;
  reason?: string;
}

/**
 * May this deposit settle a payment without a person?
 *
 * Written as a list of refusals on purpose. Reading it top to bottom should
 * make it obvious what has to be true before goods move, and adding a new
 * reason to be careful should mean adding a line here and nothing else.
 */
async function decide(tx: BankTransaction, pattern: BankSmsPattern, cardId: string | null): Promise<Decision> {
  if (pattern.status !== 'live') {
    /* A trial pattern's matches ALL go to a person, however exact they look.
     * The template is what is on trial, and a wrong one that matched perfectly
     * is exactly the dangerous case. */
    return { auto: false, code: 'PATTERN_TRIAL', reason: 'الگوی این بانک هنوز آزمایشی است؛ تأیید با توست.' };
  }

  const settings = await getPaymentSettings();
  const ceiling = Number(settings.c2c.autoApproveMaxRial) || 0;
  if (ceiling > 0 && tx.amountRial > ceiling) {
    return { auto: false, code: 'ABOVE_CEILING', reason: 'مبلغ از سقف تأیید خودکار بیشتر است؛ باید دستی تأیید شود.' };
  }

  if (!cardId) {
    /* We cannot say this landed on one of our cards, so we cannot say the
     * money is ours to spend on somebody's order. */
    return { auto: false, code: 'CARD_UNKNOWN', reason: 'حساب مقصد با هیچ کارتی جور در نیامد.' };
  }

  /* ONLY SESSIONS WHOSE AMOUNT IS STILL HELD.
   *
   * A figure becomes reusable the moment its session leaves the reserving
   * statuses, so history piles up rows sharing it — every settled payment
   * ever made. Searching all of them would make «more than one candidate»
   * the normal answer within a week and auto-matching would quietly stop
   * working. `RESERVING_STATUSES` is also exactly the set the partial unique
   * index covers, which is what makes a single hit per card a guarantee
   * rather than a hope. */
  const exact = (await listSessions({
    amountRial: tx.amountRial, statuses: RESERVING_STATUSES, limit: 20
  })).filter((s) => s.amountRial === tx.amountRial);

  if (!exact.length) {
    /* Nothing is holding this figure. It may still be a payment — a second
     * transfer for an order already delivered — so say which, because «no
     * payment found» sends the operator looking for a bug that is not there. */
    const settled = (await listSessions({ amountRial: tx.amountRial, status: 'PAID', limit: 5 }))
      .filter((s) => s.amountRial === tx.amountRial);
    if (settled.length) {
      return { auto: false, code: 'ALREADY_PAID', reason: 'پرداختِ این مبلغ قبلاً تسویه شده است؛ این واریز تکراری به‌نظر می‌رسد.' };
    }
    return { auto: false, code: 'NO_SESSION', reason: 'هیچ پرداختی با این مبلغ پیدا نشد.' };
  }
  if (exact.length > 1) {
    /* The partial unique index makes this impossible on ONE card. Seeing it
     * means two different cards happened to be handed the same figure — or a
     * bug, and a bug near money is not something to resolve automatically. */
    logger.error('c2c_multiple_candidates', { txId: tx.id, amountRial: tx.amountRial, count: exact.length });
    return { auto: false, code: 'AMBIGUOUS', reason: 'بیش از یک پرداخت با این مبلغ هست؛ باید دستی انتخاب شود.' };
  }

  const session = exact[0]!;
  if (session.cardId !== cardId) {
    return { auto: false, code: 'CARD_MISMATCH', reason: 'این مبلغ به کارت دیگری واریز شده است.' };
  }
  if (session.status === 'CANCELLED') {
    /* Matrix row ۱۴. The player said no and then paid anyway; that is a
     * conversation, not an automatic delivery. */
    return { auto: false, code: 'SESSION_CANCELLED', reason: 'کاربر این پرداخت را لغو کرده بود؛ تصمیم با توست.' };
  }
  if (Date.parse(tx.occurredAt) > Date.parse(session.reservedUntil)) {
    return { auto: false, code: 'AFTER_RESERVATION', reason: 'واریز بعد از پایان دورهٔ رزرو انجام شده است.' };
  }
  /* AWAITING or EXPIRED, on the right card, inside its reservation, exact to
   * the rial, from a proven pattern, under the ceiling. That is the whole set
   * of conditions — matrix row ۱ is the EXPIRED case and it settles. */
  return { auto: true, sessionId: session.id, code: 'MATCHED' };
}

export { digitsOnly };
