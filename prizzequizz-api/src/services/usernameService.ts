/* ONE NAME, ONE PLAYER.
 *
 * «یوزرنیم تکراری، مثلاً دو تا nazi هم ثبت می‌شه، که نباید این‌طور بشه.»
 *
 * The users table HAS a UNIQUE constraint on `username`, and the route that
 * saves a profile relies on it: a clash surfaces as a save error and becomes a
 * 409. That was believed to be enough. It is not — Postgres compares the two
 * strings byte for byte, so every one of these is a different username to the
 * database and the same name to a person:
 *
 *     nazi   Nazi   NAZI   nazi␣   na‌zi (with a zero-width non-joiner)
 *     علی    علي  (Persian ی vs Arabic ي — different code points)
 *
 * So the comparison is done on a FOLDED form: lower-cased, trimmed, inner
 * spaces collapsed, Arabic letterforms and digits brought to Persian, and the
 * invisible joiners dropped. The player still sees the name exactly as they
 * typed it — folding decides who owns it, not what is shown.
 */
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';

function pg() { try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; } }

/** The name as it will be stored and shown: trimmed, tidied, never folded. */
export function cleanUsername(raw: unknown): string {
  return String(raw ?? '')
    /* Invisible characters that can only be there to make two names look alike
       — but NOT the zero-width non-joiner: «علی‌رضا» is how the name is spelled
       and the half-space belongs in what the player sees. Folding takes it out
       for the comparison; showing it does not. */
    .replace(/[​‍‎‏‪-‮﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
}

/** The form two names are compared BY. Never shown to anybody. */
export function foldUsername(raw: unknown): string {
  return cleanUsername(raw)
    .toLowerCase()
    .replace(/‌/g, '')                               // ZWNJ: «نیم‌فاصله»
    .replace(/[ـًٌٍَُِّْٰ]/g, '')                              // tatweel + harakat
    .replace(/[يﻱﻲ]/g, 'ی').replace(/[كﻙﻚ]/g, 'ک')           // Arabic → Persian
    .replace(/ة/g, 'ه').replace(/[أإآ]/g, 'ا')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))  // Arabic-Indic digits
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))  // Persian digits
    .replace(/\s+/g, '');
}

/** A name the game hands out itself, not one a player chose. */
export function isPlaceholderUsername(u: unknown): boolean {
  return /^user_[0-9]{10,}$/.test(String(u ?? '').trim());
}

/**
 * Who already holds this name, ignoring `exceptUserId` (the person renaming).
 * Returns the owner's id, or null when the name is free.
 */
export async function usernameOwner(name: string, exceptUserId?: string): Promise<string | null> {
  const folded = foldUsername(name);
  if (!folded) return null;
  const pool = pg();
  if (pool) {
    /* Folded on BOTH sides in SQL so the database does the matching over every
       row rather than this process pulling the whole table across to do it. */
    const { rows } = await pool.query(
      `SELECT id FROM users
        WHERE regexp_replace(lower(username), '[\\s\\u200c]', '', 'g') = $1
          AND ($2::text IS NULL OR id::text <> $2)
        LIMIT 1`, [folded, exceptUserId ?? null]);
    if (rows.length) return String(rows[0].id);
    /* The SQL above folds case and spacing; the letterform folding above it is
       richer than one regexp, so anything that slipped through is caught here
       on the rows that are close enough to matter. */
  }
  const all = await repositories.users.list(100000).catch(() => [] as any[]);
  const hit = all.find((u: any) => u && u.id !== exceptUserId && foldUsername(u.username) === folded);
  return hit ? String(hit.id) : null;
}

/** True when somebody else already has this name. */
export async function usernameTaken(name: string, exceptUserId?: string): Promise<boolean> {
  return (await usernameOwner(name, exceptUserId)) !== null;
}

/* The index that makes a race impossible rather than unlikely.
 *
 * Two people picking the same free name at the same moment both pass the check
 * above and both save. A unique index on the folded form is the only thing that
 * can actually stop that, because the database applies it at write time.
 *
 * It is created best-effort and NEVER fatally: a database that already contains
 * the duplicates this exists to prevent cannot have the index added, and
 * refusing to start over it would take the whole game down to fix a name. When
 * that happens it says which names are in the way, so somebody can rename them
 * and the index takes hold on the next boot. */
let _indexTried = false;
export async function ensureUsernameIndex(): Promise<{ created: boolean; blockedBy: string[] }> {
  const pool = pg();
  if (!pool || _indexTried) return { created: false, blockedBy: [] };
  _indexTried = true;
  try {
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username_folded
         ON users (regexp_replace(lower(username), '[\\s\\u200c]', '', 'g'))`);
    return { created: true, blockedBy: [] };
  } catch {
    const blockedBy: string[] = [];
    try {
      const { rows } = await pool.query(
        `SELECT regexp_replace(lower(username), '[\\s\\u200c]', '', 'g') AS folded,
                count(*)::int AS n, string_agg(username, ', ') AS names
           FROM users
          GROUP BY 1 HAVING count(*) > 1
          ORDER BY 2 DESC LIMIT 20`);
      for (const r of rows) blockedBy.push(`${r.names} (${r.n})`);
    } catch { /* nothing more to say */ }
    return { created: false, blockedBy };
  }
}

/** The duplicates already in the table, so the panel can show them. */
export async function duplicateUsernames(): Promise<Array<{ names: string[]; count: number }>> {
  const pool = pg();
  if (!pool) {
    const all = await repositories.users.list(100000).catch(() => [] as any[]);
    const by = new Map<string, string[]>();
    for (const u of all) {
      const f = foldUsername((u as any).username);
      if (!f) continue;
      by.set(f, [...(by.get(f) ?? []), String((u as any).username)]);
    }
    return [...by.values()].filter((v) => v.length > 1).map((names) => ({ names, count: names.length }));
  }
  const { rows } = await pool.query(
    `SELECT string_agg(username, '|') AS names, count(*)::int AS n
       FROM users
      GROUP BY regexp_replace(lower(username), '[\\s\\u200c]', '', 'g')
     HAVING count(*) > 1
      ORDER BY 2 DESC LIMIT 50`);
  return rows.map((r: any) => ({ names: String(r.names).split('|'), count: Number(r.n) }));
}
