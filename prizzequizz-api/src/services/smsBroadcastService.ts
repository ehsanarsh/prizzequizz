/* TEXTING THE PLAYERS — ALL OF THEM, OR SOME.
 *
 * «از پنل ادمین باید بتونم به تمامی و یا بعضی از کاربران پیامک بدم.»
 *
 * The SMS side could already send to a number and keep lists of numbers typed
 * in by hand. What it could not do was send to PLAYERS — the people in the
 * users table — which is the only audience an operator actually thinks in.
 *
 * The audience is resolved by the same segment engine the notification centre
 * uses, deliberately: one place to describe «everyone above level 5 who has not
 * played for a week», not two that will drift apart.
 *
 * THREE THINGS THIS OWES THAT A PUSH DOES NOT.
 *
 * Every message costs money. A push that reaches nobody wastes nothing; an SMS
 * run that goes out twice is a bill. So:
 *
 *   - it can be PRICED before it is sent, in messages rather than people,
 *     because a long Persian text is several messages to every recipient;
 *   - a repeat of the same run is refused, through the same durable guard the
 *     payment callbacks use — a double-tapped button must not bill twice, and
 *     a restart mid-run must not start it again from the beginning;
 *   - it is CAPPED, and a run over the cap is refused rather than quietly
 *     truncated. Sending to the first two thousand of five thousand people and
 *     reporting success is worse than refusing.
 */
import { resolveSegment, describeSegment, type SegmentSpec } from './notificationSegmentService.js';
import { sendSms, getSmsConfig, listBlacklist } from './smsService.js';
import { claimFulfilment, settleFulfilment, abandonFulfilment } from './fulfilmentGuard.js';
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';
import { logger } from './logger.js';

/** The most one run may text. Beyond this it is refused, not trimmed. */
export const SMS_BROADCAST_MAX = 2000;

export class SmsBroadcastError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'SmsBroadcastError'; }
}

/* HOW MANY MESSAGES ONE TEXT IS.
 * Persian is outside GSM-7, so a Persian text is sent as UCS-2: seventy
 * characters to a message, and only sixty-seven once it has to be split,
 * because each part carries a header saying which part it is. Billing is per
 * part, so «۵۰۰ نفر» and «۵۰۰ پیامک» are not the same number and an operator
 * who is shown the first will be surprised by the bill for the second. */
const GSM7 = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\[~\]|€\\]*$/;
export function smsParts(text: string): number {
  const t = String(text ?? '');
  if (!t) return 0;
  const unicode = !GSM7.test(t);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  return t.length <= single ? 1 : Math.ceil(t.length / multi);
}

export interface SmsBroadcastPlan {
  audience: number;          // people the segment matched
  reachable: number;         // …who have a phone number on file
  noPhone: number;
  blacklisted: number;
  parts: number;             // messages per recipient
  messages: number;          // reachable × parts — what will actually be billed
  overCap: boolean;
  description: string;
  smsEnabled: boolean;
  live: boolean;             // false when the provider is still the sandbox
}

