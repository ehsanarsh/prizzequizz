/* THE FACTOR OF TEN.
 *
 * The game is priced in Toman; banks report Rial. A card-to-card payment
 * crosses that seam twice — once when the payable amount is built, once when
 * the bank's SMS is parsed — and a missing or extra `* 10` is not a rounding
 * error, it is a bill for a tenth or ten times the price.
 *
 * Two things are checked here. That the conversion is right, and — the part
 * that actually keeps it right a year from now — that it happens in ONE file.
 *
 * Run: npx tsx src/tests/money.test.ts
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  RIAL_PER_TOMAN, MoneyError, tomanToRial, rialToToman,
  formatTomanFa, formatRialFa, rialForClipboard
} from '../services/money.js';

let passed = 0, failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}
const isMoneyError = (code: string) => (e: unknown) => e instanceof MoneyError && e.code === code;

check('a Toman price becomes ten times as many Rial', () => {
  assert.equal(RIAL_PER_TOMAN, 10);
  assert.equal(tomanToRial(50_000), 500_000, 'a red ticket');
  assert.equal(tomanToRial(1_053_000), 10_530_000);
  assert.equal(tomanToRial(0), 0, 'a free item is a real price');
});

check('and back again when it is a whole number of Toman', () => {
  assert.equal(rialToToman(500_000), 50_000);
  assert.equal(rialToToman(0), 0);
});

check('a Rial figure carrying a uniqueness suffix REFUSES to become Toman', () => {
  /* 500,047 Rial is a payable amount built to be unique. Rounding it to
   * 50,004 or 50,005 Toman would quote a figure that matches no session. */
  assert.throws(() => rialToToman(500_047), isMoneyError('RIAL_NOT_WHOLE_TOMAN'));
  assert.throws(() => rialToToman(1), isMoneyError('RIAL_NOT_WHOLE_TOMAN'));
});

check('a non-integer amount is a bug, not something to round', () => {
  assert.throws(() => tomanToRial(12.5), isMoneyError('AMOUNT_NOT_WHOLE'));
  assert.throws(() => rialToToman(500_000.5), isMoneyError('AMOUNT_NOT_WHOLE'));
});

check('and so is a negative one, or one that is not a number at all', () => {
  assert.throws(() => tomanToRial(-1), isMoneyError('AMOUNT_NEGATIVE'));
  assert.throws(() => tomanToRial(NaN), isMoneyError('AMOUNT_NOT_A_NUMBER'));
  assert.throws(() => tomanToRial(Infinity), isMoneyError('AMOUNT_NOT_A_NUMBER'));
  assert.throws(() => tomanToRial('خیلی' as unknown as number), isMoneyError('AMOUNT_NOT_A_NUMBER'));
  /* A numeric string is coerced rather than refused: it arrives that way from
   * JSON bodies and from the SMS parser, and refusing it would push a
   * `Number(...)` into every call site — which is the sprawl this file exists
   * to prevent. */
  assert.equal(tomanToRial('50000' as unknown as number), 500_000);
});

check('an amount too large to be exact is refused rather than silently wrong', () => {
  assert.throws(() => tomanToRial(Number.MAX_SAFE_INTEGER), isMoneyError('AMOUNT_TOO_LARGE'));
});

check('the player reads Toman, the banking app is handed Rial', () => {
  assert.equal(formatTomanFa(1_053_000), '۱٬۰۵۳٬۰۰۰ تومان');
  assert.equal(formatRialFa(10_530_114), '۱۰٬۵۳۰٬۱۱۴ ریال');
  /* Separators are for reading. An amount box is not for reading. */
  assert.equal(rialForClipboard(10_530_114), '10530114');
});

/* ── the part that matters in a year ──────────────────────────────────── */

check('nothing else in the codebase converts between the two', () => {
  const root = join(process.cwd(), 'src');
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!p.endsWith('.ts') || p.endsWith('money.ts') || p.endsWith('money.test.ts')) continue;
      readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        /* Only lines that are ABOUT rial: a `* 10` somewhere else is arithmetic,
         * not a currency conversion, and flagging it would make this test noise
         * that people learn to ignore. */
        if (!/rial/i.test(line)) return;
        if (/[*/]\s*10\b/.test(line) || /\b10\s*\*/.test(line)) {
          offenders.push(`${p.replace(process.cwd() + '/', '')}:${i + 1}  ${line.trim().slice(0, 70)}`);
        }
      });
    }
  };
  walk(root);
  assert.deepEqual(offenders, [],
    'convert through money.ts — a second factor of ten is how the two drift apart:\n    ' + offenders.join('\n    '));
});

console.log(`[money] ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
