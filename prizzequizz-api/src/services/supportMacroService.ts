/* THE THINGS SUPPORT SAYS TWENTY TIMES A DAY.
 *
 * «جملات آماده و قابل اضافه و تغییر و حذف کردن از همان پنل.»
 *
 * Canned replies live on the SERVER, not in one operator's browser: two people
 * answering tickets have to send the same wording, and an answer that has been
 * agreed on is worth keeping when the person who wrote it is off shift. They
 * are plain text with no templating beyond the placeholders below, which are
 * filled in by the panel as it inserts them — deliberately not a language,
 * because a macro nobody can read at a glance is a macro that ships mistakes.
 *
 *   {نام}   the player's display name
 *   {شناسه} the ticket's short id
 */
import { getPgPool } from '../database/postgres.js';
import { id } from '../utils/id.js';

export interface SupportMacro {
  id: string;
  title: string;      // what the operator scans for
  body: string;       // what gets inserted
  category: string;   // '' = shown for every ticket
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

const mem = new Map<string, SupportMacro>();
let _schemaReady = false;

async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS support_macros (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  /* Same rule as everywhere else in this codebase: CREATE TABLE IF NOT EXISTS
     does nothing to a table that already exists, so every column that could be
     added later is repeated here — see schemaUpgrade.test.ts. */
  for (const col of [
    `title TEXT NOT NULL DEFAULT ''`,
    `body TEXT NOT NULL DEFAULT ''`,
    `category TEXT NOT NULL DEFAULT ''`,
    `sort_order INT NOT NULL DEFAULT 0`,
    `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
    `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`
  ]) {
    await pool.query(`ALTER TABLE support_macros ADD COLUMN IF NOT EXISTS ${col}`);
  }
  _schemaReady = true;
}

const row = (r: any): SupportMacro => ({
  id: String(r.id), title: String(r.title || ''), body: String(r.body || ''),
  category: String(r.category || ''), sortOrder: Number(r.sort_order) || 0,
  createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString()
});

export class MacroError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function clean(input: { title?: unknown; body?: unknown; category?: unknown; sortOrder?: unknown }) {
  const title = String(input.title ?? '').trim().slice(0, 80);
  const body = String(input.body ?? '').trim().slice(0, 2000);
  if (!title) throw new MacroError('TITLE_REQUIRED', 'عنوان جملهٔ آماده لازم است.');
  if (!body) throw new MacroError('BODY_REQUIRED', 'متن جملهٔ آماده لازم است.');
  return { title, body, category: String(input.category ?? '').trim().slice(0, 40), sortOrder: Number(input.sortOrder) || 0 };
}

export async function listMacros(): Promise<SupportMacro[]> {
  const pool = pg();
  if (!pool) {
    return [...mem.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
  }
  await ensureSchema(pool);
  const { rows } = await pool.query(`SELECT * FROM support_macros ORDER BY sort_order, title`);
  return rows.map(row);
}

export async function createMacro(input: any): Promise<SupportMacro> {
  const c = clean(input);
  const now = new Date().toISOString();
  const m: SupportMacro = { id: id(), ...c, createdAt: now, updatedAt: now };
  const pool = pg();
  if (!pool) { mem.set(m.id, m); return m; }
  await ensureSchema(pool);
  await pool.query(
    `INSERT INTO support_macros(id,title,body,category,sort_order) VALUES ($1,$2,$3,$4,$5)`,
    [m.id, m.title, m.body, m.category, m.sortOrder]
  );
  return m;
}

export async function updateMacro(macroId: string, input: any): Promise<SupportMacro> {
  const c = clean(input);
  const pool = pg();
  if (!pool) {
    const cur = mem.get(macroId);
    if (!cur) throw new MacroError('MACRO_NOT_FOUND', 'این جمله پیدا نشد.');
    const next = { ...cur, ...c, updatedAt: new Date().toISOString() };
    mem.set(macroId, next);
    return next;
  }
  await ensureSchema(pool);
  const { rows } = await pool.query(
    `UPDATE support_macros SET title=$2, body=$3, category=$4, sort_order=$5, updated_at=now()
     WHERE id=$1 RETURNING *`,
    [macroId, c.title, c.body, c.category, c.sortOrder]
  );
  if (!rows[0]) throw new MacroError('MACRO_NOT_FOUND', 'این جمله پیدا نشد.');
  return row(rows[0]);
}

export async function deleteMacro(macroId: string): Promise<boolean> {
  const pool = pg();
  if (!pool) return mem.delete(macroId);
  await ensureSchema(pool);
  const { rowCount } = await pool.query(`DELETE FROM support_macros WHERE id=$1`, [macroId]);
  return (rowCount ?? 0) > 0;
}

/** Test seam. */
export function _resetMacros(): void { mem.clear(); _schemaReady = false; }
