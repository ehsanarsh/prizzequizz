/* THE BANK PATTERNS — written by the operator, not by a developer.
 *
 * The operator said they would add the remaining banks from the panel, so the
 * parser is not «a class per bank» but a set of rows, each a template this
 * file compiles. Three rules make that safe enough to let money depend on it:
 *
 * 1. BUILT-INS ARE A FLOOR, NOT A SEED. The three banks we have real samples
 *    for are always present. The panel can override them or add new ones, but
 *    nothing can delete them — the same shape `smsService` already uses for
 *    outgoing templates, so there is one idea here and not two.
 *
 * 2. A PATTERN CANNOT BE SAVED ON A DEPOSIT SAMPLE ALONE. It must also be
 *    given a withdrawal that it does NOT match. At Refah the difference
 *    between the two is a single «+», so a template proven only against a
 *    deposit is a template that might hand out goods for a withdrawal.
 *
 * 3. A NEW PATTERN STARTS ON TRIAL. Everything it matches goes to a human,
 *    however perfect the match looks, until it has been confirmed enough
 *    times. A wrong template then costs a few manual reviews instead of a few
 *    free tickets.
 */
import { getPgPool } from '../../database/postgres.js';
import { id } from '../../utils/id.js';
import { compileTemplate, matchTemplate, normalizeSms, toRial, TemplateError, type CompiledTemplate } from './templateCompiler.js';

export const PATTERN_STATUSES = ['draft', 'trial', 'live', 'disabled'] as const;
export type PatternStatus = (typeof PATTERN_STATUSES)[number];

export const AMOUNT_UNITS = ['rial', 'toman'] as const;
export type AmountUnit = (typeof AMOUNT_UNITS)[number];

/** Confirmations on trial before the panel offers to promote a pattern. */
export const TRIAL_CONFIRMATIONS = 5;

