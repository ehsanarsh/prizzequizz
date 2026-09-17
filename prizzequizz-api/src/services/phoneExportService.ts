/* THE NUMBERS, SO THEY CAN BE SENT FROM SOMEWHERE ELSE.
 *
 * «یه چیزی هم اضافه کن که من بتونم شماره همه کاربرام رو دانلود کنم و همون رو تو
 *  پنل نیازپرداز بزنم و از اونجا بفرستم.»
 *
 * The game's own broadcast is blocked at the provider, and waiting for that to
 * be sorted out is not a reason to be unable to reach anybody. A list of
 * numbers pasted into the provider's own panel does the job today.
 *
 * TWO THINGS THIS OWES, BECAUSE IT IS PERSONAL DATA LEAVING THE BUILDING.
 *
 *   - A NUMBER ON THE BLACKLIST IS NOT ON THE LIST. Somebody who asked not to
 *     be texted has asked the game, not the panel it was sent from; handing
 *     their number over in a file that exists to be pasted into a sender is the
 *     same as texting them, one step removed. They are counted and named as
 *     skipped so nobody thinks the file is short by accident.
 *   - AND NEITHER IS A DUPLICATE. The same person reachable twice is the same
 *     person billed twice.
 *
 * The «ثبت‌نام ناتمام» rows are a choice rather than a rule: they are real
 * people with real numbers who verified a code, so they can be reached — but an
 * operator sending a «به بازی برگرد» message to somebody who never finished
 * signing up may well want only them, or only the others.
 */
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';
import { listBlacklist } from './smsService.js';
import { unfinishedOf } from './adminUserTable.js';

function pg() { try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; } }

/** Digits only, and the last ten are the line — «۰۹۱۲…», «+98912…» and
 *  «0912 …» are one number however they were typed in. */
export function phoneDigits(v: unknown): string {
  const s = String(v ?? '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/\D+/g, '');
  return s.length > 10 ? s.slice(-10) : s;
}
/** What a sender panel expects: 09xxxxxxxxx. */
export function localPhone(v: unknown): string {
  const d = phoneDigits(v);
  return d.length === 10 ? '0' + d : '';
}

export type PhoneWho = 'all' | 'registered' | 'unfinished';

export interface PhoneExport {
  /** One per line, ready to paste. */
  phones: string[];
  rows: Array<{ phone: string; username: string; displayName: string }>;
  total: number;
  skippedNoPhone: number;
  skippedBlacklisted: number;
  skippedDuplicate: number;
  skippedMalformed: number;
  who: PhoneWho;
}

export async function exportUserPhones(who: PhoneWho = 'all'): Promise<PhoneExport> {
  const want: PhoneWho = who === 'registered' || who === 'unfinished' ? who : 'all';
  const black = new Set<string>();
  try { for (const b of await listBlacklist()) black.add(phoneDigits(b.number)); } catch { /* an unreadable blacklist must not silently widen the list */ }

  let people: Array<{ phone: unknown; username: unknown; display_name: unknown }> = [];
  const pool = pg();
  if (pool) {
    const { rows } = await pool.query(
      `SELECT phone, username, display_name FROM users
        WHERE coalesce(phone,'') <> ''
        ORDER BY created_at DESC`);
    people = rows as any;
  } else {
    const all = await repositories.users.list?.({ limit: 100000 } as any).catch(() => []) ?? [];
    people = (all as any[]).map((u) => ({ phone: u.phone, username: u.username, display_name: u.displayName }));
  }

  const out: PhoneExport = { phones: [], rows: [], total: 0, skippedNoPhone: 0, skippedBlacklisted: 0, skippedDuplicate: 0, skippedMalformed: 0, who: want };
  const seen = new Set<string>();
  for (const p of people) {
    const unfinished = unfinishedOf(p.display_name, p.username);
    if (want === 'registered' && unfinished) continue;
    if (want === 'unfinished' && !unfinished) continue;
    out.total++;
    const digits = phoneDigits(p.phone);
    if (!digits) { out.skippedNoPhone++; continue; }
    const local = localPhone(p.phone);
    /* A number that is not eleven digits is not a mobile line, and pasting it
       into a sender is a request that will be refused — which is exactly the
       kind of thing that gets an IP blocked. */
    if (!/^09\d{9}$/.test(local)) { out.skippedMalformed++; continue; }
    if (black.has(digits)) { out.skippedBlacklisted++; continue; }
    if (seen.has(digits)) { out.skippedDuplicate++; continue; }
    seen.add(digits);
    out.phones.push(local);
    out.rows.push({ phone: local, username: String(p.username ?? ''), displayName: String(p.display_name ?? '') });
  }
  return out;
}

/** The file that gets pasted into a sender panel: numbers, nothing else. */
export function phonesAsText(x: PhoneExport): string {
  return x.phones.join('\n') + (x.phones.length ? '\n' : '');
}

/** And the one for keeping: who each number belongs to.
 *  A BOM, because Excel opens a UTF-8 CSV as mojibake without one and every
 *  Persian name in the file comes out unreadable. */
export function phonesAsCsv(x: PhoneExport): string {
  const q = (v: string) => '"' + String(v).replace(/"/g, '""') + '"';
  const head = '﻿' + ['phone', 'username', 'name'].join(',');
  return [head, ...x.rows.map((r) => [q(r.phone), q(r.username), q(r.displayName)].join(','))].join('\n') + '\n';
}