/** Phone numbers for a set of users, without one round trip each. */
async function phonesOf(userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!userIds.length) return out;
  try {
    if (process.env.DATABASE_URL) {
      const pool = getPgPool();
      const { rows } = await pool.query(`SELECT id, phone FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
      for (const r of rows) if (r.phone) out.set(String(r.id), String(r.phone));
      return out;
    }
  } catch (e) {
    logger.warn('sms_phone_lookup_fell_back', { message: e instanceof Error ? e.message : 'unknown' });
  }
  for (const uid of userIds) {
    const u = await repositories.users.findById(uid).catch(() => null);
    if (u?.phone) out.set(uid, String(u.phone));
  }
  return out;
}

/** What this run would cost and reach, WITHOUT sending anything. */
export async function previewSmsBroadcast(spec: SegmentSpec, text: string): Promise<SmsBroadcastPlan> {
  const { userIds, count } = await resolveSegment(spec, SMS_BROADCAST_MAX + 1);
  const phones = await phonesOf(userIds);
  const black = new Set((await listBlacklist().catch(() => [])).map((b) => String(b.number)));
  let blacklisted = 0;
  for (const p of phones.values()) if (black.has(p)) blacklisted++;
  const reachable = phones.size - blacklisted;
  const parts = smsParts(text);
  const cfg = await getSmsConfig().catch(() => ({ enabled: false, sandbox: true, provider: 'sandbox' } as any));
  return {
    audience: count,
    reachable: Math.max(0, reachable),
    noPhone: userIds.length - phones.size,
    blacklisted,
    parts,
    messages: Math.max(0, reachable) * parts,
    overCap: count > SMS_BROADCAST_MAX,
    description: describeSegment(spec),
    smsEnabled: !!cfg.enabled,
    live: !!cfg.enabled && !cfg.sandbox && cfg.provider !== 'sandbox'
  };
}

export interface SmsBroadcastResult {
  sent: number; failed: number; blocked: number; noPhone: number;
  audience: number; messages: number; duplicate: boolean;
}

export async function sendSmsBroadcast(input: { spec: SegmentSpec; text: string; idempotencyKey: string }): Promise<SmsBroadcastResult> {
  const text = String(input.text ?? '').trim();
  if (!text) throw new SmsBroadcastError('TEXT_REQUIRED', 'متن پیامک لازم است.');
  const key = String(input.idempotencyKey ?? '').trim();
  if (!key) throw new SmsBroadcastError('IDEMPOTENCY_REQUIRED', 'کلید یکتا لازم است.');

  const { userIds, count } = await resolveSegment(input.spec, SMS_BROADCAST_MAX + 1);
  if (!userIds.length) throw new SmsBroadcastError('AUDIENCE_EMPTY', 'هیچ کاربری با این شرایط پیدا نشد.');
  /* Refused, not trimmed. Texting the first two thousand of five thousand and
   * reporting success would leave nobody able to say who was missed. */
  if (count > SMS_BROADCAST_MAX) {
    throw new SmsBroadcastError('AUDIENCE_TOO_LARGE',
      `این گروه ${count} نفر است و بیشتر از سقفِ ${SMS_BROADCAST_MAX} نفر در هر ارسال. گروه را کوچک‌تر کن.`);
  }

  /* The same guard the payment callbacks use. A double-tapped button, or a
   * retry after a timeout, must not bill a second time. */
  const ref = 'sms:' + key;
  const claim = await claimFulfilment(ref);
  if (!claim.fresh) {
    const prior = claim.payload as SmsBroadcastResult | null;
    if (prior) return { ...prior, duplicate: true };
    throw new SmsBroadcastError('SEND_IN_FLIGHT', 'همین ارسال همین حالا در جریان است؛ چند لحظه دیگر وضعیتش را ببین.');
  }

  let sent = 0, failed = 0, blocked = 0;
  try {
    const phones = await phonesOf(userIds);
    const noPhone = userIds.length - phones.size;
    for (const phone of phones.values()) {
      try {
        const entry = await sendSms(phone, text, null);
        if (entry.status === 'sent') sent++;
        else if (entry.status === 'blocked' || entry.status === 'disabled') blocked++;
        else failed++;
      } catch (e) {
        failed++;
        logger.warn('sms_broadcast_recipient_failed', { message: e instanceof Error ? e.message : 'unknown' });
      }
    }
    const result: SmsBroadcastResult = {
      sent, failed, blocked, noPhone, audience: count,
      messages: sent * smsParts(text), duplicate: false
    };
    await settleFulfilment(ref, result);
    logger.info('sms_broadcast', { audience: count, sent, failed, blocked, noPhone, parts: smsParts(text) });
    return result;
  } catch (e) {
    /* Only an outright collapse gets here — a per-recipient failure is counted
     * above. The claim is dropped so the operator can retry, and the messages
     * already sent are in the SMS log either way. */
    await abandonFulfilment(ref);
    throw e;
  }
}
