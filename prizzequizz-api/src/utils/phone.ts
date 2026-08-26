/* FINDING SOMEBODY BY THEIR PHONE NUMBER.
 *
 * A support case almost always arrives as a phone number, and almost never in
 * the form the database happens to hold. The same person writes it as
 * 09121234567, 9121234567, +989121234567, 0912 123 4567, or ۰۹۱۲۱۲۳۴۵۶۷ —
 * typed on a Persian keyboard, which produces Persian digits that are not the
 * ASCII digits any `LIKE` is comparing against.
 *
 * So both sides get reduced to the same thing before they are compared: digits
 * only, and then the last ten of them. Ten because that is the part of an
 * Iranian mobile number that identifies the line — everything in front of it
 * (0, 98, +98, 0098) is how the caller got there, not who they are.
 */

const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC = '٠١٢٣٤٥٦٧٨٩';

/** Persian and Arabic-Indic digits are digits. Everything else is left alone. */
export function toLatinDigits(input: unknown): string {
  return String(input ?? '').replace(/[۰-۹٠-٩]/g, (d) => {
    const p = PERSIAN.indexOf(d);
    return String(p >= 0 ? p : ARABIC.indexOf(d));
  });
}

/** Digits only, then the last ten — the part that identifies the line. */
export function phoneKey(input: unknown): string {
  const digits = toLatinDigits(input).replace(/\D+/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** Worth searching the phone column for? Four digits is the shortest fragment
 *  an operator would type on purpose; below that every account matches and the
 *  result is noise rather than a search. */
export function looksLikePhone(input: unknown): boolean {
  const digits = toLatinDigits(input).replace(/\D+/g, '');
  return digits.length >= 4 && /^[\d\s+()\-۰-۹٠-٩]+$/.test(String(input ?? '').trim());
}
