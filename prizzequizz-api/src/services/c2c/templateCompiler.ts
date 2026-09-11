/* TURNING WHAT THE OPERATOR TYPED INTO SOMETHING SAFE TO RUN.
 *
 * The operator adds new banks from the panel, which means text they wrote
 * becomes a matcher that decides whether money arrived. Handing a raw regex
 * field to that screen would be three separate mistakes:
 *
 *   - a wrong regex reads the amount wrong, and the amount IS the payment
 *   - a regex with nested quantifiers hangs the whole API on one SMS (ReDoS)
 *   - an operator is not obliged to know regex to add their own bank
 *
 * So the panel takes a TEMPLATE — the message with the variable bits named —
 * and this file compiles it. Three properties come out of that:
 *
 * 1. EVERY LITERAL IS ESCAPED. Refah's deposit marker is a bare «+» after the
 *    amount; escaped it is a plus sign, unescaped it is a quantifier. That one
 *    character is the whole difference between a deposit and a withdrawal at
 *    that bank, so it has to survive compilation as itself.
 *
 * 2. EVERY QUANTIFIER IS BOUNDED. There is no `*` or `+` anywhere in the
 *    output except the `\s*` between fields, which cannot backtrack
 *    catastrophically because it is followed by a literal or a bounded class.
 *    Linear time is structural here, not likely.
 *
 * 3. WHITESPACE IS NEVER SIGNIFICANT. Tejarat's message breaks mid-value —
 *    «مانده:» and its number land on different lines — so every boundary in
 *    the template becomes «space, newline, or nothing at all».
 */
import { MoneyError, tomanToRial } from '../money.js';

/** Longer than any bank SMS. A cap before matching, not after. */
export const MAX_SMS_LENGTH = 400;

export class TemplateError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'TemplateError'; }
}

/* WHAT EACH PLACEHOLDER MAY SWALLOW.
 *
 * Every one is a bounded character class. The bounds are generous enough for
 * a real value and tight enough that a placeholder cannot run away across the
 * rest of the message and take another field's value with it. */
const FIELDS: Record<string, { re: string; label: string }> = {
  /* Digits and thousand separators only — no decimal point. Rial has no
   * fractions, and allowing «.» lets the class eat a sentence's full stop. */
  amount: { re: '[0-9][0-9,]{0,23}', label: 'مبلغ' },
  balance: { re: '[0-9][0-9,]{0,23}', label: 'مانده' },
  /* Tejarat prints a LEADING ZERO on its account number, so this is a string
   * and never a number until something deliberately converts it. */
  account: { re: '[0-9A-Za-z][0-9A-Za-z\\-]{0,33}', label: 'شماره حساب' },
  reference: { re: '[0-9A-Za-z][0-9A-Za-z]{0,33}', label: 'کد پیگیری' },
  source: { re: '[0-9*][0-9*\\-]{0,33}', label: 'مبدأ' },
  /* Tejarat writes «1405/06/19 13:30» — the space is inside the value, so it
   * belongs in the class. Bounded, so it cannot run to the end of the text. */
  datetime: { re: '[0-9][0-9/:\\-\\s]{0,23}', label: 'تاریخ' },
  /* A line whose content does not matter. Bounded like everything else, and
   * excluding newlines so it cannot swallow the rest of the message. */
  '*': { re: '[^\\n]{0,64}', label: 'نادیده' }
};

export const FIELD_NAMES = Object.keys(FIELDS).filter((k) => k !== '*');

/* NORMALISATION, APPLIED TO BOTH SIDES.
 *
 * Sepah writes «واريز» with an Arabic ي and Tejarat writes «واریز» with a
 * Persian ی — the same word, different code points. An SMS app also inserts
 * bidi control characters around Latin digits inside Persian text, and they
 * are invisible in every editor the operator will paste into. A template and
 * a message that look identical must therefore BE identical before matching,
 * which is what this does. It runs on the template too, so an operator who
 * types one form and a bank that sends the other still meet. */
export function normalizeSms(raw: string): string {
  return String(raw ?? '')
    /* Bidi and zero-width marks: U+200B–U+200F, U+202A–U+202E, U+2066–U+2069,
     * plus the byte-order mark. Invisible, and each one breaks a literal. */
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
    /* Arabic forms of the two letters Persian writes differently. */
    .replace(/[يى]/g, 'ی')      // ي ى → ی
    .replace(/ك/g, 'ک')              // ك → ک
    /* Persian and Arabic-Indic digits → ASCII, so one amount class is enough
     * and the extracted value is a number without further translation. */
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    /* The Persian thousands separator, so the amount class is one character. */
    .replace(/٬/g, ',')
    /* Arabic decimal separator, same reason. */
    .replace(/٫/g, '.')
    .trim();
}

export interface CompiledTemplate {
  regex: RegExp;
  /** Capture-group order, so a match can be read back by name. */
  fields: string[];
  /** Every group in order — `''` marks an ignored run, which is captured
   *  anyway because the atomic trick below needs a group to point at. */
  groups: string[];
  /** The generated source, shown in the panel so it is not a black box. */
  source: string;
}

/* ATOMIC, SO ADJACENT PLACEHOLDERS CANNOT MULTIPLY.
 *
 * Every class here is already bounded, so nothing can take exponential time —
 * but two bounded classes side by side still multiply: three `{*}` in a row,
 * each capped at 64, is a quarter of a million ways to split the same text,
 * and 300ms per message is a denial of service when a device posts fifty at
 * once.
 *
 * `(?=(X))\N` is the standard way to get an atomic group in JavaScript, which
 * has no `(?>…)`. A lookahead does not retry once it has succeeded, so the
 * class matches greedily ONCE and the backreference consumes exactly that.
 * The group is a real capture group, which is why `{*}` is captured too even
 * though nothing reads it. */
