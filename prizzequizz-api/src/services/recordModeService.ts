/* RECORD MODE — a standalone endless run for a personal best.
 *
 * Entering spends one real heart from the header — the same balance
 * heartService owns, so regeneration is applied before the check and a player
 * looking at five hearts is never told they have none.
 *
 * Inside, the run carries its own three: a wrong answer puts one out and the
 * run ends when the third goes. Those three are the run's, not the account's,
 * so a long session cannot drain what the rest of the game spends.
 *
 * Nothing else about the game moves: no XP, no cup, no coins, unless an
 * operator deliberately turns that on from the panel.
 *
 * Two ladders. The global one draws from every category at random; a category
 * one draws only from the category the player picked and has its own table.
 *
 * The server holds the run. The client is never told the correct index before
 * it answers, and the score it reports is not trusted — it is counted here,
 * because this is a leaderboard and a client-counted record is worth nothing.
 */
import { gameConfig } from '../core/config.js';
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';
import type { Question } from '../types/domain.js';
import { id } from '../utils/id.js';
import { HeartError, getHearts, spendHearts } from './heartService.js';
import { record as missionRecord } from './missionService.js';
import { categoryList } from './configService.js';
import { getQuestionDistribution, recordQuestionAnswer } from './questionStatsService.js';
import { categoryImageUrls } from './categoryImageService.js';
import { logger } from './logger.js';

export type RecordMode = 'global' | 'category';
export type RecordPeriod = 'day' | 'week' | 'month' | 'all';

/* Hearts here are the account's hearts — the ones in the header. An earlier
 * cut of this gave the run its own private three, which meant the number on
 * screen was not the number the player owns, and losing them changed nothing
 * they could see anywhere else. There is one heart balance in this game.
 *
 * A wrong answer spends one real heart and the run ends when the balance hits
 * zero, so entry costs nothing extra by default. */
/** Hearts inside a run. Separate from the account balance by design. */
export const RECORD_HEARTS = 3;

export interface RecordConfig {
  enabled: boolean;
  /** Record mode belongs to the friendly plan; the main plan only sets
   *  missions against it. */
  friendlyOnly: boolean;
  /** Charged on entry, on top of what wrong answers cost. Zero by default. */
  entryHearts: number;
  /** Hearts the run itself carries. */
  runHearts: number;
  /** Deliberately zero: record mode must not move the rest of the game.
   *  An operator can turn these on from the panel if that changes. */
  xpPerCorrect: number;
  xpPerRecord: number;
  cupPerRecord: number;
  coinsPerCorrect: number;
  /** A run nobody has touched for this long is abandoned and can be replaced. */
  staleMinutes: number;
}

export const RECORD_DEFAULTS: RecordConfig = {
  enabled: true, friendlyOnly: true, entryHearts: 1, runHearts: RECORD_HEARTS,
  xpPerCorrect: 0, xpPerRecord: 0, cupPerRecord: 0, coinsPerCorrect: 0,
  staleMinutes: 30
};

export interface RecordRun {
  id: string;
  userId: string;
  mode: RecordMode;
  category: string;
  /** The run's own hearts, not the account's. */
  hearts: number;
  score: number;
  correct: number;
  wrong: number;
  startedAt: number;
  lastSeenAt: number;
  endedAt: number | null;
  /** The question awaiting an answer, and what was already asked. */
  currentQuestionId: string | null;
  asked: string[];
  /** «انتخاب دوم» is armed: the next wrong answer is absorbed instead of
   *  costing a heart. Lives on the run, never on the client. */
  secondChance?: boolean;
  /** Which question it was spent on, so a run cannot arm it twice for one
   *  question by buying a second copy. */
  secondChanceUsedOn?: string | null;
  /** Where this run is on the difficulty ladder, and how many correct answers
   *  in a row it has at that step. See RECORD_LADDER. */
  level: number;
  streak: number;
}

export interface PublicQuestion {
  id: string;
  category: string;
  difficulty: string;
  text: string;
  options: string[];
}

