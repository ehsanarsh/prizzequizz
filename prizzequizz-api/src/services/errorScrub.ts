/* WHAT A CRASH REPORT MUST NOT CARRY WITH IT.
 *
 * A stack trace is written for a machine and read by people, and on the way it
 * picks up whatever was in scope: the phone number in the URL that failed, the
 * SMS code in a query string, the session token in a header, a card number
 * somebody typed into the wrong box. This is a real-money game, and the screen
 * these end up on is opened by several employees.
 *
 * So the scrub runs on the SERVER, at the moment of writing — not only in the
 * client. Three reasons, and each one alone is enough:
 *   — an old build of the game, already on somebody's phone, has no scrubber;
 *   — the endpoint is public, so anything at all can post to it;
 *   — data that is stored once is stored for good, and «we will clean it up
 *     later» is not a thing that happens to a table nobody looks at.
 *
 * It is deliberately blunt. Losing the last digits of an id from a message is
 * cheap; keeping a player's phone number in a table five people can read is
 * not. What remains is always enough to tell two different crashes apart.
 */

/* Iranian mobile numbers in every shape the app actually produces: 09…, +989…,
   989…, and the Persian/Arabic digit forms, because the client hands those
   straight to the API when a player types with a Persian keyboard. */
const FA_DIGITS = /[۰-۹٠-٩]/g;
const FA_MAP: Record<string, string> = { '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9', '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };

export const SCRUB_PHONE = '[شماره]';
export const SCRUB_CODE = '[کد]';
export const SCRUB_TOKEN = '[توکن]';
export const SCRUB_CARD = '[کارت]';
export const SCRUB_EMAIL = '[ایمیل]';

/** Normalise Persian/Arabic digits so one pattern catches both spellings. */
export function latinDigits(s: string): string {
  return String(s ?? '').replace(FA_DIGITS, (d) => FA_MAP[d] ?? d);
}

/* Order matters: the longest and most specific first, or a card number gets
   half-eaten by the phone rule and stops being recognisable as either. */
export function scrubText(input: unknown, limit = 8000): string {
  let s = latinDigits(String(input ?? ''));
  if (!s) return '';

  /* A bank card, 16 digits, however it was spaced or dashed. Before phones,
     because 16 digits contains an 11-digit run. */
  s = s.replace(/\b(?:\d[ -]?){15}\d\b/g, SCRUB_CARD);
  /* Phone numbers. */
  s = s.replace(/(?:\+?98|0)9\d{9}\b/g, SCRUB_PHONE);
  /* Anything named like a secret, whatever its value: token=…, otp=…, code=…,
     password=…, apiKey: "…", Authorization: Bearer … */
  s = s.replace(/\b(authorization|bearer)\b\s*[:=]?\s*(?:bearer\s+)?\S+/gi, (_m, k) => `${k} ${SCRUB_TOKEN}`);
  /* THE QUOTE AFTER THE KEY. A stack trace carries JSON far more often than it
     carries `key=value`, and in JSON the separator is `":` — the key's own
     closing quote sits between the name and the colon. Without `"?` here,
     {"password":"hunter2"} sailed through untouched, which is the single most
     likely shape for a secret to arrive in. */
  s = s.replace(/\b(token|access_?token|refresh_?token|api_?key|apikey|secret|password|pass|pwd|x-admin-key|adminkey)\b"?\s*[:=]\s*"?[^"&\s,}]+/gi,
    (_m, k) => `${k}=${SCRUB_TOKEN}`);
  s = s.replace(/\b(otp|code|verification_?code|smscode)\b"?\s*[:=]\s*"?\d{3,8}/gi, (_m, k) => `${k}=${SCRUB_CODE}`);
  /* The app's own token shapes, wherever they appear with no label at all. */
  s = s.replace(/\bat_[a-f0-9]{32,}\b/gi, SCRUB_TOKEN);
  s = s.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, SCRUB_TOKEN);
  /* Email addresses. */
  s = s.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, SCRUB_EMAIL);

  return s.slice(0, limit);
}

/* A URL keeps its PATH — that is which screen broke, and it is the single most
   useful field on the whole record — and loses every query value. A query
   string is where the app puts the things it was asked not to keep. */
export function scrubRoute(input: unknown): string {
  const raw = scrubText(input, 1000);
  const q = raw.indexOf('?');
  if (q < 0) return raw;
  const path = raw.slice(0, q);
  const keys = raw.slice(q + 1).split('&').map((kv) => kv.split('=')[0]).filter(Boolean);
  return keys.length ? `${path}?${keys.map((k) => k + '=…').join('&')}` : path;
}

/* Metadata is whatever the caller felt like attaching, so it is scrubbed by
   value and capped by size — an object with a thousand keys is a way to fill
   the table, not a way to describe a crash. */
export function scrubMeta(meta: unknown, maxKeys = 20): Record<string, unknown> {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    if (Object.keys(out).length >= maxKeys) break;
    /* THE KEY IS CHECKED FIRST, before the value's type. A key that NAMES a
       secret is dropped whatever it holds: «token: 1» is not safer than
       «token: "at_…"», it is only shorter, and a six-digit SMS code arrives as
       a NUMBER far more often than as a string. Letting numbers through early
       was exactly that hole. */
    if (/token|secret|password|otp|code|phone|mobile|card|auth/i.test(k)) { out[k] = SCRUB_TOKEN; continue; }
    if (v == null) { out[k] = null; continue; }
    if (typeof v === 'number' || typeof v === 'boolean') { out[k] = v; continue; }
    out[k] = scrubText(typeof v === 'string' ? v : JSON.stringify(v), 300);
  }
  return out;
}

/* WHICH CRASH IS THIS, AS OPPOSED TO WHICH OCCURRENCE.
   Four thousand copies of one crash are one job, not four thousand. Digits,
   ids and quoted values are what differ between occurrences of the same bug,
   so they come out; what is left is the shape of the message. */
export function fingerprint(message: unknown): string {
  return scrubText(message, 400)
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'ID')
    .replace(/\d+/g, 'N')
    .replace(/'[^']*'|"[^"]*"|«[^»]*»/g, 'S')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}