function atomic(re: string, groupNumber: number): string {
  return `(?=(${re}))\\${groupNumber}`;
}

/* Everything a regex could read as syntax. `-` and `]` are here too because
 * the output is also used inside character classes nowhere — but escaping
 * more than necessary costs nothing and forgetting one costs a payment. */
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

/**
 * Compile an operator's template.
 *
 * Syntax, all of it:
 *   {amount} {balance} {account} {reference} {source} {datetime}   values
 *   {*}                                                            ignore a run
 *   [text]                                                         optional literal
 *   everything else                                                literal
 *   any whitespace                                                 «or nothing»
 */
export function compileTemplate(rawTemplate: string): CompiledTemplate {
  const template = normalizeSms(rawTemplate);
  if (!template) throw new TemplateError('TEMPLATE_EMPTY', 'قالب خالی است.');
  if (template.length > MAX_SMS_LENGTH) {
    throw new TemplateError('TEMPLATE_TOO_LONG', `قالب نباید بیشتر از ${MAX_SMS_LENGTH} نویسه باشد.`);
  }

  const fields: string[] = [];
  const groups: string[] = [];
  let out = '';
  let i = 0;
  let pendingBoundary = false;

  /* A boundary is emitted lazily so leading and trailing whitespace in the
   * template does not force whitespace in the message. */
  const flushBoundary = (): void => {
    if (pendingBoundary) { out += '\\s*'; pendingBoundary = false; }
  };

  while (i < template.length) {
    const ch = template[i]!;

    if (/\s/.test(ch)) { pendingBoundary = true; i++; continue; }

    if (ch === '{') {
      const end = template.indexOf('}', i);
      if (end < 0) throw new TemplateError('TEMPLATE_UNCLOSED', 'یک «{» بسته نشده است.');
      const name = template.slice(i + 1, end).trim();
      const spec = FIELDS[name];
      if (!spec) {
        throw new TemplateError('TEMPLATE_UNKNOWN_FIELD',
          `«{${name}}» را نمی‌شناسم. فیلدهای مجاز: ${FIELD_NAMES.map((f) => '{' + f + '}').join('، ')} و {*}`);
      }
      if (name !== '*' && fields.includes(name)) {
        /* Two groups with one name means the second silently wins, and which
         * one that is depends on the message. For an amount that is a coin
         * flip over real money. */
        throw new TemplateError('TEMPLATE_DUPLICATE_FIELD', `«{${name}}» دوبار آمده است.`);
      }
      flushBoundary();
      groups.push(name === '*' ? '' : name);
      if (name !== '*') fields.push(name);
      out += atomic(spec.re, groups.length);
      i = end + 1;
      continue;
    }

    if (ch === '[') {
      const end = template.indexOf(']', i);
      if (end < 0) throw new TemplateError('TEMPLATE_UNCLOSED', 'یک «[» بسته نشده است.');
      const literal = template.slice(i + 1, end);
      if (!literal) throw new TemplateError('TEMPLATE_EMPTY_OPTIONAL', 'متن اختیاری خالی است.');
      flushBoundary();
      /* «may or may not be there» — Refah writes no unit at all where the
       * other two write «ریال», and one template should cover both. */
      out += `(?:${escapeLiteral(literal).split(/\s+/).join('\\s*')})?`;
      i = end + 1;
      continue;
    }

    flushBoundary();
    out += escapeLiteral(ch);
    i++;
  }

  if (!fields.includes('amount')) {
    /* A pattern that does not read an amount cannot identify a payment: the
     * unique figure is the only thing tying a transfer to an order. */
    throw new TemplateError('TEMPLATE_NO_AMOUNT', 'قالب باید {amount} داشته باشد، وگرنه پرداختی قابل شناسایی نیست.');
  }

  /* Not anchored at the end: Sepah's message carries a trailing balance line
   * and Tejarat appends «از طريق: شتاب» — a template that describes the part
   * that matters should not be broken by the part that does not. */
  const regex = new RegExp(out, 'u');
  return { regex, fields, groups, source: out };
}

export interface TemplateMatch {
  values: Record<string, string>;
  amountRaw: string;
}

/**
 * Run a compiled template against a message.
 *
 * The length cap is applied HERE rather than at the caller, because every
 * route into matching goes through this function and a cap that some callers
 * remember is not a cap.
 */
export function matchTemplate(compiled: CompiledTemplate, rawBody: string): TemplateMatch | null {
  const body = normalizeSms(rawBody).slice(0, MAX_SMS_LENGTH);
  const m = compiled.regex.exec(body);
  if (!m) return null;
  const values: Record<string, string> = {};
  compiled.groups.forEach((name, idx) => {
    if (name) values[name] = (m[idx + 1] ?? '').trim();
  });
  return { values, amountRaw: values.amount ?? '' };
}

/**
 * A matched figure as a whole number of rial.
 *
 * The UNIT comes from the pattern, never from the message: Refah prints no
 * unit at all, and Sepah's «ريال» sits against the digits with no space. A
 * parser that guessed from the text would read Refah as toman half the time.
 */
export function toRial(amountRaw: string, unit: 'rial' | 'toman'): number {
  const digits = normalizeSms(amountRaw).replace(/[,\s]/g, '');
  if (!/^[0-9]{1,18}$/.test(digits)) {
    throw new MoneyError('AMOUNT_NOT_A_NUMBER', 'مبلغ خوانده‌شده عدد نیست.');
  }
  const n = Number(digits);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new MoneyError('AMOUNT_NOT_A_NUMBER', 'مبلغ خوانده‌شده معتبر نیست.');
  }
  /* Through the same door every other conversion uses. */
  return unit === 'rial' ? n : tomanToRial(n);
}
