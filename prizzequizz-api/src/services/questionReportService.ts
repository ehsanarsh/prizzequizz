/* PLAYER QUESTION REPORTS
 * A player can report a problem with a question they just saw in a match. Each
 * report is stored individually (question + reason + optional note + who + which
 * match) so an admin gets a real review queue in the panel — not just a counter.
 * Persisted in Postgres (survives restarts) with a memory fallback for the dev
 * driver. We also forward the report to the pipeline's feedback counter so the
 * existing auto-retire threshold keeps working. */
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';
import { recordFeedback } from './questionPipelineService.js';
import { logger } from './logger.js';
import { id } from '../utils/id.js';

// Preset reasons the client offers. Keep in sync with the client sheet + admin
// labels. `label` is the Persian text shown to admins if the client sends only
// the code.
export const REPORT_REASONS: Array<{ code: string; label: string; feedback: 'wrongAnswer' | 'duplicate' | 'report' }> = [
  { code: 'wrong_answer',   label: 'پاسخِ درست اشتباه است',        feedback: 'wrongAnswer' },
  { code: 'typo',           label: 'غلط املایی یا نگارشی',          feedback: 'report' },
  { code: 'unclear',        label: 'سؤال مبهم یا نامفهوم است',       feedback: 'report' },
  { code: 'duplicate',      label: 'سؤال تکراری است',               feedback: 'duplicate' },
  { code: 'offensive',      label: 'محتوای نامناسب یا توهین‌آمیز',   feedback: 'report' },
  { code: 'wrong_category', label: 'موضوع سؤال اشتباه است',          feedback: 'report' },
  { code: 'outdated',       label: 'اطلاعات قدیمی یا نادرست',        feedback: 'report' },
  { code: 'other',          label: 'دلیل دیگر',                     feedback: 'report' }
];

function reasonInfo(code: string) { return REPORT_REASONS.find((r) => r.code === code); }
export function reasonLabel(code: string): string { return reasonInfo(code)?.label ?? code; }

export interface QuestionReport {
  id: string;
  questionId: string;
  matchId?: string;
  userId?: string;
  reason: string;          // reason code
  reasonLabel: string;     // resolved Persian label (denormalized for admin display)
  note?: string;
  questionText?: string;   // snapshot of the question text at report time
  category?: string;
  status: 'open' | 'resolved' | 'dismissed';
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  // IDs are stored as TEXT (not UUID) so a report can never fail to insert on a
  // type mismatch — reports must be captured no matter what id shape the client
  // sends.
  await pool.query(`CREATE TABLE IF NOT EXISTS question_reports (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    match_id TEXT,
    user_id TEXT,
    reason VARCHAR(32) NOT NULL,
    reason_label VARCHAR(120),
    note TEXT,
    question_text TEXT,
    category VARCHAR(120),
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    resolved_by VARCHAR(64))`);
  // If an earlier build created the table with UUID columns, widen them to TEXT
  // so real inserts never break. Each ALTER is independent and safe to re-run.
  for (const col of ['id', 'question_id', 'match_id', 'user_id']) {
    try { await pool.query(`ALTER TABLE question_reports ALTER COLUMN ${col} TYPE TEXT USING ${col}::text`); } catch { /* already text / fine */ }
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_question_reports_status_time ON question_reports(status, created_at DESC)`);
  _schemaReady = true;
}

const mem: QuestionReport[] = [];

function rowToReport(r: any): QuestionReport {
  return {
    id: r.id, questionId: r.question_id, matchId: r.match_id ?? undefined, userId: r.user_id ?? undefined,
    reason: r.reason, reasonLabel: r.reason_label ?? reasonLabel(r.reason), note: r.note ?? undefined,
    questionText: r.question_text ?? undefined, category: r.category ?? undefined, status: r.status,
    createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    resolvedAt: r.resolved_at?.toISOString?.() ?? (r.resolved_at ?? undefined),
    resolvedBy: r.resolved_by ?? undefined
  };
}

export async function createReport(input: {
  questionId: string; matchId?: string; userId?: string; reason: string; note?: string;
}): Promise<QuestionReport> {
  const questionId = String(input.questionId ?? '').trim();
  if (!questionId) throw new Error('QUESTION_ID_REQUIRED');
  const info = reasonInfo(String(input.reason ?? ''));
  if (!info) throw new Error('REASON_INVALID');
  // Snapshot the question so the admin queue reads well even if the question is
  // later edited or removed.
  const q = await repositories.questions.findById(questionId).catch(() => null);
  const row: QuestionReport = {
    id: id(), questionId, matchId: input.matchId || undefined, userId: input.userId || undefined,
    reason: info.code, reasonLabel: info.label, note: (input.note ?? '').toString().slice(0, 500) || undefined,
    questionText: q?.text?.slice(0, 400), category: q?.category, status: 'open', createdAt: new Date().toISOString()
  };
  const pool = pg();
  if (pool) {
    try {
      await ensureSchema(pool);
      await pool.query(
        `INSERT INTO question_reports(id,question_id,match_id,user_id,reason,reason_label,note,question_text,category,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open')`,
        [row.id, row.questionId, row.matchId ?? null, row.userId ?? null, row.reason, row.reasonLabel, row.note ?? null, row.questionText ?? null, row.category ?? null]);
    } catch (e) {
      // Never lose a report on a DB hiccup — log the real cause and keep it in
      // memory so it still surfaces to the admin this process lifetime.
      logger.warn('question_report_db_insert_failed', { questionId, message: e instanceof Error ? e.message : 'unknown' });
      mem.unshift(row);
    }
  } else {
    mem.unshift(row);
  }
  // Keep the existing auto-retire counter honest.
  try { await recordFeedback(questionId, info.feedback); } catch { /* pipeline optional */ }
  logger.info('question_report_created', { id: row.id, questionId, reason: row.reason, matchId: row.matchId });
  return row;
}