export class RecordError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS record_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    score INT NOT NULL DEFAULT 0,
    correct INT NOT NULL DEFAULT 0,
    wrong INT NOT NULL DEFAULT 0,
    duration_ms BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  /* The leaderboard is "best run per player", filtered by date — so it reads
   * by (mode, category, created_at) and then groups. */
  await pool.query(`CREATE INDEX IF NOT EXISTS record_runs_board
    ON record_runs (mode, category, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS record_runs_user ON record_runs (user_id)`);
  _schemaReady = true;
}

/* Live runs are in memory on purpose: a run is worthless once the process that
 * was serving it is gone, and the finished record is what gets persisted. */
const _runs = new Map<string, RecordRun>();
let _memConfig: RecordConfig | null = null;

async function ensureConfigSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS record_config (
    id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
}
function normaliseConfig(raw: any): RecordConfig {
  const d = RECORD_DEFAULTS, c = raw && typeof raw === 'object' ? raw : {};
  const n = (v: any, dflt: number, max = 1e6) => Math.max(0, Math.min(max, Math.floor(Number(v ?? dflt) || 0)));
  return {
    enabled: c.enabled !== false,
    friendlyOnly: c.friendlyOnly !== false,
    entryHearts: n(c.entryHearts, d.entryHearts, 20),
    runHearts: Math.max(1, n(c.runHearts, d.runHearts, 20)),
    xpPerCorrect: n(c.xpPerCorrect, d.xpPerCorrect),
    xpPerRecord: n(c.xpPerRecord, d.xpPerRecord),
    cupPerRecord: n(c.cupPerRecord, d.cupPerRecord),
    coinsPerCorrect: n(c.coinsPerCorrect, d.coinsPerCorrect),
    staleMinutes: Math.max(1, n(c.staleMinutes, d.staleMinutes, 1440))
  };
}
export async function getRecordConfig(): Promise<RecordConfig> {
  const pool = pg();
  if (pool) {
    await ensureConfigSchema(pool);
    const { rows } = await pool.query(`SELECT data FROM record_config WHERE id='default'`);
    return normaliseConfig(rows[0]?.data);
  }
  return normaliseConfig(_memConfig);
}
export async function saveRecordConfig(patch: any): Promise<RecordConfig> {
  const next = normaliseConfig({ ...(await getRecordConfig()), ...(patch ?? {}) });
  const pool = pg();
  if (pool) {
    await ensureConfigSchema(pool);
    await pool.query(
      `INSERT INTO record_config(id,data,updated_at) VALUES('default',$1,now())
       ON CONFLICT (id) DO UPDATE SET data=$1, updated_at=now()`, [JSON.stringify(next)]);
  } else _memConfig = next;
  logger.info('record_config_saved', { enabled: next.enabled, entryHearts: next.entryHearts });
  return next;
}
interface StoredRecord { id: string; userId: string; mode: RecordMode; category: string; score: number; correct: number; wrong: number; durationMs: number; createdAt: number }
const _memRecords: StoredRecord[] = [];

// ------------------------------------------------------------- categories ----

/** Categories a record table can exist for: the real, enabled game topics. */
export function recordCategories(): { name: string; icon: string }[] {
  /* The shared topic list — the same one the duel and Last Survivor read, so a
   * topic added or renamed in the panel appears here with the same emoji and
   * artwork. (`role:'toss'` is the internal bank behind topic selection and is
   * filtered out there; it must never get a record table.) */
  return categoryList().map((c) => ({ name: c.name, icon: c.icon }));
}

// -------------------------------------------------------------- questions ----

/* THE LADDER.
 *
 * A run used to draw from the whole bank at random, so the second question
 * could be harder than the tenth and getting further meant nothing. It climbs
 * now: start easy, and every THREE correct answers in a row move up one step.
 *
 * A wrong answer holds you where you are — it does not push you back down and
 * it does not let you through. That is the point of the rule: the run gets
 * harder only by being earned, and a mistake costs a heart, not the level you
 * already reached. The streak restarts, so it is three more in a row from
 * there.
 */
