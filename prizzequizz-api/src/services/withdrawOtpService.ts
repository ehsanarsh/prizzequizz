/* THE CODE THAT GUARDS A PAYOUT.
 *
 * It was the string "1234". Not per-user, not random, not expiring, and never
 * sent anywhere — the endpoint wrote a push notification and returned, so the
 * player's phone received no SMS at all. Anyone who got hold of a session could
 * type the four digits everybody has and move the money out.
 *
 * A real one: five digits from a cryptographic source, tied to one user, valid
 * for a few minutes, usable once, rate limited, and actually sent by SMS.
 *
 * TEST MODE IS EXPLICIT. When SMS is switched off or in sandbox nothing can be
 * delivered, so the code falls back to the panel's test code — otherwise the
 * game would be untestable and the operator would be tempted to leave real SMS
 * on while developing. The response says which mode it was in, and the panel
 * shows it, so «۱۲۳۴ کار می‌کند» is never a surprise.
 *
 * The operator can switch the requirement off entirely. That is their call to
 * make — some operators verify by other means — but it is off by default only
 * in the sense that it follows the stored setting, which ships as ON.
 */
import { randomInt } from 'node:crypto';
import { getPgPool } from '../database/postgres.js';
import { logger } from './logger.js';
import { getSmsConfig, sendTemplate, smsIsLive } from './smsService.js';

export interface WithdrawOtpSettings {
  /** Off → a payout can be requested without a code at all. */
  required: boolean;
  digits: number;
  ttlSeconds: number;
  /** How long before another code may be asked for. */
  resendSeconds: number;
  maxPerHour: number;
  maxAttempts: number;
}

export const OTP_DEFAULTS: WithdrawOtpSettings = {
  required: true, digits: 5, ttlSeconds: 180, resendSeconds: 60, maxPerHour: 5, maxAttempts: 5
};

export class OtpError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'OtpError'; }
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS withdraw_otp_settings (
    id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  _schemaReady = true;
}

let _memSettings: WithdrawOtpSettings | null = null;

function clean(raw: any): WithdrawOtpSettings {
  const d = { ...OTP_DEFAULTS };
  if (raw && typeof raw === 'object') {
    if (typeof raw.required === 'boolean') d.required = raw.required;
    const n = (v: any, lo: number, hi: number, fb: number) => {
      const x = Math.floor(Number(v));
      return Number.isFinite(x) && x >= lo && x <= hi ? x : fb;
    };
    d.digits = n(raw.digits, 4, 8, d.digits);
    d.ttlSeconds = n(raw.ttlSeconds, 30, 1800, d.ttlSeconds);
    d.resendSeconds = n(raw.resendSeconds, 10, 600, d.resendSeconds);
    d.maxPerHour = n(raw.maxPerHour, 1, 50, d.maxPerHour);
    d.maxAttempts = n(raw.maxAttempts, 1, 20, d.maxAttempts);
  }
  return d;
}

export async function getOtpSettings(): Promise<WithdrawOtpSettings> {
  const pool = pg();
  if (pool) {
    try {
      await ensureSchema(pool);
      const { rows } = await pool.query(`SELECT data FROM withdraw_otp_settings WHERE id='default'`);
      return clean(rows[0]?.data);
    } catch { return { ...OTP_DEFAULTS }; }
  }
  return _memSettings ?? (_memSettings = { ...OTP_DEFAULTS });
}

