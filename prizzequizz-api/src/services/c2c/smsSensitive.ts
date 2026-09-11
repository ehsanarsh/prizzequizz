/* WHAT MUST NEVER BE STORED, FORWARDED, OR LOOKED AT.
 *
 * The forwarder reads the SMS inbox of a phone that also receives one-time
 * passwords — رمز پویا, second passwords, verification codes, CVV2. Those are
 * credentials. They are of no use to this system and every use to whoever
 * gets hold of the database, so the rule is not «redact them», it is: a
 * message that looks like one is DROPPED, body and all, before anything else
 * happens to it.
 *
 * This lives on the SERVER as well as in the forwarder app, deliberately.
 * The app filters first, but the server must not trust it to have done so: a
 * device can be stolen, downgraded, or replaced with something that speaks the
 * same protocol, and «the client already checked» is not a security boundary.
 *
 * The list errs toward dropping. A deposit notification that happens to say
 * «رمز» is a payment the operator can enter by hand; a stored رمز پویا is a
 * credential in a table, and no amount of care afterwards takes it back.
 */

/* Matched after normalisation, so Arabic ي/ك spellings and Persian digits are
 * already folded — a filter that misses «رمز پويا» because of one letter is
 * not a filter. */
export const SENSITIVE_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /رمز/, why: 'password' },
  { re: /پویا/, why: 'dynamic password' },
  { re: /یکبار\s*مصرف/, why: 'one-time' },
  { re: /کد\s*(تایید|تأیید|فعالسازی|فعال\s*سازی|ورود|امنیتی)/, why: 'verification code' },
  { re: /\bOTP\b/i, why: 'otp' },
  { re: /\bCVV2?\b/i, why: 'cvv' },
  { re: /\bPIN\b/i, why: 'pin' },
  { re: /one[-\s]?time/i, why: 'one-time' },
  { re: /verification\s*code/i, why: 'verification code' }
];

export interface SensitiveVerdict { sensitive: boolean; why: string }

/**
 * Does this message look like a credential?
 *
 * Takes ALREADY-NORMALISED text. Callers that pass raw text would be matching
 * against bidi marks and Arabic letter forms, which is how a filter silently
 * stops filtering.
 */
export function inspectSensitive(normalisedBody: string): SensitiveVerdict {
  for (const p of SENSITIVE_PATTERNS) {
    if (p.re.test(normalisedBody)) return { sensitive: true, why: p.why };
  }
  return { sensitive: false, why: '' };
}