export const RECORD_LADDER: Array<Question['difficulty']> = ['easy', 'medium', 'hard', 'veryhard'];
export const RECORD_STEP = 3;

/** What the ladder does to (level, streak) when an answer comes in. */
export function ladderAfter(level: number, streak: number, correct: boolean): { level: number; streak: number } {
  const top = RECORD_LADDER.length - 1;
  const lv = Math.max(0, Math.min(top, Math.floor(level) || 0));
  if (!correct) return { level: lv, streak: 0 };
  const next = streak + 1;
  if (next < RECORD_STEP) return { level: lv, streak: next };
  return { level: Math.min(top, lv + 1), streak: 0 };
}

async function pickQuestion(run: RecordRun): Promise<Question> {
  const all = await repositories.questions.listApproved();
  if (!all.length) throw new RecordError('NO_QUESTIONS', 'هنوز سؤالی برای این حالت ثبت نشده.');
  let pool = run.mode === 'category'
    ? all.filter((q) => String(q.category).trim() === run.category)
    : all;
  if (!pool.length) throw new RecordError('NO_QUESTIONS_IN_CATEGORY', 'برای این موضوع سؤالی ثبت نشده.');

  /* Do not repeat inside a run while there is anything left; a long run on a
   * small bank would otherwise start showing the same question again, which
   * turns the record into a memory test of one screen. */
  const fresh = pool.filter((q) => !run.asked.includes(q.id));
  if (fresh.length) pool = fresh;
  else run.asked = [];   // bank exhausted — start the cycle over

  /* The step this run has climbed to, then the nearest step that has anything
   * in it. A topic with no «سخت» questions must not end the run — it simply
   * gives what it has, nearest first. */
  const want = Math.max(0, Math.min(RECORD_LADDER.length - 1, run.level || 0));
  let tier = pool.filter((q) => q.difficulty === RECORD_LADDER[want]);
  for (let d = 1; !tier.length && d < RECORD_LADDER.length; d++) {
    const near = [RECORD_LADDER[want - d], RECORD_LADDER[want + d]].filter(Boolean);
    tier = pool.filter((q) => near.includes(q.difficulty));
  }
  if (tier.length) pool = tier;

  return pool[Math.floor(Math.random() * pool.length)]!;
}

const publicQuestion = (q: Question): PublicQuestion => ({
  id: q.id, category: q.category, difficulty: q.difficulty, text: q.text, options: q.options
});

// ------------------------------------------------------------------- run ----

export interface StartResult { run: PublicRun; question: PublicQuestion; heartsLeft: number }
export interface PublicRun { id: string; mode: RecordMode; category: string; hearts: number; score: number }

const toPublic = (r: RecordRun): PublicRun => ({ id: r.id, mode: r.mode, category: r.category, hearts: r.hearts, score: r.score });

