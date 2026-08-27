/* THE DESIGN'S OWN FILES — the stylesheet and the characters.
 *
 * These are not content. An operator never edits the stylesheet, and the
 * characters are the artwork the design is drawn around; putting either in the
 * database would mean a query on every page view for bytes that never change.
 * So they are files on disk, served straight from here with a long cache and a
 * strong ETag.
 *
 * That is the split, and it is the whole rule: anything an operator can change
 * lives in the database and is edited from the panel; anything only a designer
 * changes lives here and arrives with a deploy. A picture the operator uploads
 * is content and goes to /media/ as it always has — so a block asking for a
 * character takes either name, and neither one is special-cased.
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2'
};

/** Where the files are, whether running from src/ (tsx) or dist/ (node). */
function assetDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const p = resolve(dir, 'assets');
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
}

export interface Asset { body: Buffer; type: string; etag: string; }

/* Read once, then served from memory. These files are a megabyte between them
 * and every page asks for several — going to disk each time is a syscall per
 * character per visitor for bytes that cannot have changed. */
const cache = new Map<string, Asset | null>();

export function getAsset(name: string): Asset | null {
  /* A name, never a path. Anything with a slash or a dot-dot in it is not a
   * file this route is allowed to reach — the alternative is serving whatever
   * the URL asks for, which is how a static route reads /etc/passwd. */
  if (!/^[a-zA-Z0-9._-]+$/.test(name) || name.includes('..')) return null;
  if (cache.has(name)) return cache.get(name) ?? null;
  const type = TYPES[extname(name).toLowerCase()];
  if (!type) { cache.set(name, null); return null; }
  const file = join(assetDir(), name);
  if (!existsSync(file)) { cache.set(name, null); return null; }
  const body = readFileSync(file);
  const asset: Asset = { body, type, etag: '"' + createHash('sha1').update(body).digest('hex').slice(0, 20) + '"' };
  cache.set(name, asset);
  return asset;
}

/** Every character the design ships, for the panel's picker. */
export function listCharacters(): string[] {
  try {
    return readdirSync(assetDir())
      .filter((f) => /^char-.*\.(png|webp)$/.test(f))
      .sort();
  } catch { return []; }
}

/** Tests only. */
export function _resetAssets(): void { cache.clear(); }
