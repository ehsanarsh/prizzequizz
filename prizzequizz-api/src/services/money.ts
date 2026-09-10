/* TOMAN AND RIAL — the only place a factor of ten exists.
 *
 * The game speaks Toman everywhere: catalogue prices, `wallet_ledger.amount`,
 * `payment_intents.amount`, every figure a player or an operator reads. Banks
 * speak Rial. Card-to-card lives on that seam, and the seam is where the money
 * gets lost: one missing `* 10` bills a player a tenth of the price, one extra
 * bills them ten times it, and neither is visible in a code review of the line
 * that has the bug — only in the line that doesn't.
 *
 * So the conversion is not "a helper you may use". It is the ONLY conversion,
 * and `money.test.ts` scans the source to keep it that way.
 *
 * Why the strictness looks excessive and is not:
 *
 *   - a non-integer amount means somebody divided somewhere, and rounding a
 *     price silently is how a report stops adding up
 *   - a Rial figure that is not a whole number of Toman cannot be shown to a
 *     player in Toman without lying by up to 9 Rial, so `rialToToman` refuses
 *     rather than rounding. The uniqueness suffix (1–99 Rial) makes exactly
 *     such figures on purpose, and they must never be quoted back as Toman.
 */

export const RIAL_PER_TOMAN = 10;

export class MoneyError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'MoneyError'; }
}

/** Zero is allowed — a free item is a real price. Anything else is a bug. */
function wholeAmount(value: unknown, what: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new MoneyError('AMOUNT_NOT_A_NUMBER', `${what} عدد نیست.`);
  if (!Number.isInteger(n)) throw new MoneyError('AMOUNT_NOT_WHOLE', `${what} باید عدد صحیح باشد.`);
  if (n < 0) throw new MoneyError('AMOUNT_NEGATIVE', `${what} نمی‌تواند منفی باشد.`);
  if (!Number.isSafeInteger(n)) throw new MoneyError('AMOUNT_TOO_LARGE', `${what} بیش از حد بزرگ است.`);
  return n;
}

export function tomanToRial(toman: number): number {
  const rial = wholeAmount(toman, 'مبلغ تومانی') * RIAL_PER_TOMAN;
  /* The INPUT being a safe integer does not make the product one: multiplying
   * by ten is exactly where the range runs out, and past that JavaScript stops
   * counting in ones without saying so. Check what comes out, not what went in. */
  if (!Number.isSafeInteger(rial)) throw new MoneyError('AMOUNT_TOO_LARGE', 'مبلغ ریالی بیش از حد بزرگ است.');
  return rial;
}

/**
 * Rial → Toman, refusing anything that is not a whole number of Toman.
 *
 * A card-to-card payable amount carries a 1–99 Rial suffix that makes it
 * unique; converting that back would quietly drop the suffix and produce a
 * figure that matches nothing. Callers that legitimately want the round part
 * hold the base amount already — they should use it rather than divide.
 */
export function rialToToman(rial: number): number {
  const n = wholeAmount(rial, 'مبلغ ریالی');
  if (n % RIAL_PER_TOMAN !== 0) {
    throw new MoneyError('RIAL_NOT_WHOLE_TOMAN', 'این مبلغ ریالی مضرب ۱۰ نیست و به تومان گرد نمی‌شود.');
  }
  return n / RIAL_PER_TOMAN;
}

/** «۱٬۰۵۳٬۰۰۰ تومان» */
export function formatTomanFa(toman: number): string {
  return `${wholeAmount(toman, 'مبلغ تومانی').toLocaleString('fa-IR')} تومان`;
}

/** «۱۰٬۵۳۰٬۱۱۴ ریال» — what the player copies into their banking app. */
export function formatRialFa(rial: number): string {
  return `${wholeAmount(rial, 'مبلغ ریالی').toLocaleString('fa-IR')} ریال`;
}

/**
 * The same figure with no separators, for pasting into a banking app. The
 * grouped form is for reading; a banking app's amount box is not.
 */
export function rialForClipboard(rial: number): string {
  return String(wholeAmount(rial, 'مبلغ ریالی'));
}