export interface BankSmsPattern {
  id: string;
  bankKey: string;
  label: string;
  senders: string[];
  template: string;
  amountUnit: AmountUnit;
  rejectKeywords: string[];
  sampleDeposit: string;
  sampleWithdrawal: string;
  status: PatternStatus;
  matchedCount: number;
  /** Built-ins cannot be deleted, only overridden. */
  builtIn: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export class PatternError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'PatternError'; }
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
export async function ensurePatternSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bank_sms_patterns (
      id TEXT PRIMARY KEY,
      bank_key TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      senders TEXT[] NOT NULL DEFAULT '{}',
      template TEXT NOT NULL,
      amount_unit TEXT NOT NULL,
      reject_keywords TEXT[] NOT NULL DEFAULT '{}',
      sample_deposit TEXT NOT NULL DEFAULT '',
      sample_withdrawal TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      matched_count INT NOT NULL DEFAULT 0,
      built_in BOOLEAN NOT NULL DEFAULT false,
      priority INT NOT NULL DEFAULT 100,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS bank_sms_patterns_pick ON bank_sms_patterns(status, priority);
  `);
  _schemaReady = true;
}

const mem = new Map<string, BankSmsPattern>();

function rowToPattern(r: any): BankSmsPattern {
  return {
    id: r.id,
    bankKey: r.bank_key,
    label: r.label ?? '',
    senders: r.senders ?? [],
    template: r.template,
    amountUnit: r.amount_unit === 'toman' ? 'toman' : 'rial',
    rejectKeywords: r.reject_keywords ?? [],
    sampleDeposit: r.sample_deposit ?? '',
    sampleWithdrawal: r.sample_withdrawal ?? '',
    status: (PATTERN_STATUSES as readonly string[]).includes(r.status) ? r.status : 'draft',
    matchedCount: Number(r.matched_count ?? 0),
    builtIn: r.built_in === true,
    priority: Number(r.priority ?? 100),
    createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    updatedAt: r.updated_at?.toISOString?.() ?? String(r.updated_at)
  };
}

/* THE FLOOR.
 *
 * Written from the operator's real messages, exactly as received — the Arabic
 * ي in Sepah's «واريز», Refah's bare «+», Tejarat's line break in the middle
 * of «مانده:», and the invisible U+202A/U+202C the bank wraps around account
 * numbers.
 *
 * ONLY SEPAH IS LIVE. It is the one bank we have both halves of: a real
 * deposit AND a real withdrawal, and the template provably reads the first
 * and not the second. Refah and Tejarat have a real deposit and no withdrawal
 * yet, so they ship on `trial` with an EMPTY negative sample rather than an
 * invented one. Trial means they parse and every match still goes to a human,
 * which is the honest state: we can read these messages, we cannot yet prove
 * we can tell their withdrawals apart. The panel shows the gap and asks the
 * operator to fill it.
 */
const BUILT_INS: Array<Omit<BankSmsPattern, 'id' | 'matchedCount' | 'createdAt' | 'updatedAt'>> = [
  {
    bankKey: 'sepah', label: 'بانک سپه', senders: ['sepah bank', 'sepahbank'],
    /* «[ريال]» and not «ريال»: the real withdrawal prints no unit at all, so
     * the same bank does not always write one. A template that insists on it
     * would miss the day Sepah sends a deposit without it. */
    template: 'بانک سپه\nواريز:{amount}[ريال]\nحساب:{account}\nمانده:{balance}\n{datetime}',
    amountUnit: 'rial', rejectKeywords: ['برداشت'],
    sampleDeposit: 'بانک سپه\nواريز:250,000ريال\nحساب:49302749612\nمانده:59,719,997\n2/23-20:43',
    /* The operator's real withdrawal, invisible characters and all. «حساب :»
     * with a space before the colon where the deposit has none — same bank,
     * same day, different punctuation, which is why every boundary is \s*. */
    sampleWithdrawal: 'بانک سپه\nبرداشت:6,009,000\nحساب :\u202a49302749612\u202c\nمانده:61,528,853',
    status: 'live', builtIn: true, priority: 10
  },
  {
    bankKey: 'refah', label: 'بانک رفاه', senders: ['refah bank', 'refahbank'],
    /* The «+» is the entire difference between a deposit and a withdrawal
     * here. Compiled as a literal, so a «-» cannot match it. That is the
     * REASON to believe the separation works; the proof is a real withdrawal
     * message, which we do not have. Hence trial. */
    template: 'بانک رفاه\nحساب{account}\nکارت{amount}+\nمانده{balance}\n{datetime}',
    amountUnit: 'rial', rejectKeywords: [],
    sampleDeposit: 'بانک رفاه\nحساب292555271\nکارت625,893+\nمانده14,591,760\n06/19-22:07',
    sampleWithdrawal: '',
    status: 'trial', builtIn: true, priority: 20
  },
  {
    bankKey: 'tejarat', label: 'بانک تجارت', senders: ['tejarat bank', 'tejaratbank'],
    template: 'بانک تجارت حساب: {account} واریز: {amount} [ریال]\nاز طريق: {*}\nمانده: {balance} [ریال] {datetime}',
    amountUnit: 'rial', rejectKeywords: ['برداشت'],
    sampleDeposit: 'بانک تجارت حساب: 0151039084019 واریز: 12,000,000 ریال از طريق: شتاب\nمانده:\n89,579,894 ریال 1405/06/19 13:30',
    sampleWithdrawal: '',
    status: 'trial', builtIn: true, priority: 30
  }
];

let _seeded = false;
async function seedFloor(): Promise<void> {
  if (_seeded) return;
  _seeded = true;
  const existing = await listPatternsRaw();
  for (const b of BUILT_INS) {
    if (existing.some((p) => p.bankKey === b.bankKey && p.builtIn)) continue;
    await writePattern({ ...b, id: id(), matchedCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
}

async function listPatternsRaw(): Promise<BankSmsPattern[]> {
  const pool = pg();
  if (pool) {
    await ensurePatternSchema(pool);
    const { rows } = await pool.query(`SELECT * FROM bank_sms_patterns ORDER BY priority, created_at`);
    return rows.map(rowToPattern);
  }
  return [...mem.values()].sort((a, b) => a.priority - b.priority || (a.createdAt < b.createdAt ? -1 : 1));
}

async function writePattern(p: BankSmsPattern): Promise<BankSmsPattern> {
  const pool = pg();
  if (pool) {
    await ensurePatternSchema(pool);
    await pool.query(
      `INSERT INTO bank_sms_patterns(id,bank_key,label,senders,template,amount_unit,reject_keywords,
         sample_deposit,sample_withdrawal,status,matched_count,built_in,priority,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET bank_key=$2,label=$3,senders=$4,template=$5,amount_unit=$6,
         reject_keywords=$7,sample_deposit=$8,sample_withdrawal=$9,status=$10,matched_count=$11,
         built_in=$12,priority=$13,updated_at=$15`,
      [p.id, p.bankKey, p.label, p.senders, p.template, p.amountUnit, p.rejectKeywords,
       p.sampleDeposit, p.sampleWithdrawal, p.status, p.matchedCount, p.builtIn, p.priority,
       p.createdAt, p.updatedAt]);
    return p;
  }
  mem.set(p.id, p);
  return p;
}

export async function listPatterns(): Promise<BankSmsPattern[]> { await seedFloor(); return listPatternsRaw(); }
export async function getPattern(pid: string): Promise<BankSmsPattern | null> {
  return (await listPatterns()).find((p) => p.id === pid) ?? null;
}

export interface PatternDraft {
  id?: string;
  bankKey: string;
  label?: string;
  senders?: string[];
  template: string;
  amountUnit: AmountUnit;
  rejectKeywords?: string[];
  sampleDeposit: string;
  sampleWithdrawal: string;
  status?: PatternStatus;
  priority?: number;
}

export interface PatternProof {
  /** What the template read out of the deposit sample, in BOTH units. */
  amountRial: number;
  amountRialText: string;
  amountTomanText: string;
  values: Record<string, string>;
  regexSource: string;
}

/**
 * Compile, prove, and save.
 *
 * The proof is the point. A template is not accepted because it looks right:
 * it is run against a real deposit, which it must read, and against a real
 * withdrawal, which it must not. Both samples are stored with the pattern so
 * the next person can see what it was proven on.
 */
export async function savePattern(draft: PatternDraft): Promise<{ pattern: BankSmsPattern; proof: PatternProof }> {
  const bankKey = String(draft.bankKey ?? '').trim();
  if (!bankKey) throw new PatternError('BANK_KEY_REQUIRED', 'کلید بانک لازم است.');
  if (!(AMOUNT_UNITS as readonly string[]).includes(draft.amountUnit)) {
    /* No default, ever: Refah writes no unit in the message at all, so a
     * guess here is a ten-times error that nothing in the text can correct. */
    throw new PatternError('AMOUNT_UNIT_REQUIRED', 'واحد مبلغ را مشخص کن — ریال یا تومان.');
  }

  let compiled: CompiledTemplate;
  try { compiled = compileTemplate(draft.template); }
  catch (e) {
    if (e instanceof TemplateError) throw new PatternError(e.code, e.message);
    throw e;
  }

  const deposit = String(draft.sampleDeposit ?? '').trim();
  const withdrawal = String(draft.sampleWithdrawal ?? '').trim();
  if (!deposit) throw new PatternError('SAMPLE_DEPOSIT_REQUIRED', 'یک نمونهٔ واقعی واریز لازم است.');
  if (!withdrawal) {
    throw new PatternError('SAMPLE_WITHDRAWAL_REQUIRED',
      'یک نمونهٔ برداشت هم لازم است — الگویی که برداشت را واریز بخواند، کالای رایگان تحویل می‌دهد.');
  }

  const hit = matchTemplate(compiled, deposit);
  if (!hit) throw new PatternError('SAMPLE_DEPOSIT_NOT_MATCHED', 'این قالب روی نمونهٔ واریز نگرفت.');
  if (matchTemplate(compiled, withdrawal)) {
    throw new PatternError('SAMPLE_WITHDRAWAL_MATCHED',
      'این قالب روی نمونهٔ برداشت هم گرفت. تا وقتی واریز و برداشت را از هم جدا نکند ذخیره نمی‌شود.');
  }

  const amountRial = toRial(hit.amountRaw, draft.amountUnit);
  const { formatRialFa, formatTomanFa, rialToToman } = await import('../money.js');
  let amountTomanText = '';
  try { amountTomanText = formatTomanFa(rialToToman(amountRial)); } catch { amountTomanText = '—'; }

  const existing = draft.id ? await getPattern(draft.id) : null;
  const now = new Date().toISOString();
  const pattern: BankSmsPattern = {
    id: existing?.id ?? id(),
    bankKey,
    label: draft.label ?? existing?.label ?? bankKey,
    senders: draft.senders ?? existing?.senders ?? [],
    template: draft.template,
    amountUnit: draft.amountUnit,
    rejectKeywords: draft.rejectKeywords ?? existing?.rejectKeywords ?? [],
    sampleDeposit: deposit,
    sampleWithdrawal: withdrawal,
    /* A pattern the operator just changed goes back on trial even if it was
     * live: what was proven was the OLD template. */
    status: draft.status ?? (existing && existing.template === draft.template ? existing.status : 'trial'),
    matchedCount: existing?.matchedCount ?? 0,
    builtIn: existing?.builtIn ?? false,
    priority: draft.priority ?? existing?.priority ?? 100,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  await writePattern(pattern);
  return {
    pattern,
    proof: {
      amountRial,
      amountRialText: formatRialFa(amountRial),
      amountTomanText,
      values: hit.values,
      regexSource: compiled.source
    }
  };
}

export async function setPatternStatus(pid: string, status: PatternStatus): Promise<BankSmsPattern | null> {
  const p = await getPattern(pid);
  if (!p) return null;
  return writePattern({ ...p, status, updatedAt: new Date().toISOString() });
}

export async function bumpMatched(pid: string): Promise<void> {
  const p = await getPattern(pid);
  if (!p) return;
  await writePattern({ ...p, matchedCount: p.matchedCount + 1, updatedAt: new Date().toISOString() });
}

export async function removePattern(pid: string): Promise<boolean> {
  const p = await getPattern(pid);
  if (!p) return false;
  if (p.builtIn) {
    /* The floor is a floor. Disabling is how you stop using one — deleting it
     * would have it reappear on the next restart, which looks like a bug. */
    throw new PatternError('PATTERN_BUILT_IN', 'الگوهای پیش‌فرض حذف نمی‌شوند؛ وضعیتشان را «غیرفعال» کن.');
  }
  const pool = pg();
  if (pool) { await pool.query(`DELETE FROM bank_sms_patterns WHERE id=$1`, [pid]); return true; }
  return mem.delete(pid);
}

/** Compiled once per call site rather than per message. */
export async function livePatterns(): Promise<Array<{ pattern: BankSmsPattern; compiled: CompiledTemplate }>> {
  const out: Array<{ pattern: BankSmsPattern; compiled: CompiledTemplate }> = [];
  for (const pattern of await listPatterns()) {
    if (pattern.status === 'draft' || pattern.status === 'disabled') continue;
    try { out.push({ pattern, compiled: compileTemplate(pattern.template) }); }
    catch { /* A row that no longer compiles is skipped, never thrown from the
             * hot path: one bad row must not stop every other bank matching. */ }
  }
  return out;
}

export { normalizeSms };

/** Test seam. */
export function _resetPatterns(): void { mem.clear(); _schemaReady = false; _seeded = false; }