export async function startRun(userId: string, mode: RecordMode, category = ''): Promise<StartResult> {
  const cat = String(category || '').trim();
  if (mode === 'category') {
    if (!cat) throw new RecordError('CATEGORY_REQUIRED', 'اول موضوع را انتخاب کن.');
    if (!recordCategories().some((c) => c.name === cat)) {
      throw new RecordError('UNKNOWN_CATEGORY', 'این موضوع وجود ندارد.');
    }
  }

  const cfg = await getRecordConfig();
  if (!cfg.enabled) throw new RecordError('RECORD_OFF', 'ثبت رکورد فعلاً غیرفعال است.');

  const user = await repositories.users.findById(userId);
  if (!user) throw new RecordError('USER_NOT_FOUND', 'کاربر پیدا نشد.');
  /* Read through heartService so anything earned back since the last visit is
   * credited BEFORE the check. Reading users.hearts directly is what told a
   * player with a full header row that they had none. */
  const purse = await getHearts(userId);
  if (purse.hearts < cfg.entryHearts) {
    throw new RecordError('INSUFFICIENT_HEARTS',
      'برای ورود به ثبت رکورد ' + cfg.entryHearts + ' قلب لازم داری.');
  }

  /* An older run belonging to this player is closed out rather than blocking a
   * new one. Refusing was wrong: a run abandoned by closing the app is never
   * finished by anybody, so the player was locked out of the mode permanently
   * with a message about a game they could no longer reach. */
  for (const r of [..._runs.values()]) {
    if (r.userId !== userId || r.endedAt) continue;
    const idle = Date.now() - r.lastSeenAt;
    if (idle >= cfg.staleMinutes * 60_000) { _runs.delete(r.id); continue; }
    await finishRun(r).catch(() => undefined);   // file what they had, then move on
    _runs.delete(r.id);
  }

  /* The check above passed, so this only fails when a second start raced this
   * one for the same last heart. That is still «قلب کافی نداری» to the player,
   * not a server error — translate it rather than letting HeartError escape
   * past the route's RecordError handler as a 500. */
  if (cfg.entryHearts > 0) {
    try { await spendHearts(userId, cfg.entryHearts); }
    catch (e) {
      if (e instanceof HeartError) {
        throw new RecordError('INSUFFICIENT_HEARTS',
          'برای ورود به ثبت رکورد ' + cfg.entryHearts + ' قلب لازم داری.');
      }
      throw e;
    }
  }

  const run: RecordRun = {
    id: id(), userId, mode, category: mode === 'category' ? cat : '',
    /* The run's own hearts — the account's are not touched again until the
     * next entry. */
    hearts: cfg.runHearts, score: 0, correct: 0, wrong: 0,
    startedAt: Date.now(), lastSeenAt: Date.now(), endedAt: null, currentQuestionId: null, asked: [],
    secondChance: false, secondChanceUsedOn: null,
    /* Every run starts at the bottom of the ladder. */
    level: 0, streak: 0
  };
  const q = await pickQuestion(run);
  run.currentQuestionId = q.id;
  run.asked.push(q.id);
  _runs.set(run.id, run);
  logger.info('record_run_started', { runId: run.id, userId, mode, category: run.category });
  /* Re-read: `user` was fetched before the entry charge, so its hearts field
   * is the pre-spend balance. Handing that back would leave the header one
   * heart too high until something else corrected it. */
  const left = await getHearts(userId).catch(() => ({ hearts: Number(user.hearts) || 0 }));
  return { run: toPublic(run), question: publicQuestion(q), heartsLeft: left.hearts };
}

export interface AnswerResult {
  correct: boolean;
  correctIndex: number;
  run: PublicRun;
  /** Present while the run continues. */
  question?: PublicQuestion;
  /** Present on the answer that ended the run. */
  result?: RunResult;
  /** The «انتخاب دوم» help absorbed this wrong answer: no heart was lost, the
   *  run did not move on, and the player may pick again from the SAME question.
   *  `correctIndex` is deliberately NOT filled in on this path — telling the
   *  client the answer here would turn the help into a free win. */
  retry?: boolean;
  /** The option that was just ruled out, so the client can grey it. */
  ruledOut?: number;
}

