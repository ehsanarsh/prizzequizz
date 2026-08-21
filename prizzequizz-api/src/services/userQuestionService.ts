/* QUESTIONS WRITTEN BY PLAYERS.
 *
 * The game had a «تولید سوال» screen that showed a success message and threw
 * the question away — nothing was sent, nothing was stored, and no operator
 * ever saw it. This is the missing half: a submission goes into the same
 * question pipeline the panel already reviews, tagged with who wrote it, and
 * approving it pays them.
 *
 * The payment is the part worth being careful about:
 *
 *   — it happens ONCE per question. An operator who clicks approve twice, or
 *     a retried request, must not pay twice, so the reward is recorded against
 *     the question and a second approval pays nothing.
 *
 *   — it is random, but it is not Math.random. These are real prizes, so the
 *     draw uses the same crypto-backed weighted pick the wheel uses.
 *
 *   — "every question" and "one in every N" are both allowed, because paying
 *     for every single question is an invitation to farm the thing.
 */
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';
import { createDraft, approve as pipelineApprove, reject as pipelineReject } from './questionPipelineService.js';
import { grantReward, type RewardType } from './rewardsService.js';
import { logger } from './logger.js';
import { randomInt } from 'node:crypto';
import { makerCategoryList, allCategoryNames, MAKER_EXCLUDED } from './configService.js';

export class UserQuestionError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'UserQuestionError'; }
}

export interface QuizMakerPrize {
  type: RewardType;          // coins | xp | cash | ticket | lifeline | heart | nothing
  target?: string;           // ticket tier / lifeline key
  min: number;
  max: number;
  weight: number;
  label: string;
  icon: string;
}
export interface QuizMakerConfig {
  enabled: boolean;
  /** 'each' pays for every approved question; 'everyN' pays one in N. */
  mode: 'each' | 'everyN';
  n: number;
  prizes: QuizMakerPrize[];
}

export const QUIZ_MAKER_DEFAULTS: QuizMakerConfig = {
  enabled: true,
  mode: 'each',
  n: 10,
  prizes: [
    { type: 'coins', min: 50, max: 250, weight: 55, label: 'سکه', icon: '🪙' },
    { type: 'xp', min: 20, max: 120, weight: 25, label: 'XP', icon: '⚡' },
    { type: 'ticket', target: 'green', min: 1, max: 1, weight: 12, label: 'بلیط', icon: '🎫' },
    { type: 'cash', min: 5000, max: 50000, weight: 8, label: 'جایزهٔ نقدی', icon: '💰' }
  ]
};

const CFG_KEY = 'quiz_maker';
let memCfg: QuizMakerConfig | null = null;

/* The panel's settings live beside every other persisted setting, in
 * app_config. A failed read falls back to the defaults rather than to nothing:
 * a config table hiccup must not stop a question being reviewed. */