export async function listReports(status = 'open', limit = 200): Promise<QuestionReport[]> {
  const lim = Math.min(500, Math.max(1, limit));
  const memFiltered = status && status !== 'all' ? mem.filter((r) => r.status === status) : mem.slice();
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = status && status !== 'all'
      ? await pool.query(`SELECT * FROM question_reports WHERE status=$1 ORDER BY created_at DESC LIMIT ${lim}`, [status])
      : await pool.query(`SELECT * FROM question_reports ORDER BY created_at DESC LIMIT ${lim}`);
    const dbRows = rows.map(rowToReport);
    // Merge any memory-fallback reports (from a transient DB insert failure) that
    // aren't already in the DB result, newest first.
    const seen = new Set(dbRows.map((r) => r.id));
    const extra = memFiltered.filter((r) => !seen.has(r.id));
    return [...extra, ...dbRows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, lim);
  }
  return memFiltered.slice(0, lim);
}

export async function reportCounts(): Promise<{ open: number; resolved: number; dismissed: number; total: number }> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT status, COUNT(*)::int AS n FROM question_reports GROUP BY status`);
    const map: Record<string, number> = {};
    for (const r of rows) map[r.status] = Number(r.n);
    return { open: map.open ?? 0, resolved: map.resolved ?? 0, dismissed: map.dismissed ?? 0, total: (map.open ?? 0) + (map.resolved ?? 0) + (map.dismissed ?? 0) };
  }
  return {
    open: mem.filter((r) => r.status === 'open').length,
    resolved: mem.filter((r) => r.status === 'resolved').length,
    dismissed: mem.filter((r) => r.status === 'dismissed').length,
    total: mem.length
  };
}

export async function setReportStatus(reportId: string, status: 'resolved' | 'dismissed', by?: string): Promise<boolean> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rowCount } = await pool.query(`UPDATE question_reports SET status=$2, resolved_at=now(), resolved_by=$3 WHERE id=$1 AND status='open'`, [reportId, status, by ?? null]);
    return (rowCount ?? 0) > 0;
  }
  const r = mem.find((x) => x.id === reportId && x.status === 'open');
  if (!r) return false;
  r.status = status; r.resolvedAt = new Date().toISOString(); r.resolvedBy = by;
  return true;
}