export async function answerRun(runId: string, userId: string, selectedIndex: number): Promise<AnswerResult> {
  const run = _runs.get(runId);
  if (!run || run.userId !== userId) throw new RecordError('RUN_NOT_FOUND', 'این بازی پیدا نشد.');
  if (run.endedAt) throw new RecordError('RUN_ENDED', 'این بازی تمام شده.');
  if (!run.currentQuestionId) throw new RecordError('NO_QUESTION', 'سؤالی برای پاسخ نیست.');

  const q = await repositories.questions.findById(run.currentQuestionId);
  if (!q) throw new RecordError('QUESTION_NOT_FOUND', 'سؤال پیدا نشد.');
  const correct = Number(selectedIndex) === q.correctIndex;
  run.lastSeenAt = Date.now();
  const cfg = await getRecordConfig();

  /* Feed the lifetime per-question tally that «درصد بقیه» reads. Record mode
   * was taking from that pool without ever putting anything back. A timeout
   * answers with an index past the end of the options, which is not a choice
   * anybody made, so it is not counted. */
  if (Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < q.options.length) {
    void recordQuestionAnswer(q.id, Number(selectedIndex));
  }

  /* «انتخاب دوم». Armed by the help, spent here, and only ever on a WRONG
   * first pick — a correct answer must not burn it. The heart is not taken and
   * the run does not advance: the same question stays up with the ruled-out
   * option greyed. Held on the run rather than in the client because a client
   * that could grant itself a retry could survive forever. */
  if (!correct && run.secondChance) {
    run.secondChance = false;
    run.secondChanceUsedOn = run.currentQuestionId;
    return { correct: false, correctIndex: -1, run: toPublic(run), retry: true, ruledOut: Number(selectedIndex) };
  }

  /* The ladder moves BEFORE the next question is drawn, so the step this
   * answer earned is the step the next question comes from. A second-chance
   * retry returns above and never reaches here — it is not an answer yet. */
  { const st = ladderAfter(run.level, run.streak, correct); run.level = st.level; run.streak = st.streak; }

  if (correct) {
    run.score += 1; run.correct += 1;
    /* Zero by default — record mode is not supposed to move the rest of the
     * game. These exist so an operator can decide otherwise from the panel. */
    if (cfg.xpPerCorrect > 0 || cfg.coinsPerCorrect > 0) {
      const u = await repositories.users.findById(userId);
      if (u) {
        if (cfg.xpPerCorrect > 0) u.xp = (Number(u.xp) || 0) + cfg.xpPerCorrect;
        if (cfg.coinsPerCorrect > 0) u.coins = (Number(u.coins) || 0) + cfg.coinsPerCorrect;
        await repositories.users.save(u);
      }
    }
  } else {
    run.wrong += 1;
    /* One of the run's three goes out. The account balance is untouched: the
     * heart it paid was spent at the door. */
    run.hearts = Math.max(0, run.hearts - 1);
  }

  if (run.hearts <= 0) {
    const result = await finishRun(run);
    return { correct, correctIndex: q.correctIndex, run: toPublic(run), result };
  }

  const next = await pickQuestion(run);
  run.currentQuestionId = next.id;
  run.asked.push(next.id);
  return { correct, correctIndex: q.correctIndex, run: toPublic(run), question: publicQuestion(next) };
}

export interface RunResult {
  runId: string;
  mode: RecordMode;
  category: string;
  score: number;
  correct: number;
  wrong: number;
  durationMs: number;
  createdAt: number;
  /** What this player's best was BEFORE this run. */
  previousBest: number;
  isPersonalBest: boolean;
  /** Where the run places on the all-time board for its ladder. */
  rank: number | null;
  totalPlayers: number;
}

