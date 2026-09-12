/* Question pipeline — the infrastructure for managing questions BOTH manually
 * and with AI, for a money game where a wrong/ambiguous question is costly.
 *
 *   AI Generator → AI Reviewer → Fact Checker → Duplicate Detector →
 *   Quality Score → (approve) → Database → Game → Player Feedback → (auto-retire)
 *
 * Pipeline metadata lives in `question_pipeline` (JSONB), separate from the core
 * questions table, so the pipeline can evolve without touching gameplay. The
 * AI stages are optional: with no API key they return `configured:false` and a
 * human drives the same stages from the admin studio. Everything is thresholded
 * from the editable config (minQualityScore, duplicateThreshold, autoRetire).
 */
import { getPgPool } from '../database/postgres.js';
import { gameConfig } from '../core/config.js';
import { repositories } from '../repositories/index.js';
import type { Question } from '../types/domain.js';
import { id } from '../utils/id.js';
import { logger } from './logger.js';
import { aiConfigured, aiJson, aiModel } from './aiClient.js';

export interface PipelineMeta {
  questionId: string;
  source: 'manual' | 'ai';
  stage: 'draft' | 'reviewed' | 'fact_checked' | 'dedup_checked' | 'scored' | 'approved' | 'rejected' | 'retired';
  qualityScore: number;
  reportCount: number;
  aiReview?: any;
  factCheck?: any;
  duplicate?: { isDuplicate: boolean; maxSimilarity: number; matchId?: string };
  quality?: { accuracy: number; clarity: number; difficulty: number; originality: number; grammar: number; total: number };
  feedback: { tooHard: number; tooEasy: number; wrongAnswer: number; duplicate: number; report: number };
  explanation?: string;
  source_ref?: string;
  updatedAt: string;
}

function cfg(): any { return (gameConfig as any)?.questionPipeline ?? {}; }
function minQuality(): number { const n = Number(cfg().minQualityScore); return Number.isFinite(n) ? n : 95; }
function dupThreshold(): number { const n = Number(cfg().duplicateThreshold); return Number.isFinite(n) ? n : 90; }
function autoRetireReports(): number { const n = Number(cfg().autoRetireReports); return Number.isFinite(n) && n > 0 ? n : 10; }

