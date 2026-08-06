/* ONBOARDING — the welcome slides a player sees the first time in.
 *
 * Admin-managed rather than written into the client, because these are exactly
 * the thing a campaign wants to change: a Nowruz greeting, a new-mode
 * announcement, a seasonal character. Slides can be added, reordered, switched
 * off, or given a date window so a seasonal set appears and retires on its own.
 *
 * Artwork is a data URI, the same as the character roster, so the whole thing
 * ships in one JSON response and there are no image paths to keep in step.
 */
import { getPgPool } from '../database/postgres.js';
import { id } from '../utils/id.js';
import { logger } from './logger.js';

export interface OnboardingSlide {
  id: string;
  title: string;
  body: string;
  /** data: URI or an absolute URL. Empty means fall back to the emoji. */
  image: string;
  /** Shown when there is no artwork, and as the little badge on the card. */
  emoji: string;
  /** Accent colour behind the art. */
  color: string;
  enabled: boolean;
  /** Optional campaign window; empty means always. */
  startsAt: string;
  endsAt: string;
  sortOrder: number;
  updatedAt: string;
}

export const SLIDE_IMAGE_MAX_BYTES = 600 * 1024;

export class OnboardingError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/* The starting set. Each one is written for a specific character so the copy
 * and the picture say the same thing; the pictures themselves are uploaded from
 * the panel (see the hint in each description). */
export const ONBOARDING_DEFAULTS: Omit<OnboardingSlide, 'updatedAt'>[] = [
  { id: 'welcome', emoji: '🧙', color: '#8B5CF6', title: 'به پرایز کوییز خوش اومدی!',
    body: 'من راهنمای تو هستم. در چند قدم کوتاه بهت نشون می‌دم اینجا چطور بازی می‌کنی، جایزه می‌گیری و بالا می‌ری.',
    image: '', enabled: true, startsAt: '', endsAt: '', sortOrder: 1 },
  { id: 'coins', emoji: '🪙', color: '#F59E0B', title: 'سکه، بلیط و جایزه',
    body: 'در بازی دوستانه با سکه و قلب بازی می‌کنی. برای مسابقه‌های جایزه‌دار بلیط لازم داری — و هرچی بیشتر ببری، جایزه‌ت بزرگ‌تر می‌شه.',
    image: '', enabled: true, startsAt: '', endsAt: '', sortOrder: 2 },
  { id: 'wheel', emoji: '🎡', color: '#EC4899', title: 'گردونه و جایزهٔ روزانه',
    body: 'هر روز که بیای یک جایزه می‌گیری، گردونه رو می‌چرخونی و مأموریت‌ها رو کامل می‌کنی. استریک روزانه‌ت رو نشکن!',
    image: '', enabled: true, startsAt: '', endsAt: '', sortOrder: 3 },
  { id: 'duel', emoji: '⚔️', color: '#14B8A6', title: 'آمادهٔ نبرد باش',
    body: 'در دوئل با یک حریف واقعی رو‌به‌رو می‌شی و در «آخرین بازمانده» تا آخرین نفر می‌جنگی. از یک دوئل ساده شروع کن.',
    image: '', enabled: true, startsAt: '', endsAt: '', sortOrder: 4 }
];

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS onboarding_slides (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    image TEXT NOT NULL DEFAULT '',
    emoji TEXT NOT NULL DEFAULT '✨',
    color TEXT NOT NULL DEFAULT '#8B5CF6',
    enabled BOOLEAN NOT NULL DEFAULT true,
    starts_at TEXT NOT NULL DEFAULT '',
    ends_at TEXT NOT NULL DEFAULT '',
    sort_order INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  _schemaReady = true;
}

let _mem: OnboardingSlide[] | null = null;
const now = () => new Date().toISOString();

