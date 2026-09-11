/* WHAT HAPPENED, AND WHAT NEEDS SOMEONE.
 *
 * Two different questions, and they belong together because the operator asks
 * them in the same breath every morning:
 *
 *   THE DAILY REPORT answers «did the money add up». Its only real job is to
 *   produce a figure that can be held against the bank's own statement — the
 *   single check that catches a deposit that was never real. Everything else
 *   on it is context for that number.
 *
 *   THE ALERTS answer «is anything broken right now». They are derived from
 *   live rows and never from a fixed list: a quiet system produces an empty
 *   array, which is the correct answer. A panel that invents warnings is a
 *   panel whose warnings get ignored.
 *
 * Both read through the stores rather than raw SQL, so they work on either
 * driver — and so the definition of «settled» lives in one place instead of
 * being restated in a query that drifts.
 */
import { getPaymentSettings } from '../paymentGatewayService.js';
import { listCards } from './cardService.js';
import { listSessions } from './sessionStore.js';
import { listTransactions, type BankTransaction } from './transactionStore.js';
import { listMessages } from './messageStore.js';
import { listDevices, isOffline, OFFLINE_AFTER_MS } from './deviceStore.js';
import { listPatterns, TRIAL_CONFIRMATIONS } from './patternStore.js';
import { formatRialFa } from '../money.js';
import type { AlertLevel, SecurityAlert } from '../securityAlertService.js';

export interface DailyRow {
  /** ISO date, so the panel never parses a locale-formatted string. */
  day: string;
  settledCount: number;
  settledRial: number;
  settledRialText: string;
  /** Settled by the matcher with nobody watching. */
  autoCount: number;
  /** Settled by a person from the queue. */
  manualCount: number;
  ignoredCount: number;
  /** Still sitting in the queue from that day — money nobody has assigned. */
  waitingCount: number;
}

export interface DailyReport {
  from: string;
  to: string;
  days: DailyRow[];
  totals: {
    settledCount: number;
    settledRial: number;
    settledRialText: string;
    autoCount: number;
    manualCount: number;
    /** The number that matters when the forwarder is meant to be working. */
    autoRate: number;
    waitingCount: number;
    /** Minutes from the deposit landing to the goods being handed over. */
    medianMinutesToSettle: number | null;
  };
}

function dayOf(iso: string): string { return iso.slice(0, 10); }

/* Median rather than mean: one deposit that sat over a weekend would drag an
 * average until it said nothing about a normal day. */
function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export async function dailyReport(from?: string, to?: string): Promise<DailyReport> {
  const rows = await listTransactions({ from, to, limit: 500 });
  const byDay = new Map<string, DailyRow>();
  const dayRow = (day: string): DailyRow => {
    let r = byDay.get(day);
    if (!r) {
      r = { day, settledCount: 0, settledRial: 0, settledRialText: '', autoCount: 0, manualCount: 0, ignoredCount: 0, waitingCount: 0 };
      byDay.set(day, r);
    }
    return r;
  };

  const settleMinutes: number[] = [];
  let autoCount = 0, manualCount = 0;

  for (const tx of rows) {
    const r = dayRow(dayOf(tx.occurredAt));
    if (tx.status === 'SETTLED') {
      r.settledCount++;
      r.settledRial += tx.amountRial;
      /* `enteredBy` is the device that reported it — «manual» when a person
       * typed it in, a device id when the forwarder did. That is the only
       * honest way to tell the two apart after the fact. */
      if (tx.enteredBy && tx.enteredBy !== 'manual') { r.autoCount++; autoCount++; }
      else { r.manualCount++; manualCount++; }
      const minutes = Math.round((Date.parse(tx.updatedAt) - Date.parse(tx.occurredAt)) / 60_000);
      if (Number.isFinite(minutes) && minutes >= 0) settleMinutes.push(minutes);
    } else if (tx.status === 'IGNORED') {
      r.ignoredCount++;
    } else {
      r.waitingCount++;
    }
  }

  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  for (const d of days) d.settledRialText = formatRialFa(d.settledRial);

  const settledCount = days.reduce((s, d) => s + d.settledCount, 0);
  const settledRial = days.reduce((s, d) => s + d.settledRial, 0);
  return {
    from: from ?? (days[days.length - 1]?.day ?? dayOf(new Date().toISOString())),
    to: to ?? dayOf(new Date().toISOString()),
    days,
    totals: {
      settledCount, settledRial, settledRialText: formatRialFa(settledRial),
      autoCount, manualCount,
      /* Zero settled means zero rate, not a division by zero dressed up as
       * «۰٪ خودکار» — which would read as a broken forwarder on a quiet day. */
      autoRate: settledCount ? Math.round((autoCount / settledCount) * 100) : 0,
      waitingCount: days.reduce((s, d) => s + d.waitingCount, 0),
      medianMinutesToSettle: median(settleMinutes)
    }
  };
}

/* ---------------------------------------------------------------------------
 * Alerts
 * ------------------------------------------------------------------------- */

function alert(id: string, level: AlertLevel, title: string, detail: string, count: number): SecurityAlert {
  return { id, level, title, detail, count, tab: 'c2c', at: new Date().toISOString() };
}

/**
 * Everything wrong with card-to-card, right now.
 *
 * Ordered by what costs the most if ignored: a player who cannot pay, then
 * money sitting unassigned, then a forwarder that has stopped, then the
 * things that are merely worth knowing.
 */