export async function setOtpSettings(patch: Partial<WithdrawOtpSettings>): Promise<WithdrawOtpSettings> {
  const next = clean({ ...(await getOtpSettings()), ...patch });
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO withdraw_otp_settings(id,data,updated_at) VALUES ('default',$1,now())
       ON CONFLICT (id) DO UPDATE SET data=$1, updated_at=now()`, [JSON.stringify(next)]);
  } else {
    _memSettings = next;
  }
  return next;
}

/* Live codes. In memory on purpose: a code lives for three minutes, and a
 * process restart in that window costs one re-send, which is cheaper than a
 * table of secrets that has to be pruned. */
interface Pending { code: string; expiresAt: number; attempts: number; sentAt: number; }
const pending = new Map<string, Pending>();
const sentTimes = new Map<string, number[]>();

/** Test seam. */
export function _resetOtp(): void { pending.clear(); sentTimes.clear(); _memSettings = null; _schemaReady = false; }

function digitsCode(n: number): string {
  /* randomInt is the crypto source; Math.random would make the code guessable
   * from timing, which for a payout is not an acceptable trade. */
  let out = '';
  for (let i = 0; i < n; i++) out += String(randomInt(0, 10));
  return out;
}

function recordSend(userId: string): void {
  const now = Date.now();
  const list = (sentTimes.get(userId) ?? []).filter((t) => now - t < 3_600_000);
  list.push(now);
  sentTimes.set(userId, list);
}
function sendsThisHour(userId: string): number {
  const now = Date.now();
  return (sentTimes.get(userId) ?? []).filter((t) => now - t < 3_600_000).length;
}
/* A SEND THAT NEVER LEFT DOES NOT COUNT.
 *
 * The code is written down before the SMS is attempted, which is right — the
 * provider can answer slowly and the player may be typing the code from a
 * message that arrived first. But when the send FAILS, that bookkeeping is a
 * trap: «ارسال پیامک ناموفق بود», then a second press answers «۵۹ ثانیه دیگر»
 * for a code nobody ever received, and after a few tries the hour limit closes
 * the door completely. Nobody could withdraw.
 *
 * So a failed send is rolled back: the undelivered code is thrown away and the
 * attempt is uncounted, and the player may try again at once. */
function undoSend(userId: string): void {
  pending.delete(userId);
  const list = sentTimes.get(userId) ?? [];
  list.pop();                       // the one just recorded, and only that one
  if (list.length) sentTimes.set(userId, list); else sentTimes.delete(userId);
}

export interface SendResult {
  sent: boolean;
  /** 'sms' when it really went out; 'test' when SMS is off/sandbox. */
  mode: 'sms' | 'test';
  phoneMasked: string;
  expiresInSeconds: number;
  /** Only in test mode, so a tester is not left guessing. Never in live mode. */
  testCode?: string;
}

function mask(phone: string): string {
  const p = String(phone ?? '');
  return p.length >= 7 ? p.slice(0, 4) + '****' + p.slice(-2) : '';
}

/** Issue a code and send it. Throws if asked too soon or too often. */
export async function sendWithdrawOtp(userId: string, phone: string): Promise<SendResult> {
  const s = await getOtpSettings();
  const now = Date.now();
  const prev = pending.get(userId);
  if (prev && now - prev.sentAt < s.resendSeconds * 1000) {
    const wait = Math.ceil((s.resendSeconds * 1000 - (now - prev.sentAt)) / 1000);
    throw new OtpError('OTP_TOO_SOON', `${wait} ثانیه دیگر می‌توانی کد جدید بخواهی.`);
  }
  if (sendsThisHour(userId) >= s.maxPerHour) {
    throw new OtpError('OTP_RATE_LIMIT', 'تعداد درخواست کد بیش از حد مجاز است. یک ساعت دیگر تلاش کن.');
  }

  const cfg = await getSmsConfig();
  const live = smsIsLive(cfg);
  /* In test mode the code MUST be the panel's test code: a random one nobody
   * can receive would make the flow impossible to walk through. */
  const code = live ? digitsCode(s.digits) : String(cfg.otp?.testCode || '1234');

  pending.set(userId, { code, expiresAt: now + s.ttlSeconds * 1000, attempts: 0, sentAt: now });
  recordSend(userId);

  /* The send is ATTEMPTED whenever SMS is switched on at all, including
   * sandbox. sendSms records every attempt in the panel's log, and an operator
   * testing the flow should be able to see the message there — a sandbox that
   * silently sends nothing leaves them with no way to tell a misconfiguration
   * from a working test. Only the CODE differs between the two modes. */
  if (cfg.enabled) {
    if (!phone) { undoSend(userId); throw new OtpError('NO_PHONE', 'شماره موبایلی برای این حساب ثبت نشده است.'); }
    /* THE PROVIDER REPORTS FAILURE BY STATUS, NOT BY THROWING.
     *
     * sendSms catches its own transport errors and returns a log entry marked
     * 'failed' — so a try/catch alone saw a refused message as a successful
     * one, and the player was handed an OTP screen for a code that had never
     * left the building. Both routes to failure are checked here. */
    let failed = false;
    try {
      const log = await sendTemplate(phone, 'withdraw_code', { code, expiry: Math.round(s.ttlSeconds / 60) });
      failed = !(log.status === 'sent' || log.status === 'disabled');
      if (failed) logger.warn('withdraw_otp_sms_failed', { userId, live, status: log.status, error: log.error });
    } catch (e) {
      failed = true;
      logger.warn('withdraw_otp_sms_failed', { userId, live, message: e instanceof Error ? e.message : 'unknown' });
    }
    /* A real player waiting for a real SMS must be told it failed. In sandbox
     * the code is on screen anyway, so a provider hiccup is not worth blocking
     * the flow the operator is trying to walk through. */
    if (failed && live) {
      undoSend(userId);   // and let them try again now, not in a minute
      throw new OtpError('OTP_SEND_FAILED', 'ارسال پیامک ناموفق بود. دوباره تلاش کن.');
    }
  }
  return {
    sent: true,
    mode: live ? 'sms' : 'test',
    phoneMasked: mask(phone),
    expiresInSeconds: s.ttlSeconds,
    ...(live ? {} : { testCode: code })
  };
}

/** Consume a code. A correct code can be used exactly once. */
export async function verifyWithdrawOtp(userId: string, given: string): Promise<void> {
  const s = await getOtpSettings();
  if (!s.required) return;                       // the operator switched it off

  const p = pending.get(userId);
  if (!p) throw new OtpError('OTP_NOT_REQUESTED', 'اول کد تأیید را درخواست کن.');
  if (Date.now() > p.expiresAt) {
    pending.delete(userId);
    throw new OtpError('OTP_EXPIRED', 'کد منقضی شده است. کد تازه بخواه.');
  }
  p.attempts += 1;
  if (p.attempts > s.maxAttempts) {
    pending.delete(userId);
    throw new OtpError('OTP_TOO_MANY_ATTEMPTS', 'تعداد تلاش‌های نادرست زیاد بود. کد تازه بخواه.');
  }
  const ok = String(given ?? '').trim() === p.code;
  if (!ok) throw new OtpError('WITHDRAW_OTP_INVALID', 'کد تأیید نادرست است.');
  /* Burned on success: a code that keeps working is a code that can be reused
   * by whoever saw it over a shoulder. */
  pending.delete(userId);
}

/** Is a code needed at all right now? The client asks so it can skip the sheet. */
export async function otpRequired(): Promise<boolean> {
  return (await getOtpSettings()).required;
}