// ---------------------------------------------------------------------------
// storage (question_pipeline) — runtime-ensured, memory fallback
// ---------------------------------------------------------------------------
let _ready = false;
function pg() { try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; } }
async function ensure(pool: ReturnType<typeof getPgPool>) {
  if (_ready) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS question_pipeline (
    question_id UUID PRIMARY KEY,
    source VARCHAR(12) NOT NULL DEFAULT 'manual',
    stage VARCHAR(20) NOT NULL DEFAULT 'draft',
    quality_score INT NOT NULL DEFAULT 0,
    report_count INT NOT NULL DEFAULT 0,
    meta JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMP NOT NULL DEFAULT now())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_qpipeline_stage ON question_pipeline(stage)`);
  _ready = true;
}
const mem = new Map<string, PipelineMeta>();

const emptyFeedback = () => ({ tooHard: 0, tooEasy: 0, wrongAnswer: 0, duplicate: 0, report: 0 });

export async function getMeta(questionId: string): Promise<PipelineMeta | null> {
  const pool = pg();
  if (!pool) return mem.get(questionId) ?? null;
  await ensure(pool);
  const { rows } = await pool.query('SELECT * FROM question_pipeline WHERE question_id=$1', [questionId]);
  return rows[0] ? fromRow(rows[0]) : null;
}
async function saveMeta(m: PipelineMeta): Promise<void> {
  m.updatedAt = new Date().toISOString();
  const pool = pg();
  if (!pool) { mem.set(m.questionId, m); return; }
  await ensure(pool);
  await pool.query(
    `INSERT INTO question_pipeline(question_id,source,stage,quality_score,report_count,meta,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (question_id) DO UPDATE SET source=$2, stage=$3, quality_score=$4, report_count=$5, meta=$6, updated_at=now()`,
    [m.questionId, m.source, m.stage, m.qualityScore, m.reportCount, JSON.stringify(metaBlob(m))]);
}
function metaBlob(m: PipelineMeta) { return { aiReview: m.aiReview, factCheck: m.factCheck, duplicate: m.duplicate, quality: m.quality, feedback: m.feedback, explanation: m.explanation, source_ref: m.source_ref }; }
function fromRow(r: any): PipelineMeta {
  const b = r.meta ?? {};
  return { questionId: r.question_id, source: r.source, stage: r.stage, qualityScore: Number(r.quality_score), reportCount: Number(r.report_count), aiReview: b.aiReview, factCheck: b.factCheck, duplicate: b.duplicate, quality: b.quality, feedback: b.feedback ?? emptyFeedback(), explanation: b.explanation, source_ref: b.source_ref, updatedAt: r.updated_at?.toISOString?.() ?? String(r.updated_at) };
}
function baseMeta(questionId: string, source: 'manual' | 'ai'): PipelineMeta {
  return { questionId, source, stage: 'draft', qualityScore: 0, reportCount: 0, feedback: emptyFeedback(), updatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
/* THE THREE PROMPTS, WHERE AN OPERATOR CAN REACH THEM.
 *
 * These were literals in this file, so tuning what the model is asked — the one
 * thing anyone running a question pipeline actually wants to tune — meant a
 * code change and a deploy. They live in the panel's `questionPipeline` config
 * now, with the text below as the default, so an empty or missing setting
 * behaves exactly as before.
 *
 * The JSON shape is NOT part of what an operator edits. It is appended by the
 * caller and by aiClient, because the reply is parsed against it: a prompt that
 * could change the shape could break every stage downstream of it. */
const PROMPT_DEFAULTS = {
  generator: 'You are an expert Persian (Farsi) quiz-question writer for a paid competition app. Write factually correct, unambiguous questions with EXACTLY 4 options and EXACTLY one correct answer. Persian must be fluent and natural. Avoid time-sensitive facts unless clearly dated.',
  reviewer: 'You are a strict Persian quiz reviewer. Check: is the marked answer correct; is there EXACTLY one correct option; any ambiguity; is Persian fluent; does difficulty match. Score each 0-100.',
  factChecker: 'You are a meticulous fact-checker. Verify whether the marked answer is actually correct using reliable general knowledge. If the fact is time-sensitive, lower confidence and say so.'
} as const;

export type PromptStage = keyof typeof PROMPT_DEFAULTS;

/** The operator's prompt for a stage, or the shipped default when unset. */
export function aiPrompt(stage: PromptStage): string {
  const cfg = (gameConfig as any)?.questionPipeline ?? {};
  const own = cfg.prompts?.[stage];
  const text = typeof own === 'string' ? own.trim() : '';
  return text || PROMPT_DEFAULTS[stage];
}

/** The defaults, so the panel can show what «empty» means and offer a reset. */
export function aiPromptDefaults(): Record<PromptStage, string> { return { ...PROMPT_DEFAULTS }; }

// Stage 1 — AI Generator
// ---------------------------------------------------------------------------
export interface DraftQuestion { topic: string; difficulty: string; question: string; options: string[]; correctAnswer: number; explanation?: string; source?: string }

export async function aiGenerate(input: { topic: string; difficulty?: string; count?: number; category?: string }): Promise<{ configured: boolean; drafts: DraftQuestion[]; error?: string; dropped?: Array<{ why: string; sample: string }> }> {
  const count = Math.min(10, Math.max(1, Number(input.count) || 1));
  const difficulty = input.difficulty || 'medium';
  const r = await aiJson<{ questions: DraftQuestion[] }>({
    model: aiModel('generator'),
    system: aiPrompt('generator'),
    user: `Create ${count} multiple-choice quiz question(s) in PERSIAN about "${input.topic}" at "${difficulty}" difficulty. Return JSON: {"questions":[{"topic":"${input.topic}","difficulty":"${difficulty}","question":"...","options":["..","..","..",".."],"correctAnswer":0,"explanation":"...","source":".."}]}. correctAnswer is the 0-based index of the correct option.`,
    maxTokens: 1600
  });
  if (!r.configured) return { configured: false, drafts: [], error: 'AI not configured' };
  if (!r.ok || !r.data) return { configured: true, drafts: [], error: r.error };
  const arr = Array.isArray((r.data as any).questions) ? (r.data as any).questions
    : Array.isArray((r.data as any).items) ? (r.data as any).items
    : Array.isArray(r.data) ? r.data : [];
  const drafts: DraftQuestion[] = [];
  const dropped: Array<{ why: string; sample: string }> = [];
  for (const q of arr) {
    const d = readDraft(q, input.topic, difficulty);
    if (d.ok) drafts.push(d.draft); else dropped.push({ why: d.why, sample: d.sample });
  }
  /* A MODEL THAT ANSWERED AND STILL PRODUCED NOTHING HAS TO SAY SO.
   * Every question used to be dropped in silence when its shape was not the
   * exact one asked for, and the run reported «۰ تولید شد» with nothing to
   * explain it — which is indistinguishable from a key that does not work, a
   * model id that does not exist, or a gateway that is down. Three completely
   * different fixes, and no way to tell which one was needed. */
  if (!drafts.length && dropped.length) {
    logger.warn('ai_generate_all_dropped', { count: dropped.length, first: dropped[0] });
    return { configured: true, drafts: [], dropped,
      error: `مدل ${dropped.length} سؤال داد ولی هیچ‌کدام قابل استفاده نبود — ${dropped[0]!.why}` };
  }
  return { configured: true, drafts, dropped };
}

/* WHAT A MODEL ACTUALLY SENDS BACK.
 *
 * The prompt asks for one exact shape and the good ones obey, but «obey» is not
 * a guarantee: the answer index arrives as "2" rather than 2, the key is
 * `correct_answer` instead of `correctAnswer`, the options come as
 * {a,b,c,d} instead of a list. None of that is a bad question — it is the same
 * question wearing different clothes, and rejecting it silently threw away work
 * that had already been paid for.
 *
 * So this is liberal about the shape and strict about the RESULT: four real
 * options and an index that points at one of them, or it is refused with a
 * reason somebody can act on. */
function readDraft(raw: any, topic: string, difficulty: string):
  { ok: true; draft: DraftQuestion } | { ok: false; why: string; sample: string } {
  const sample = String(raw == null ? '' : (typeof raw === 'object' ? JSON.stringify(raw) : raw)).slice(0, 140);
  if (!raw || typeof raw !== 'object') return { ok: false, why: 'پاسخ یک شیء نبود', sample };

  const text = String(raw.question ?? raw.text ?? raw.prompt ?? raw.title ?? '').trim();
  if (!text) return { ok: false, why: 'سؤال متن نداشت', sample };

  /* A list, or the lettered/numbered object shapes models fall back to. */
  let opts: string[] = [];
  if (Array.isArray(raw.options)) opts = raw.options.map((o: any) => String(o ?? '').trim());
  else if (Array.isArray(raw.choices)) opts = raw.choices.map((o: any) => String(o ?? '').trim());
  else if (raw.options && typeof raw.options === 'object') {
    for (const k of ['a', 'b', 'c', 'd', 'A', 'B', 'C', 'D', '1', '2', '3', '4']) {
      const v = raw.options[k];
      if (v != null && String(v).trim()) opts.push(String(v).trim());
    }
  }
  opts = opts.filter((o) => o !== '');
  if (opts.length !== 4) return { ok: false, why: `به‌جای ۴ گزینه، ${opts.length} گزینه داشت`, sample };

  /* The index, however it was expressed: a number, a numeric string, a letter,
   * or the text of the correct option itself. */
  const rawIdx = raw.correctAnswer ?? raw.correct_answer ?? raw.correctIndex ?? raw.correct_index ?? raw.answer ?? raw.answerIndex;
  let idx = -1;
  if (typeof rawIdx === 'number' && Number.isFinite(rawIdx)) idx = Math.trunc(rawIdx);
  else if (typeof rawIdx === 'string') {
    const t = rawIdx.trim();
    if (/^[0-9]+$/.test(t)) idx = Number(t);
    else if (/^[a-dA-D]$/.test(t)) idx = t.toLowerCase().charCodeAt(0) - 97;
    else {
      /* The answer given as the option's own words — common, and unambiguous. */
      const at = opts.findIndex((o) => o === t);
      if (at >= 0) idx = at;
    }
  }
  /* Some models answer 1-based. A 4 can only mean the fourth option. */
  if (idx === 4 && opts.length === 4) idx = 3;
  if (!Number.isInteger(idx) || idx < 0 || idx >= 4) {
    return { ok: false, why: 'جواب درست مشخص نبود', sample };
  }

  return { ok: true, draft: {
    topic: String(raw.topic ?? topic), difficulty: String(raw.difficulty ?? difficulty),
    question: text, options: opts, correctAnswer: idx,
    explanation: raw.explanation ? String(raw.explanation) : undefined,
    source: raw.source ? String(raw.source) : undefined
  } };
}

// ---------------------------------------------------------------------------
// Stage 2 — AI Reviewer
// ---------------------------------------------------------------------------
export async function aiReview(q: { text: string; options: string[]; correctIndex: number; difficulty: string }): Promise<any> {
  const r = await aiJson({
    model: aiModel('reviewer'),
    system: aiPrompt('reviewer'),
    user: `Review this question (0-based correct index = ${q.correctIndex}, difficulty=${q.difficulty}). Question: ${q.text}\nOptions: ${q.options.map((o, i) => `${i}) ${o}`).join(' | ')}\nReturn JSON: {"accuracy":0,"clarity":0,"grammar":0,"difficultyMatch":0,"singleCorrect":true,"ambiguous":false,"approved":true,"notes":".."}`,
    maxTokens: 700
  });
  return r.configured ? (r.ok ? r.data : { error: r.error }) : { configured: false };
}

// ---------------------------------------------------------------------------
// Stage 3 — Fact Checker
// ---------------------------------------------------------------------------
export async function aiFactCheck(q: { text: string; options: string[]; correctIndex: number }): Promise<any> {
  const r = await aiJson({
    model: aiModel('factChecker'),
    system: aiPrompt('factChecker'),
    user: `Fact-check. Correct option is index ${q.correctIndex}. Question: ${q.text}\nOptions: ${q.options.map((o, i) => `${i}) ${o}`).join(' | ')}\nReturn JSON: {"verified":true,"confidence":0,"timeSensitive":false,"correctIndexShouldBe":${q.correctIndex},"note":".."}`,
    maxTokens: 600
  });
  return r.configured ? (r.ok ? r.data : { error: r.error }) : { configured: false };
}

// ---------------------------------------------------------------------------
// Stage 4 — Duplicate Detector (semantic-ish text similarity, no embeddings)
// ---------------------------------------------------------------------------
function normalize(s: string): string {
  return String(s || '').toLowerCase()
    .replace(/[ً-ٟـ]/g, '')      // Arabic diacritics/tatweel
    .replace(/ي/g, 'ی').replace(/ك/g, 'ک')       // Arabic→Persian
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}
function trigrams(s: string): Set<string> {
  const t = normalize(s).replace(/\s/g, ' ');
  const g = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3));
  return g;
}
function similarity(a: string, b: string): number {
  const ga = trigrams(a), gb = trigrams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0; for (const x of ga) if (gb.has(x)) inter++;
  return Math.round((inter / (ga.size + gb.size - inter)) * 100); // Jaccard %
}
export async function dedupCheck(questionText: string, excludeId?: string): Promise<{ isDuplicate: boolean; maxSimilarity: number; matchId?: string }> {
  const all = await repositories.questions.listAll().catch(() => [] as Question[]);
  let best = 0, matchId: string | undefined;
  for (const q of all) {
    if (q.id === excludeId) continue;
    const sim = similarity(questionText, q.text);
    if (sim > best) { best = sim; matchId = q.id; }
  }
  return { isDuplicate: best >= dupThreshold(), maxSimilarity: best, matchId };
}

// ---------------------------------------------------------------------------
// Stage 5 — Quality Score (aggregate of review + fact-check + originality)
// ---------------------------------------------------------------------------
export function computeQuality(review: any, fact: any, dup: { maxSimilarity: number }): PipelineMeta['quality'] {
  const num = (v: any, d = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : d; };
  const accuracy = fact && fact.verified === false ? 0 : num(review?.accuracy, aiConfigured() ? 0 : 90);
  const clarity = num(review?.clarity, aiConfigured() ? 0 : 90);
  const grammar = num(review?.grammar, aiConfigured() ? 0 : 90);
  const difficulty = num(review?.difficultyMatch, aiConfigured() ? 0 : 90);
  const originality = Math.max(0, 100 - Number(dup.maxSimilarity || 0));
  // accuracy is weighted heaviest for a money game.
  const total = Math.round(accuracy * 0.4 + clarity * 0.2 + grammar * 0.15 + difficulty * 0.1 + originality * 0.15);
  return { accuracy, clarity, difficulty, originality, grammar, total };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
export async function runPipeline(questionId: string, opts: { autoApprove?: boolean } = {}): Promise<PipelineMeta> {
  const q = await repositories.questions.findById(questionId);
  if (!q) throw new Error('QUESTION_NOT_FOUND');
  let m = (await getMeta(questionId)) ?? baseMeta(questionId, 'manual');
  m.aiReview = await aiReview({ text: q.text, options: q.options, correctIndex: q.correctIndex, difficulty: q.difficulty });
  m.stage = 'reviewed';
  m.factCheck = await aiFactCheck({ text: q.text, options: q.options, correctIndex: q.correctIndex });
  m.stage = 'fact_checked';
  m.duplicate = await dedupCheck(q.text, questionId);
  m.stage = 'dedup_checked';
  m.quality = computeQuality(m.aiReview, m.factCheck, m.duplicate);
  m.qualityScore = m.quality?.total ?? 0;
  m.stage = 'scored';
  // Auto-approve only when it clears every gate (or human forces it).
  const passes = !m.duplicate.isDuplicate && m.qualityScore >= minQuality() && (m.factCheck?.verified !== false);
  if (opts.autoApprove && passes) { await approve(questionId); m.stage = 'approved'; }
  await saveMeta(m);
  return m;
}

/* ---------------------------------------------------------------------------
 * THE WHOLE JOB, IN ONE GO.
 *
 * Everything below already existed — generate, review, fact-check, check the
 * bank for something too similar, score — and none of it was joined up. The
 * panel asked the model for drafts, held them in a JAVASCRIPT VARIABLE, and
 * left the operator to save them one at a time. Switching tab threw the lot
 * away, because nothing had been written down anywhere.
 *
 * So this is the join: ask, then for every question that comes back, put it
 * through every stage and into the bank — and say at the end what happened to
 * each one. Nothing lives in a browser tab, so nothing is lost by leaving it.
 *
 * Two things it refuses to do quietly:
 *   - a question too close to one already in the bank is NOT written. Checking
 *     after the fact would mean the bank is polluted by the time anybody looks.
 *   - a question the fact-check could not stand behind is written but left
 *     unapproved, never silently added, because this is a money game.
 *
 * Repeats WITHIN one batch are caught for free: each question is in the bank
 * before the next is checked against it, and a model asked for ten questions
 * on one topic will happily give the same one twice.
 * ------------------------------------------------------------------------- */
export interface BatchSkip { question: string; reason: 'duplicate' | 'malformed' | 'failed'; detail?: string }
export interface BatchRow {
  id: string; text: string; category?: string; difficulty: string;
  stage: string; quality: number; approved: boolean; reason?: string;
}
export interface BatchOutcome {
  configured: boolean;
  requested: number;
  generated: number;
  added: number;
  pending: number;
  skipped: BatchSkip[];
  questions: BatchRow[];
  error?: string;
}

/** The most one run may ask for. A run is real money at the provider and real
 *  time with somebody watching, so it is bounded rather than open-ended. */
export const BATCH_MAX = 25;
/** The model is asked in chunks; this is how many extra goes it gets when it
 *  returns fewer than were asked for. */
const BATCH_ROUNDS = 4;

function usable(d: DraftQuestion): boolean {
  return !!d && typeof d.question === 'string' && d.question.trim().length > 5
    && Array.isArray(d.options) && d.options.length === 4
    && d.options.every((o) => typeof o === 'string' && o.trim() !== '')
    && Number.isInteger(d.correctAnswer) && d.correctAnswer >= 0 && d.correctAnswer < 4;
}

/** Why a question that went through every stage was not approved. */
function holdReason(m: PipelineMeta): string | undefined {
  if (m.duplicate?.isDuplicate) return 'شبیه سؤالی است که از قبل داریم';
  if (m.factCheck && m.factCheck.verified === false) return 'صحت پاسخ تأیید نشد';
  if ((m.qualityScore ?? 0) < minQuality()) return `امتیاز کیفیت ${m.qualityScore ?? 0} کمتر از حد ${minQuality()} است`;
  return undefined;
}

export async function aiRunBatch(input: {
  topic: string; difficulty?: string; count?: number; category?: string; autoApprove?: boolean;
}): Promise<BatchOutcome> {
  const requested = Math.min(BATCH_MAX, Math.max(1, Number(input.count) || 1));
  const out: BatchOutcome = { configured: true, requested, generated: 0, added: 0, pending: 0, skipped: [], questions: [] };
  const autoApprove = input.autoApprove !== false;   // doing the job is the point

  const seen: string[] = [];   // accepted in THIS run, for a cheap same-batch check
  let rounds = 0;
  while (out.questions.length < requested && rounds < BATCH_ROUNDS) {
    rounds++;
    const want = requested - out.questions.length;
    const gen = await aiGenerate({ topic: input.topic, difficulty: input.difficulty, count: Math.min(10, want), category: input.category });
    if (!gen.configured) return { ...out, configured: false, error: gen.error ?? 'AI not configured' };
    /* Questions the model sent that could not be read are reported, not thrown
     * away quietly — «۰ تولید شد» with no reason is the same message whether the
     * key is wrong, the model id does not exist, or the answers came back in a
     * shape nobody expected, and those need three different fixes. */
    for (const d of (gen.dropped ?? [])) out.skipped.push({ question: d.sample, reason: 'malformed', detail: d.why });
    if (gen.error && !gen.drafts.length) { out.error = gen.error; break; }
    if (!gen.drafts.length) break;
    out.generated += gen.drafts.length;

    for (const d of gen.drafts) {
      if (out.questions.length >= requested) break;
      if (!usable(d)) { out.skipped.push({ question: String(d?.question ?? '—').slice(0, 120), reason: 'malformed' }); continue; }

      /* Checked BEFORE it is written. Writing first and checking after would
       * leave the bank holding the very thing we decided not to keep. */
      const dup = await dedupCheck(d.question);
      const near = seen.find((t) => similarity(t, d.question) >= dupThreshold());
      if (dup.isDuplicate || near) {
        out.skipped.push({ question: d.question.slice(0, 120), reason: 'duplicate',
          detail: near ? 'تکراری در همین دسته' : `شباهت ${dup.maxSimilarity}٪ به سؤال موجود` });
        continue;
      }

      try {
        const q = await createDraft({
          text: d.question, options: d.options, correctIndex: d.correctAnswer,
          category: input.category ?? d.topic, difficulty: d.difficulty || input.difficulty || 'medium',
          source: 'ai', explanation: d.explanation, sourceRef: d.source
        });
        const m = await runPipeline(q.id, { autoApprove });
        const approved = m.stage === 'approved';
        if (approved) out.added++; else out.pending++;
        seen.push(d.question);
        out.questions.push({
          id: q.id, text: d.question, category: q.category, difficulty: q.difficulty,
          stage: m.stage, quality: m.qualityScore ?? 0, approved, reason: approved ? undefined : holdReason(m)
        });
      } catch (e) {
        out.skipped.push({ question: d.question.slice(0, 120), reason: 'failed',
          detail: e instanceof Error ? e.message : 'unknown' });
      }
    }
  }
  return out;
}

export async function approve(questionId: string): Promise<void> {
  const q = await repositories.questions.findById(questionId);
  if (!q) return;
  q.status = 'approved';
  await repositories.questions.save(q);
  const m = (await getMeta(questionId)) ?? baseMeta(questionId, 'manual');
  m.stage = 'approved'; await saveMeta(m);
}
export async function reject(questionId: string): Promise<void> {
  const q = await repositories.questions.findById(questionId);
  if (q) { q.status = 'rejected'; await repositories.questions.save(q); }
  const m = (await getMeta(questionId)) ?? baseMeta(questionId, 'manual');
  m.stage = 'rejected'; await saveMeta(m);
}

/* Create a draft question (manual or from an AI draft) + its pipeline row. */
export async function createDraft(input: { text: string; options: string[]; correctIndex: number; category?: string; difficulty?: string; source: 'manual' | 'ai'; explanation?: string; sourceRef?: string }): Promise<Question> {
  const q: Question = { id: id(), text: input.text, options: input.options.map(String), correctIndex: Number(input.correctIndex) || 0, category: input.category || 'عمومی', difficulty: (input.difficulty as any) || 'medium', tags: [], status: 'pending', version: 1 };
  await repositories.questions.save(q);
  const m = baseMeta(q.id, input.source);
  m.explanation = input.explanation; m.source_ref = input.sourceRef;
  await saveMeta(m);
  return q;
}

// ---------------------------------------------------------------------------
// Stage 6 — Player Feedback + auto-retire
// ---------------------------------------------------------------------------
export async function recordFeedback(questionId: string, type: keyof PipelineMeta['feedback']): Promise<{ reportCount: number; retired: boolean }> {
  if (!['tooHard', 'tooEasy', 'wrongAnswer', 'duplicate', 'report'].includes(type)) throw new Error('FEEDBACK_TYPE_INVALID');
  let m = (await getMeta(questionId)) ?? baseMeta(questionId, 'manual');
  m.feedback[type] = (m.feedback[type] ?? 0) + 1;
  // "report count" for auto-retire = explicit reports + wrong-answer + duplicate flags.
  const reports = (m.feedback.report ?? 0) + (m.feedback.wrongAnswer ?? 0) + (m.feedback.duplicate ?? 0);
  m.reportCount = reports;
  let retired = false;
  if (reports >= autoRetireReports() && m.stage !== 'retired') {
    const q = await repositories.questions.findById(questionId);
    if (q && q.status === 'approved') { q.status = 'archived'; await repositories.questions.save(q); }
    m.stage = 'retired'; retired = true;
    logger.warn('question_auto_retired', { questionId, reports });
  }
  await saveMeta(m);
  return { reportCount: reports, retired };
}

export async function listPipeline(stage?: string, limit = 100): Promise<Array<PipelineMeta & { question?: Question }>> {
  const pool = pg();
  let metas: PipelineMeta[];
  if (!pool) { metas = [...mem.values()]; }
  else { await ensure(pool); const { rows } = await pool.query(stage ? 'SELECT * FROM question_pipeline WHERE stage=$1 ORDER BY updated_at DESC LIMIT $2' : 'SELECT * FROM question_pipeline ORDER BY updated_at DESC LIMIT $1', stage ? [stage, limit] : [limit]); metas = rows.map(fromRow); }
  if (stage && !pool) metas = metas.filter((m) => m.stage === stage);
  const out = [];
  for (const m of metas.slice(0, limit)) { const q = await repositories.questions.findById(m.questionId).catch(() => null); out.push({ ...m, question: q ?? undefined }); }
  return out;
}