export async function c2cAlerts(): Promise<SecurityAlert[]> {
  const out: SecurityAlert[] = [];
  const settings = await getPaymentSettings();
  const now = Date.now();

  /* THE DOOR IS SHUT. A live gateway with no card to send money to means
   * every player who picks card-to-card is told it is unavailable. */
  const cards = await listCards();
  const activeCards = cards.filter((c) => c.status === 'ACTIVE');
  if (!activeCards.length) {
    out.push(alert('c2c_no_card', 'critical', 'هیچ کارت مقصد فعالی نیست',
      'تا وقتی یک کارت فعال نباشد، پرداخت کارت‌به‌کارت به هیچ بازیکنی پیشنهاد نمی‌شود.', cards.length));
  }

  /* REAL MONEY NOBODY HAS TOUCHED. A player has paid and is waiting. */
  const waitMinutes = Math.max(1, Number(settings.c2c.unmatchedAlertMinutes) || 30);
  const waiting = (await listTransactions({ status: 'NEW', limit: 200 }))
    .filter((t) => now - Date.parse(t.occurredAt) > waitMinutes * 60_000);
  if (waiting.length) {
    const oldest = Math.round((now - Math.min(...waiting.map((t) => Date.parse(t.occurredAt)))) / 60_000);
    out.push(alert('c2c_deposit_waiting', 'critical', 'واریز بدون تخصیص',
      `${waiting.length} واریز بیشتر از ${waitMinutes} دقیقه در صف مانده (قدیمی‌ترین ${oldest} دقیقه). ` +
      'پشت هرکدام یک بازیکن منتظر است.', waiting.length));
  }

  /* THE PHONE STOPPED. On the operator's daily phone this is expected often
   * enough that silence must never be mistaken for calm. */
  const devices = await listDevices();
  const active = devices.filter((d) => d.status === 'ACTIVE');
  const offline = active.filter((d) => isOffline(d, now));
  if (offline.length) {
    out.push(alert('c2c_forwarder_offline', 'critical', 'فورواردر خبر نمی‌دهد',
      `${offline.length} دستگاه بیشتر از ${Math.round(OFFLINE_AFTER_MS / 60_000)} دقیقه است خبری نداده. ` +
      'تا برنگردد، واریزها فقط با ثبت دستی وارد می‌شوند.', offline.length));
  } else if (!active.length) {
    /* Not an error — the manual path works — but the operator should know
     * that nothing is automatic yet rather than wonder why. */
    out.push(alert('c2c_no_device', 'info', 'هیچ دستگاه فورواردری جفت نشده',
      'تطبیق خودکار کار نمی‌کند؛ واریزها را از «ثبت پیامک» دستی وارد کن.', 0));
  }

  const optimised = active.filter((d) => d.batteryOptimized);
  if (optimised.length) {
    out.push(alert('c2c_battery_optimized', 'warn', 'بهینه‌سازی باتری روشن است',
      `${optimised.length} دستگاه از بهینه‌سازی باتری مستثنا نشده. اندروید سرویس را می‌خواباند و ` +
      'پیامک‌ها ساعت‌ها دیر می‌رسند.', optimised.length));
  }

  /* THE AMOUNT SPACE. Each card has 99 slots per price; when they run out,
   * new payments are refused with «ظرفیت پر است» and the operator has no
   * warning unless it is given here. */
  for (const card of activeCards) {
    const live = await listSessions({ cardId: card.id, status: 'AWAITING', limit: 200 });
    if (live.length >= 70) {
      out.push(alert('c2c_amount_space', 'warn', 'فضای مبلغ یک کارت رو به پر شدن است',
        `${live.length} پرداخت باز روی ${card.bankName || card.bankKey}. از ۹۹ مبلغ ممکن در هر قیمت، ` +
        'جا دارد تمام می‌شود — کارت دیگری اضافه کن.', live.length));
    }
  }

  /* A TRIAL PATTERN THAT HAS EARNED ITS PROMOTION. Left on trial forever,
   * every deposit from that bank needs a person — which is the thing the
   * whole forwarder exists to avoid. */
  const ready = (await listPatterns()).filter(
    (p) => p.status === 'trial' && !!p.sampleWithdrawal && p.matchedCount >= TRIAL_CONFIRMATIONS);
  if (ready.length) {
    out.push(alert('c2c_pattern_ready', 'info', 'الگوی بانک آمادهٔ فعال‌سازی',
      `${ready.map((p) => p.label || p.bankKey).join('، ')} به اندازهٔ کافی درست تطبیق داده. ` +
      'تا وقتی آزمایشی بماند، هر واریزش دستی تأیید می‌شود.', ready.length));
  }

  /* UNPARSED MESSAGES THAT WILL AGE OUT. They are the raw material for the
   * pattern that would have read them, and their text does not live forever. */
  const retention = Math.max(1, Number(settings.c2c.rawTextRetentionDays) || 30);
  const unparsed = (await listMessages({ status: 'PARSE_FAILED', limit: 200 }))
    .filter((m) => m.body);
  if (unparsed.length) {
    out.push(alert('c2c_unparsed', 'warn', 'پیامک‌هایی که هیچ الگویی نشناخت',
      `${unparsed.length} پیامک خوانده نشد. هرکدام یک واریز واقعی است — و متن خامشان بعد از ` +
      `${retention} روز پاک می‌شود، پس الگوی بانکش را از رویشان بساز.`, unparsed.length));
  }

  const order: Record<AlertLevel, number> = { critical: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level] || b.count - a.count);
}

export type { SecurityAlert };
