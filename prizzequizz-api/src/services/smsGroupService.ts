/* LISTS OF NUMBERS, AND SENDING TO THEM.
 *
 * The panel could send one test message and run a campaign against segments of
 * registered players. What it could not do is the ordinary thing: keep a list
 * of numbers that are not players — a list of leads, a list of people who
 * asked to be told when something opens — and message it.
 *
 * A number is added ONE AT A TIME, because that is how somebody actually types
 * them: number, Enter, number, Enter. So `addNumber` is the primitive and the
 * bulk paste is built on top of it, rather than the other way round.
 *
 * Two things are enforced here rather than left to the operator:
 *
 *   NORMALISING. +989121112233, 00989121112233, 09121112233 and ۰۹۱۲۱۱۱۲۲۳۳
 *   are one person. Without this a list of two hundred "numbers" quietly
 *   contains the same forty people and they each get four messages.
 *
 *   THE BLACKLIST. Somebody who asked to stop being messaged must not be
 *   messaged because their number happened to be in a group. sendSms already
 *   refuses them, but they are also filtered before the send so the operator
 *   sees a truthful count of who will actually receive it.
 */
import { getPgPool } from '../database/postgres.js';
import { id } from '../utils/id.js';
import { logger } from './logger.js';
import { sendSms, listBlacklist } from './smsService.js';

export interface SmsGroup {
  id: string;
  name: string;
  note?: string;
  count: number;
  createdAt: string;
}

export class GroupError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'GroupError'; }
}

/* Persian and Arabic digits arrive from a copy-paste as often as ASCII ones. */
const DIGIT_MAP: Record<string, string> = {
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9'
};