async function finishRun(run: RecordRun): Promise<RunResult> {
  run.endedAt = Date.now();
  run.lastSeenAt = run.endedAt;
  const durationMs = run.endedAt - run.startedAt;
  const previousBest = await personalBest(run.userId, run.mode, run.category);

  const rec: StoredRecord = {
    id: run.id, userId: run.userId, mode: run.mode, category: run.category,
    score: run.score, correct: run.correct, wrong: run.wrong, durationMs, createdAt: run.endedAt
  };
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO record_runs(id,user_id,mode,category,score,correct,wrong,duration_ms,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9/1000.0))`,
      [rec.id, rec.userId, rec.mode, rec.category, rec.score, rec.correct, rec.wrong, rec.durationMs, rec.createdAt]);
  } else _memRecords.push(rec);

  /* Off by default; the panel decides whether a record touches XP or the cup. */
  const cfg = await getRecordConfig();
  if (run.score > previousBest && (cfg.xpPerRecord > 0 || cfg.cupPerRecord > 0)) {
    const u = await repositories.users.findById(run.userId);
    if (u) {
      if (cfg.xpPerRecord > 0) u.xp = (Number(u.xp) || 0) + cfg.xpPerRecord;
      if (cfg.cupPerRecord > 0) u.weeklyScore = (Number(u.weeklyScore) || 0) + cfg.cupPerRecord;
      await repositories.users.save(u);
    }
  }

  const board = await leaderboard({ mode: run.mode, category: run.category, period: 'all', limit: 100000 });
  const rank = board.rows.findIndex((r) => r.userId === run.userId && r.score >= run.score);
  logger.info('record_run_finished', { runId: run.id, userId: run.userId, mode: run.mode, category: run.category, score: run.score });

  /* Feed the mission engine. This is what makes «رکورد فوتبال را به ۱۰ برسان»
   * work: the mission reads the record directly, so a player in the main plan
   * can be set the goal and go to the friendly plan to meet it. Failures here
   * must never cost the player their run. */
  try {
    await missionRecord(run.userId, 'recordSet', 1);
    if (run.mode === 'category') await missionRecord(run.userId, 'recordValue', run.score, run.category);
    else await missionRecord(run.userId, 'recordGlobal', run.score);
    if (run.score > previousBest) {
      await missionRecord(run.userId, 'recordImproved', 1);
      await missionRecord(run.userId, 'recordsInOneDay', 1);
    }
    if (rank >= 0) await missionRecord(run.userId, 'recordRank', rank + 1);
    /* How many topics are above each interesting threshold. */
    for (const above of [20, 30]) {
      let n = 0;
      for (const c of recordCategories()) {
        if (await personalBest(run.userId, 'category', c.name) >= above) n++;
      }
      await missionRecord(run.userId, 'recordCategoriesAbove', n, String(above));
    }
  } catch (e) {
    logger.warn('mission_feed_failed', { userId: run.userId, error: e instanceof Error ? e.message : 'unknown' });
  }

  /* The run is kept briefly so the result screen can be re-read on a refresh,
   * then dropped — an ended run is not resumable. */
  setTimeout(() => _runs.delete(run.id), 60_000).unref?.();

  return {
    runId: run.id, mode: run.mode, category: run.category,
    score: run.score, correct: run.correct, wrong: run.wrong,
    durationMs, createdAt: rec.createdAt,
    previousBest, isPersonalBest: run.score > previousBest,
    rank: rank >= 0 ? rank + 1 : null, totalPlayers: board.total
  };
}

/** Two wrong option indexes for the 50/50 help, chosen here because the
 *  correct index never leaves the server before an answer. */
export async function fiftyFifty(runId: string, userId: string): Promise<{ remove: number[] }> {
  const run = _runs.get(runId);
  if (!run || run.userId !== userId) throw new RecordError('RUN_NOT_FOUND', 'این بازی پیدا نشد.');
  if (run.endedAt) throw new RecordError('RUN_ENDED', 'این بازی تمام شده.');
  if (!run.currentQuestionId) throw new RecordError('NO_QUESTION', 'سؤالی برای پاسخ نیست.');
  const q = await repositories.questions.findById(run.currentQuestionId);
  if (!q) throw new RecordError('QUESTION_NOT_FOUND', 'سؤال پیدا نشد.');
  const wrong: number[] = [];
  for (let i = 0; i < q.options.length; i++) if (i !== q.correctIndex) wrong.push(i);
  /* Shuffle so it is not always the same two that vanish. */
  for (let i = wrong.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [wrong[i], wrong[j]] = [wrong[j]!, wrong[i]!];
  }
  return { remove: wrong.slice(0, Math.max(0, q.options.length - 2)) };
}

/**
 * «انتخاب دوم» — arm the retry for the question on screen.
 *
 * Nothing is revealed here: the help does not say which option is right, it
 * only buys the run one wrong answer. Arming is refused when it is already
 * armed, or when it was already spent on THIS question, so buying a second
 * copy mid-question cannot stack two retries onto one answer.
 */
export async function armSecondChance(runId: string, userId: string): Promise<{ armed: boolean }> {
  const run = _runs.get(runId);
  if (!run || run.userId !== userId) throw new RecordError('RUN_NOT_FOUND', 'این بازی پیدا نشد.');
  if (run.endedAt) throw new RecordError('RUN_ENDED', 'این بازی تمام شده.');
  if (!run.currentQuestionId) throw new RecordError('NO_QUESTION', 'سؤالی برای پاسخ نیست.');
  if (run.secondChance) return { armed: true };                      // idempotent
  if (run.secondChanceUsedOn && run.secondChanceUsedOn === run.currentQuestionId) {
    throw new RecordError('SECOND_CHANCE_SPENT', 'برای این سؤال یک‌بار استفاده شده.');
  }
  run.secondChance = true;
  run.lastSeenAt = Date.now();
  return { armed: true };
}

/**
 * «درصد بقیه» — how everyone who has ever answered this question chose, from
 * the same lifetime tally the duel and Last Survivor read.
 *
 * Percentages only. Which option is correct is never part of the answer, so a
 * question nobody has answered yet returns an even split rather than a tell.
 */
export async function answerStats(runId: string, userId: string): Promise<{ percents: number[]; sample: number }> {
  const run = _runs.get(runId);
  if (!run || run.userId !== userId) throw new RecordError('RUN_NOT_FOUND', 'این بازی پیدا نشد.');
  if (run.endedAt) throw new RecordError('RUN_ENDED', 'این بازی تمام شده.');
  if (!run.currentQuestionId) throw new RecordError('NO_QUESTION', 'سؤالی برای پاسخ نیست.');
  const q = await repositories.questions.findById(run.currentQuestionId);
  if (!q) throw new RecordError('QUESTION_NOT_FOUND', 'سؤال پیدا نشد.');
  return getQuestionDistribution(run.currentQuestionId, q.options.length);
}

/** Leaving early: the three run hearts are gone, and the score still counts —
 *  it was played for. */
export async function quitRun(runId: string, userId: string): Promise<RunResult> {
  const run = _runs.get(runId);
  if (!run || run.userId !== userId) throw new RecordError('RUN_NOT_FOUND', 'این بازی پیدا نشد.');
  if (run.endedAt) throw new RecordError('RUN_ENDED', 'این بازی تمام شده.');
  run.hearts = 0;
  return finishRun(run);
}

export function getRun(runId: string, userId: string): RecordRun | null {
  const r = _runs.get(runId);
  return r && r.userId === userId ? r : null;
}

// ---------------------------------------------------------------- records ----

export async function personalBest(userId: string, mode: RecordMode, category = ''): Promise<number> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(
      `SELECT COALESCE(MAX(score),0) AS best FROM record_runs WHERE user_id=$1 AND mode=$2 AND category=$3`,
      [userId, mode, category]);
    return Number(rows[0]?.best ?? 0);
  }
  return _memRecords
    .filter((r) => r.userId === userId && r.mode === mode && r.category === category)
    .reduce((n, r) => Math.max(n, r.score), 0);
}

function periodStart(period: RecordPeriod, now = Date.now()): number {
  if (period === 'day') return now - 86_400_000;
  if (period === 'week') return now - 7 * 86_400_000;
  if (period === 'month') return now - 30 * 86_400_000;
  return 0;
}

export interface BoardRow {
  rank: number;
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  score: number;
  createdAt: number;
}
export interface Board {
  mode: RecordMode; category: string; period: RecordPeriod;
  rows: BoardRow[]; total: number;
  /** The caller's own placing, included even when far outside the page. */
  me: BoardRow | null;
}

export async function leaderboard(input: {
  mode: RecordMode; category?: string; period?: RecordPeriod; limit?: number; userId?: string;
}): Promise<Board> {
  const mode = input.mode;
  const category = String(input.category || '');
  const period: RecordPeriod = input.period ?? 'all';
  const limit = Math.max(1, Math.min(100000, input.limit ?? 100));
  const since = periodStart(period);

  /* One row per player — their BEST run inside the window, not every run, or a
   * player who played fifty times would fill the whole board. */
  let best: { userId: string; score: number; createdAt: number }[];
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (user_id) user_id, score, EXTRACT(EPOCH FROM created_at)*1000 AS created_ms
         FROM record_runs
        WHERE mode=$1 AND category=$2 AND created_at >= to_timestamp($3/1000.0)
        ORDER BY user_id, score DESC, created_at ASC`,
      [mode, category, since]);
    best = rows.map((r: any) => ({ userId: String(r.user_id), score: Number(r.score), createdAt: Number(r.created_ms) }));
  } else {
    const byUser = new Map<string, { userId: string; score: number; createdAt: number }>();
    for (const r of _memRecords) {
      if (r.mode !== mode || r.category !== category || r.createdAt < since) continue;
      const cur = byUser.get(r.userId);
      /* Ties go to whoever got there first. */
      if (!cur || r.score > cur.score || (r.score === cur.score && r.createdAt < cur.createdAt)) {
        byUser.set(r.userId, { userId: r.userId, score: r.score, createdAt: r.createdAt });
      }
    }
    best = [...byUser.values()];
  }

  best.sort((a, b) => b.score - a.score || a.createdAt - b.createdAt);

  const decorate = async (e: { userId: string; score: number; createdAt: number }, rank: number): Promise<BoardRow> => {
    const u = await repositories.users.findById(e.userId).catch(() => null);
    return {
      rank, userId: e.userId,
      username: String(u?.username ?? 'بازیکن'),
      displayName: String(u?.displayName ?? u?.username ?? 'بازیکن'),
      avatar: String((u as any)?.avatar ?? ''),
      score: e.score, createdAt: e.createdAt
    };
  };

  const rows = await Promise.all(best.slice(0, limit).map((e, i) => decorate(e, i + 1)));

  let me: BoardRow | null = null;
  if (input.userId) {
    const i = best.findIndex((e) => e.userId === input.userId);
    if (i >= 0) me = i < rows.length ? rows[i]! : await decorate(best[i]!, i + 1);
  }

  return { mode, category, period, rows, total: best.length, me };
}