async function readCfg(): Promise<Partial<QuizMakerConfig>> {
  const pool = pg();
  if (pool) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS app_config (key VARCHAR(64) PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMP NOT NULL DEFAULT now(), updated_by VARCHAR(64))`);
      const { rows: r } = await pool.query(`SELECT value FROM app_config WHERE key=$1`, [CFG_KEY]);
      if (r[0]?.value) return r[0].value as Partial<QuizMakerConfig>;
      return {};
    } catch (e) { logger.warn('quiz_maker_config_read_failed', { message: (e as Error).message }); }
  }
  return memCfg ?? {};
}
async function writeCfg(next: QuizMakerConfig): Promise<void> {
  memCfg = next;
  const pool = pg();
  if (!pool) return;
  try {
    await pool.query(`INSERT INTO app_config(key,value,updated_at) VALUES ($1,$2,now())
                      ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`, [CFG_KEY, JSON.stringify(next)]);
  } catch (e) { logger.warn('quiz_maker_config_write_failed', { message: (e as Error).message }); }
}

export async function getQuizMakerConfig(): Promise<QuizMakerConfig> {
  const c = await readCfg();
  const prizes = Array.isArray(c.prizes) && c.prizes.length ? c.prizes : QUIZ_MAKER_DEFAULTS.prizes;
  return {
    enabled: c.enabled !== false,
    mode: c.mode === 'everyN' ? 'everyN' : 'each',
    n: Math.max(2, Math.min(100, Number(c.n) || QUIZ_MAKER_DEFAULTS.n)),
    prizes: prizes.map((p) => ({
      type: p.type, target: p.target,
      min: Math.max(0, Number(p.min) || 0),
      max: Math.max(0, Number(p.max) || 0),
      weight: Math.max(0, Number(p.weight) || 0),
      label: String(p.label || ''), icon: String(p.icon || '🎁')
    }))
  };
}
export async function setQuizMakerConfig(patch: Partial<QuizMakerConfig>): Promise<QuizMakerConfig> {
  const cur = await getQuizMakerConfig();
  const next: QuizMakerConfig = {
    enabled: patch.enabled != null ? !!patch.enabled : cur.enabled,
    mode: patch.mode === 'everyN' ? 'everyN' : (patch.mode === 'each' ? 'each' : cur.mode),
    n: patch.n != null ? Math.max(2, Math.min(100, Number(patch.n) || cur.n)) : cur.n,
    prizes: Array.isArray(patch.prizes) && patch.prizes.length ? patch.prizes as QuizMakerPrize[] : cur.prizes
  };
  await writeCfg(next);
  return getQuizMakerConfig();
}

/* ── storage ──────────────────────────────────────────────────────────── */

export interface UserQuestion {
  questionId: string;
  userId: string;
  username?: string;
  text: string;
  options: string[];
  correctIndex: number;
  category: string;
  difficulty: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  reviewedAt?: string | null;
  reward?: { type: string; amount: number; label: string; icon: string } | null;
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _ready = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<boolean> {
  if (_ready) return true;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS user_questions (
      question_id TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_at TIMESTAMPTZ,
      reward      JSONB)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_questions_status ON user_questions(status, created_at DESC)`);
    _ready = true;
    return true;
  } catch (e) {
    logger.warn('user_questions_schema_failed', { message: (e as Error).message });
    return false;
  }
}

interface MemRow { questionId: string; userId: string; status: UserQuestion['status']; createdAt: string; reviewedAt?: string; reward?: any }
const mem: MemRow[] = [];
/** Test seam. */
export function _resetUserQuestions(): void { mem.length = 0; _ready = false; }

/* ── submitting ───────────────────────────────────────────────────────── */

export async function submitQuestion(input: {
  userId: string; text: string; options: string[]; correctIndex: number;
  category?: string; difficulty?: string;
}): Promise<{ questionId: string }> {
  const text = String(input.text ?? '').trim();
  const options = (input.options || []).map((o) => String(o ?? '').trim()).filter(Boolean);
  if (text.length < 8) throw new UserQuestionError('TEXT_TOO_SHORT', 'متن سؤال خیلی کوتاه است.');
  if (options.length < 4) throw new UserQuestionError('OPTIONS_REQUIRED', 'یک گزینهٔ درست و سه گزینهٔ نادرست لازم است.');
  /* Four identical options is not a question. */
  if (new Set(options.map((o) => o.replace(/\s+/g, ' ').toLowerCase())).size !== options.length) {
    throw new UserQuestionError('OPTIONS_DUPLICATE', 'گزینه‌ها نباید تکراری باشند.');
  }
  const correctIndex = Math.max(0, Math.min(options.length - 1, Number(input.correctIndex) || 0));

  /* A TOPIC THE OPERATOR HAS CLOSED IS CLOSED HERE TOO.
   *
   * The panel decides which topics the quiz maker offers; a list the client
   * merely draws from is a suggestion, not a rule, so the same answer is given
   * again here. What is refused is precisely a topic this config KNOWS and does
   * not allow — switched off, or one of the two that are never subjects. A name
   * the config has never heard of is left alone: an older client, a renamed
   * category, a question written before the topics moved, and every one of them
   * still lands in the same review queue a person reads. */
  const category = String(input.category ?? '').trim();
  if (category) {
    const known = new Set([...allCategoryNames(), ...MAKER_EXCLUDED]);
    const allowed = new Set(makerCategoryList().map((c) => c.name));
    if (known.has(category) && !allowed.has(category)) {
      throw new UserQuestionError('CATEGORY_NOT_ALLOWED', 'برای این موضوع فعلاً سؤال پذیرفته نمی‌شود.');
    }
  }

  const q = await createDraft({
    text, options, correctIndex,
    category: category || 'عمومی',
    difficulty: input.difficulty || 'medium',
    source: 'manual',
    sourceRef: 'player:' + input.userId
  });

  const row: MemRow = { questionId: q.id, userId: input.userId, status: 'pending', createdAt: new Date().toISOString() };
  const pool = pg();
  if (pool && await ensureSchema(pool)) {
    await pool.query(`INSERT INTO user_questions(question_id,user_id,status) VALUES ($1,$2,'pending')
                      ON CONFLICT (question_id) DO NOTHING`, [q.id, input.userId]);
  } else {
    mem.push(row);
  }
  return { questionId: q.id };
}

