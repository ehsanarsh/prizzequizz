/* Login OTP.
 *
 * This used to mint a code and drop it on the floor — the only note was
 * "Production implementation should send SMS here", so the whole SMS panel was
 * wired up to an OTP that never used it. It now goes through smsService, which
 * means one place owns the provider, the rate limit, the expiry and the log.
 *
 * Two modes, decided by the SMS panel and nothing else:
 *   live   — the panel is enabled, not in sandbox, on a real provider: a random
 *            code is generated and actually sent, and login fails loudly if the
 *            provider rejects it. The code is never returned over the API.
 *   test   — anything else: the fixed code from the panel (default 1234), no
 *            message sent. This is what keeps local development and the test
 *            harnesses working, and it is visible in the panel so nobody has to
 *            guess which mode the site is in.
 */
import { id } from '../utils/id.js';
import { getSmsConfig, sendOtp, smsIsLive } from './smsService.js';

export interface OtpCreateResult {
  requestId: string;
  ttlSeconds: number;
  /** Seconds the caller must wait before asking for another code. */
  resendAfterSeconds: number;
  /** Whether a message really went out, or we are in test mode. */
  delivered: boolean;
  testMode: boolean;
}
/** Thrown for the cases the player should be told about rather than retried. */
export class OtpError extends Error {
  constructor(public code: string, message: string, public status = 429) { super(message); }
}

export interface OtpProvider {
  createOtp(phone: string): Promise<OtpCreateResult>;
  verifyOtp(requestId: string, code: string): Promise<{ phone: string } | null>;
}

interface OtpRecord {
  phone: string;
  code: string;
  expiresAt: number;
  attempts: number;
}

export class MemoryOtpProvider implements OtpProvider {
  private records = new Map<string, OtpRecord>();

  async createOtp(phone: string): Promise<OtpCreateResult> {
    const cfg = await getSmsConfig();
    const live = smsIsLive(cfg);
    const ttlSeconds = Math.max(30, Number(cfg.otp.expirySeconds) || 120);
    const requestId = id();
    const code = live
      ? String(Math.floor(1000 + Math.random() * 9000))
      : (String(cfg.otp.testCode || '').trim() || '1234');

    if (live) {
      const res = await sendOtp(phone, code, 'login', 'login_code');
      if (!res.sent) {
        if (res.reason === 'RATE_LIMIT_HOUR') {
          throw new OtpError('OTP_RATE_LIMIT', `در یک ساعت گذشته ${cfg.otp.maxPerHour} بار کد خواسته‌اید. کمی بعد دوباره تلاش کنید.`);
        }
        if (res.reason === 'TOO_SOON') {
          throw new OtpError('OTP_TOO_SOON', `تا ${cfg.otp.minIntervalSeconds} ثانیه بعد از درخواست قبلی نمی‌توان کد تازه گرفت.`);
        }
        // The provider itself refused — its own message is the useful one.
        throw new OtpError('OTP_SEND_FAILED', res.log?.error || 'ارسال پیامک ناموفق بود. لطفاً دوباره تلاش کنید.', 502);
      }
    }

    this.expireOld();
    this.records.set(requestId, { phone, code, expiresAt: Date.now() + ttlSeconds * 1000, attempts: 0 });
    return {
      requestId,
      ttlSeconds,
      resendAfterSeconds: live ? Math.max(0, Number(cfg.otp.minIntervalSeconds) || 0) : 0,
      delivered: live,
      testMode: !live
    };
  }

  async verifyOtp(requestId: string, code: string): Promise<{ phone: string } | null> {
    const record = this.records.get(requestId);
    if (!record) return null;
    record.attempts += 1;
    if (record.expiresAt < Date.now() || record.attempts > 5) {
      this.records.delete(requestId);
      return null;
    }
    if (record.code !== code) return null;
    this.records.delete(requestId);
    return { phone: record.phone };
  }

  /* Codes are held in memory, so without this a long-running process keeps
   * every request it ever issued. */
  private expireOld(): void {
    const now = Date.now();
    for (const [key, r] of this.records) if (r.expiresAt < now) this.records.delete(key);
  }
}

export const otpProvider = new MemoryOtpProvider();