/** Everything the record screen needs before a run starts. */
export async function overview(userId: string): Promise<{
  categories: { name: string; icon: string; best: number; worldBest: number }[];
  global: { best: number; worldBest: number };
  hearts: number;
  entryHearts: number;
  runHearts: number;
  enabled: boolean;
  friendlyOnly: boolean;
}> {
  const user = await repositories.users.findById(userId).catch(() => null);
  const cats = recordCategories();
  const globalBoard = await leaderboard({ mode: 'global', period: 'all', limit: 1 });
  /* Topic artwork, so this board shows the same picture as the duel and Last
   * Survivor pickers. Empty string when the admin has not uploaded one, and the
   * client draws the emoji instead. */
  const art = await categoryImageUrls().catch(() => ({} as Record<string, string>));
  const out = [];
  for (const c of cats) {
    const board = await leaderboard({ mode: 'category', category: c.name, period: 'all', limit: 1 });
    out.push({
      name: c.name, icon: c.icon, image: art[c.name] ?? '',
      best: await personalBest(userId, 'category', c.name),
      worldBest: board.rows[0]?.score ?? 0
    });
  }
  const cfg = await getRecordConfig();
  return {
    categories: out,
    global: { best: await personalBest(userId, 'global'), worldBest: globalBoard.rows[0]?.score ?? 0 },
    /* Through heartService, so the screen shows what the server will actually
     * accept — the two disagreeing is the whole bug this replaces. */
    hearts: (await getHearts(userId).catch(() => ({ hearts: Number(user?.hearts ?? 0) }))).hearts,
    entryHearts: cfg.entryHearts,
    runHearts: cfg.runHearts,
    enabled: cfg.enabled,
    friendlyOnly: cfg.friendlyOnly
  };
}

/** Test seam. */
export function _resetRecordMemory(): void { _runs.clear(); _memRecords.length = 0; }
export function _memRecordCount(): number { return _memRecords.length; }