/** One canonical form for one phone: 09xxxxxxxxx. Empty when it is not one. */
export function normalizePhone(raw: string): string {
  let s = String(raw ?? '').trim();
  s = s.replace(/[۰-۹٠-٩]/g, (d) => DIGIT_MAP[d] ?? d);
  s = s.replace(/[^\d+]/g, '');
  if (s.startsWith('+98')) s = '0' + s.slice(3);
  else if (s.startsWith('0098')) s = '0' + s.slice(4);
  else if (s.startsWith('98') && s.length === 12) s = '0' + s.slice(2);
  else if (s.startsWith('9') && s.length === 10) s = '0' + s;
  if (!/^09\d{9}$/.test(s)) return '';
  return s;
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS sms_groups (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sms_group_numbers (
    group_id TEXT NOT NULL, phone TEXT NOT NULL, label TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, phone))`);
  _schemaReady = true;
}

/* Memory fallback. */
const memGroups: Array<{ id: string; name: string; note?: string; createdAt: string }> = [];
const memNumbers: Array<{ groupId: string; phone: string; label?: string; createdAt: string }> = [];

/** Test seam. */
export function _resetGroups(): void { memGroups.length = 0; memNumbers.length = 0; _schemaReady = false; }

export async function listGroups(): Promise<SmsGroup[]> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(
      `SELECT g.id, g.name, g.note, g.created_at, count(n.phone)::int AS c
       FROM sms_groups g LEFT JOIN sms_group_numbers n ON n.group_id = g.id
       GROUP BY g.id ORDER BY g.created_at DESC`);
    return rows.map((r: any) => ({ id: r.id, name: r.name, note: r.note ?? undefined, count: Number(r.c) || 0, createdAt: r.created_at?.toISOString?.() ?? String(r.created_at) }));
  }
  return memGroups
    .map((g) => ({ ...g, count: memNumbers.filter((n) => n.groupId === g.id).length }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createGroup(name: string, note?: string): Promise<SmsGroup> {
  const nm = String(name ?? '').trim();
  if (!nm) throw new GroupError('NAME_REQUIRED', 'نام گروه را وارد کن.');
  const row = { id: id(), name: nm.slice(0, 80), note: note ? String(note).slice(0, 200) : undefined, createdAt: new Date().toISOString() };
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query('INSERT INTO sms_groups(id,name,note) VALUES ($1,$2,$3)', [row.id, row.name, row.note ?? null]);
  } else {
    memGroups.push(row);
  }
  return { ...row, count: 0 };
}

export async function renameGroup(groupId: string, name: string, note?: string): Promise<boolean> {
  const nm = String(name ?? '').trim();
  if (!nm) throw new GroupError('NAME_REQUIRED', 'نام گروه را وارد کن.');
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rowCount } = await pool.query('UPDATE sms_groups SET name=$2, note=$3 WHERE id=$1', [groupId, nm, note ?? null]);
    return (rowCount ?? 0) > 0;
  }
  const g = memGroups.find((x) => x.id === groupId);
  if (!g) return false;
  g.name = nm; g.note = note;
  return true;
}

export async function deleteGroup(groupId: string): Promise<boolean> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query('DELETE FROM sms_group_numbers WHERE group_id=$1', [groupId]);
    const { rowCount } = await pool.query('DELETE FROM sms_groups WHERE id=$1', [groupId]);
    return (rowCount ?? 0) > 0;
  }
  for (let i = memNumbers.length - 1; i >= 0; i--) if (memNumbers[i]!.groupId === groupId) memNumbers.splice(i, 1);
  const i = memGroups.findIndex((g) => g.id === groupId);
  if (i < 0) return false;
  memGroups.splice(i, 1);
  return true;
}

export interface AddResult { added: boolean; phone: string; duplicate: boolean; }

/** The primitive: one number, one Enter. */
export async function addNumber(groupId: string, raw: string, label?: string): Promise<AddResult> {
  const phone = normalizePhone(raw);
  if (!phone) throw new GroupError('PHONE_INVALID', 'شمارهٔ موبایل معتبر نیست. مثل ۰۹۱۲۱۲۳۴۵۶۷ وارد کن.');
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const g = await pool.query('SELECT 1 FROM sms_groups WHERE id=$1', [groupId]);
    if (!g.rows[0]) throw new GroupError('GROUP_NOT_FOUND', 'گروه پیدا نشد.');
    /* DO NOTHING rather than an error: typing the same number twice is a
     * normal slip, not a failure worth stopping the operator for. */
    const { rowCount } = await pool.query(
      'INSERT INTO sms_group_numbers(group_id,phone,label) VALUES ($1,$2,$3) ON CONFLICT (group_id, phone) DO NOTHING',
      [groupId, phone, label ?? null]);
    const added = (rowCount ?? 0) > 0;
    return { added, phone, duplicate: !added };
  }
  if (!memGroups.some((g) => g.id === groupId)) throw new GroupError('GROUP_NOT_FOUND', 'گروه پیدا نشد.');
  if (memNumbers.some((n) => n.groupId === groupId && n.phone === phone)) return { added: false, phone, duplicate: true };
  memNumbers.push({ groupId, phone, label, createdAt: new Date().toISOString() });
  return { added: true, phone, duplicate: false };
}

/** A pasted block, built on the same primitive so the rules cannot drift. */
export async function addNumbers(groupId: string, raw: string): Promise<{ added: number; duplicates: number; invalid: string[] }> {
  const parts = String(raw ?? '').split(/[\s,;\n\r\t]+/).filter(Boolean);
  let added = 0, duplicates = 0;
  const invalid: string[] = [];
  for (const p of parts) {
    try {
      const r = await addNumber(groupId, p);
      if (r.added) added++; else duplicates++;
    } catch (e) {
      if (e instanceof GroupError && e.code === 'PHONE_INVALID') { if (invalid.length < 20) invalid.push(p); continue; }
      throw e;
    }
  }
  return { added, duplicates, invalid };
}

export async function removeNumber(groupId: string, raw: string): Promise<boolean> {
  const phone = normalizePhone(raw) || String(raw ?? '').trim();
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rowCount } = await pool.query('DELETE FROM sms_group_numbers WHERE group_id=$1 AND phone=$2', [groupId, phone]);
    return (rowCount ?? 0) > 0;
  }
  const i = memNumbers.findIndex((n) => n.groupId === groupId && n.phone === phone);
  if (i < 0) return false;
  memNumbers.splice(i, 1);
  return true;
}

export async function listNumbers(groupId: string, limit = 500): Promise<Array<{ phone: string; label?: string; createdAt: string }>> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query('SELECT phone,label,created_at FROM sms_group_numbers WHERE group_id=$1 ORDER BY created_at DESC LIMIT $2', [groupId, Math.min(5000, limit)]);
    return rows.map((r: any) => ({ phone: r.phone, label: r.label ?? undefined, createdAt: r.created_at?.toISOString?.() ?? String(r.created_at) }));
  }
  return memNumbers.filter((n) => n.groupId === groupId).slice(-limit).reverse();
}

/* ---------------------------------------------------------------------------
 * Sending
 * ------------------------------------------------------------------------- */

export interface SendGroupResult {
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  /** The exact text one recipient received, so the operator can check it. */
  sample: string;
}

/** The message, with the site link appended once. */
export function composeMessage(text: string, link?: string): string {
  const body = String(text ?? '').trim();
  const url = String(link ?? '').trim();
  if (!url) return body;
  /* If the operator already pasted the link into the text, do not add it
   * twice — a doubled link in a 70-character SMS is expensive nonsense. */
  if (body.includes(url)) return body;
  return body + '\n' + url;
}

export async function sendToGroup(input: { groupId: string; text: string; link?: string }): Promise<SendGroupResult> {
  const body = composeMessage(input.text, input.link);
  if (!body) throw new GroupError('TEXT_REQUIRED', 'متن پیام را بنویس.');
  const numbers = await listNumbers(input.groupId, 5000);
  if (!numbers.length) throw new GroupError('GROUP_EMPTY', 'این گروه شماره‌ای ندارد.');

  /* Anyone who asked to stop is dropped BEFORE the send, so the count the
   * operator sees is the count of people who will really get it. */
  const blocked = new Set((await listBlacklist().catch(() => [])).map((b: any) => normalizePhone(b.number) || b.number));
  let sent = 0, failed = 0, skipped = 0;
  for (const n of numbers) {
    if (blocked.has(n.phone)) { skipped++; continue; }
    try {
      const r = await sendSms(n.phone, body, 'group_broadcast');
      if (r.status === 'sent') sent++;
      else if (r.status === 'blocked' || r.status === 'disabled') skipped++;
      else failed++;
    } catch (e) {
      /* One bad number must not end the send for everybody else. */
      failed++;
      logger.warn('sms_group_send_failed', { phone: n.phone, message: e instanceof Error ? e.message : 'unknown' });
    }
  }
  logger.info('sms_group_sent', { groupId: input.groupId, total: numbers.length, sent, failed, skipped });
  return { total: numbers.length, sent, failed, skipped, sample: body };
}