function rowToSlide(r: any): OnboardingSlide {
  return {
    id: String(r.id), title: String(r.title ?? ''), body: String(r.body ?? ''),
    image: String(r.image ?? ''), emoji: String(r.emoji ?? '✨'), color: String(r.color ?? '#8B5CF6'),
    enabled: r.enabled !== false,
    startsAt: String(r.starts_at ?? r.startsAt ?? ''), endsAt: String(r.ends_at ?? r.endsAt ?? ''),
    sortOrder: Number(r.sort_order ?? r.sortOrder ?? 0),
    updatedAt: r.updated_at?.toISOString?.() ?? String(r.updated_at ?? now())
  };
}

async function seedIfEmpty(): Promise<void> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM onboarding_slides`);
    if (rows[0]?.n > 0) return;
    for (const d of ONBOARDING_DEFAULTS) await saveSlide({ ...d });
    return;
  }
  if (_mem) return;
  _mem = ONBOARDING_DEFAULTS.map((d) => ({ ...d, updatedAt: now() }));
}

export async function listSlides(): Promise<OnboardingSlide[]> {
  await seedIfEmpty();
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT * FROM onboarding_slides ORDER BY sort_order, id`);
    return rows.map(rowToSlide);
  }
  return (_mem ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
}

/** What a player should actually see right now: switched on, and inside its
 *  campaign window if it has one. */
export async function activeSlides(at = new Date()): Promise<OnboardingSlide[]> {
  const t = at.getTime();
  return (await listSlides()).filter((s) => {
    if (!s.enabled) return false;
    if (s.startsAt && new Date(s.startsAt).getTime() > t) return false;
    if (s.endsAt && new Date(s.endsAt).getTime() < t) return false;
    return true;
  });
}

function approxBytes(dataUri: string): number {
  const i = dataUri.indexOf(',');
  return i < 0 ? dataUri.length : Math.floor((dataUri.length - i - 1) * 3 / 4);
}

export async function saveSlide(input: Partial<OnboardingSlide>): Promise<OnboardingSlide> {
  const title = String(input.title ?? '').trim();
  if (!title) throw new OnboardingError('TITLE_REQUIRED', 'عنوان اسلاید لازم است.');
  const image = String(input.image ?? '');
  if (image && image.startsWith('data:') && approxBytes(image) > SLIDE_IMAGE_MAX_BYTES) {
    throw new OnboardingError('IMAGE_TOO_LARGE', 'حجم تصویر بیش از ۶۰۰ کیلوبایت است.');
  }
  const slide: OnboardingSlide = {
    id: String(input.id || '').trim() || id(),
    title, body: String(input.body ?? '').trim(),
    image, emoji: String(input.emoji ?? '✨'),
    color: String(input.color ?? '#8B5CF6'),
    enabled: input.enabled !== false,
    startsAt: String(input.startsAt ?? ''), endsAt: String(input.endsAt ?? ''),
    sortOrder: Number(input.sortOrder ?? 0),
    updatedAt: now()
  };
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO onboarding_slides(id,title,body,image,emoji,color,enabled,starts_at,ends_at,sort_order,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
       ON CONFLICT (id) DO UPDATE SET title=$2,body=$3,image=$4,emoji=$5,color=$6,enabled=$7,starts_at=$8,ends_at=$9,sort_order=$10,updated_at=now()`,
      [slide.id, slide.title, slide.body, slide.image, slide.emoji, slide.color, slide.enabled, slide.startsAt, slide.endsAt, slide.sortOrder]);
  } else {
    if (!_mem) _mem = [];
    const i = _mem.findIndex((s) => s.id === slide.id);
    if (i >= 0) _mem[i] = slide; else _mem.push(slide);
  }
  logger.info('onboarding_slide_saved', { id: slide.id, enabled: slide.enabled });
  return slide;
}

export async function deleteSlide(slideId: string): Promise<boolean> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rowCount } = await pool.query(`DELETE FROM onboarding_slides WHERE id=$1`, [slideId]);
    return (rowCount ?? 0) > 0;
  }
  if (!_mem) return false;
  const i = _mem.findIndex((s) => s.id === slideId);
  if (i < 0) return false;
  _mem.splice(i, 1);
  return true;
}

/** Test seam. */
export function _resetOnboardingMemory(): void { _mem = null; }