async function rows(status?: string, limit = 200): Promise<MemRow[]> {
  const pool = pg();
  if (pool && await ensureSchema(pool)) {
    const where = status && status !== 'all' ? 'WHERE status=$1' : '';
    const args = status && status !== 'all' ? [status, limit] : [limit];
    const { rows: r } = await pool.query(
      `SELECT question_id,user_id,status,created_at,reviewed_at,reward FROM user_questions ${where}
       ORDER BY created_at DESC LIMIT $${args.length}`, args);
    return r.map((x: any) => ({
      questionId: x.question_id, userId: x.user_id, status: x.status,
      createdAt: x.created_at?.toISOString?.() ?? String(x.created_at),
      reviewedAt: x.reviewed_at?.toISOString?.() ?? undefined,
      reward: x.reward ?? undefined
    }));
  }
  return mem
    .filter((m) => !status || status === 'all' || m.status === status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

/** The panel's list: the submission joined to the question itself. */
export async function listSubmissions(opts: { status?: string; limit?: number } = {}): Promise<UserQuestion[]> {
  const list = await rows(opts.status, opts.limit ?? 200);
  const out: UserQuestion[] = [];
  for (const r of list) {
    const q = await repositories.questions.findById(r.questionId).catch(() => null);
    const u = await repositories.users.findById(r.userId).catch(() => null);
    out.push({
      questionId: r.questionId, userId: r.userId, username: u?.username,
      text: q?.text ?? '(سؤال پیدا نشد)', options: q?.options ?? [],
      correctIndex: q?.correctIndex ?? 0,
      category: q?.category ?? '—', difficulty: String(q?.difficulty ?? '—'),
      status: r.status, createdAt: r.createdAt, reviewedAt: r.reviewedAt ?? null,
      reward: r.reward ?? null
    });
  }
  return out;
}

export async function submissionCounts(): Promise<{ pending: number; approved: number; rejected: number }> {
  const all = await rows('all', 5000);
  return {
    pending: all.filter((r) => r.status === 'pending').length,
    approved: all.filter((r) => r.status === 'approved').length,
    rejected: all.filter((r) => r.status === 'rejected').length
  };
}

/* ── the draw ─────────────────────────────────────────────────────────── */

/** Weighted pick, crypto-backed — this decides real prizes. */
export function pickPrize(prizes: QuizMakerPrize[]): QuizMakerPrize | null {
  const live = prizes.filter((p) => p.weight > 0);
  if (!live.length) return null;
  const scale = 1_000_000;
  const total = live.reduce((n, p) => n + p.weight, 0);
  let roll = randomInt(0, Math.max(1, Math.round(total * scale)));
  for (const p of live) {
    roll -= Math.round(p.weight * scale);
    if (roll < 0) return p;
  }
  return live[live.length - 1]!;
}

export function prizeAmount(p: QuizMakerPrize): number {
  const lo = Math.min(p.min, p.max), hi = Math.max(p.min, p.max);
  if (hi <= lo) return Math.max(0, Math.floor(lo));
  return randomInt(Math.floor(lo), Math.floor(hi) + 1);
}

/* ── reviewing ────────────────────────────────────────────────────────── */

export interface ReviewResult {
  questionId: string;
  status: 'approved' | 'rejected';
  rewarded: boolean;
  reward?: { type: string; amount: number; label: string; icon: string } | null;
  reason?: string;
}

/**
 * Approve or reject a player's question. Approving publishes it into the bank
 * and — depending on the configured mode — pays the author.
 */
export async function reviewSubmission(questionId: string, action: 'approve' | 'reject'): Promise<ReviewResult> {
  const list = await rows('all', 5000);
  const row = list.find((r) => r.questionId === questionId);
  if (!row) throw new UserQuestionError('NOT_FOUND', 'این سؤال در فهرست کوییزساز نیست.');

  if (action === 'reject') {
    await pipelineReject(questionId);
    await mark(questionId, 'rejected', null);
    return { questionId, status: 'rejected', rewarded: false };
  }

  /* Already approved: publishing again is harmless, paying again is not. */
  const alreadyPaid = !!row.reward;
  await pipelineApprove(questionId);
  if (row.status === 'approved') {
    await mark(questionId, 'approved', row.reward ?? null);
    return { questionId, status: 'approved', rewarded: false, reward: row.reward ?? null, reason: alreadyPaid ? 'ALREADY_REWARDED' : 'ALREADY_APPROVED' };
  }

  const cfg = await getQuizMakerConfig();
  let reward: ReviewResult['reward'] = null;
  let reason: string | undefined;

  if (!cfg.enabled) {
    reason = 'REWARDS_OFF';
  } else if (cfg.mode === 'everyN') {
    /* Count how many of this author's questions were approved before this one.
       Every Nth approval pays; the rest publish for free. */
    const mine = list.filter((r) => r.userId === row.userId && r.status === 'approved').length;
    if ((mine + 1) % cfg.n !== 0) reason = 'NOT_THIS_ONE';
  }

  if (!reason) {
    const p = pickPrize(cfg.prizes);
    if (!p) { reason = 'NO_PRIZES'; }
    else {
      const amount = prizeAmount(p);
      const g = await grantReward(row.userId, {
        type: p.type, amount, target: p.target || '',
        label: p.label || 'جایزهٔ کوییزساز', icon: p.icon || '🎁'
      }, 'quizmaker:' + questionId);
      reward = { type: g.type, amount: g.amount, label: g.label, icon: g.icon };
    }
  }

  await mark(questionId, 'approved', reward);
  return { questionId, status: 'approved', rewarded: !!reward, reward, reason };
}

async function mark(questionId: string, status: UserQuestion['status'], reward: any): Promise<void> {
  const pool = pg();
  if (pool && await ensureSchema(pool)) {
    await pool.query(`UPDATE user_questions SET status=$2, reviewed_at=now(), reward=COALESCE($3::jsonb, reward) WHERE question_id=$1`,
      [questionId, status, reward ? JSON.stringify(reward) : null]);
    return;
  }
  const r = mem.find((x) => x.questionId === questionId);
  if (r) { r.status = status; r.reviewedAt = new Date().toISOString(); if (reward) r.reward = reward; }
}

/** What a player sees about their own submissions. */
export async function mySubmissions(userId: string, limit = 50): Promise<UserQuestion[]> {
  const all = await listSubmissions({ status: 'all', limit: 500 });
  return all.filter((x) => x.userId === userId).slice(0, limit);
}
