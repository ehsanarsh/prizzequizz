/* PROMO SLOTS ON THE THREE TICKET SCREENS.
 *
 * Wherever a player picks or buys a ticket there is one banner the admin owns:
 * an image, a headline and a line of text. The three screens — the duel entry,
 * the Last Survivor entry, and the shop's ticket tab — each have their own slot
 * so they can carry different campaigns, but they render through the same
 * component and therefore look identical.
 *
 * Stored as one self-healing JSON row so the panel can change copy or artwork
 * without a redeploy. The image is kept as a data URI (hard-capped) rather than
 * needing a separate upload pipeline; an ordinary https URL works too. */
import { getPgPool } from '../database/postgres.js';

export type PromoSlotId = 'duel' | 'lastSurvivor' | 'shop';
export const PROMO_SLOTS: PromoSlotId[] = ['duel', 'lastSurvivor', 'shop'];

/** Hard ceiling for an inline banner image. */
export const PROMO_IMAGE_MAX_BYTES = 400 * 1024;

export interface PromoSlot {
  /** Off → the screen simply shows nothing in that spot. */
  enabled: boolean;
  title: string;
  text: string;
  /** data: URI or an https URL. Empty = text-only banner. */
  image: string;
  /** Optional in-app screen id to open on tap (e.g. 'shop'). Empty = not tappable. */
  link: string;
}

export type TicketPromos = Record<PromoSlotId, PromoSlot>;

export const PROMO_DEFAULTS: TicketPromos = {
  duel: { enabled: true, title: 'آماده‌ای؟', text: 'بلیطت را انتخاب کن و وارد رقابت شو.', image: '', link: '' },
  lastSurvivor: { enabled: true, title: 'تا آخر بمان', text: 'هرچه بیشتر دوام بیاوری، سهمت بیشتر می‌شود.', image: '', link: '' },
  shop: { enabled: true, title: 'بلیط بگیر، وارد شو', text: 'با بلیط وارد رقابت اصلی می‌شوی.', image: '', link: '' }
};

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ticket_promos (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  _schemaReady = true;
}

let _mem: TicketPromos | null = null;

export class PromoError extends Error { constructor(public code: string, message: string) { super(message); } }

function str(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

/** Validate one slot coming from the admin panel. */
function cleanSlot(base: PromoSlot, patch: any): PromoSlot {
  const p = (patch && typeof patch === 'object') ? patch : {};
  const image = p.image === undefined ? base.image : str(p.image, PROMO_IMAGE_MAX_BYTES * 2);
  if (image && !/^(data:image\/(png|jpeg|webp|avif|gif);base64,|https:\/\/)/i.test(image)) {
    throw new PromoError('PROMO_IMAGE_INVALID', 'تصویر باید data:image یا آدرس https باشد.');
  }
  if (image.startsWith('data:')) {
    const bytes = Math.floor((image.length - image.indexOf(',') - 1) * 3 / 4);
    if (bytes > PROMO_IMAGE_MAX_BYTES) {
      throw new PromoError('PROMO_IMAGE_TOO_LARGE', `حجم تصویر باید کمتر از ${Math.round(PROMO_IMAGE_MAX_BYTES / 1024)} کیلوبایت باشد.`);
    }
  }
  return {
    enabled: p.enabled === undefined ? base.enabled : !!p.enabled,
    title: p.title === undefined ? base.title : str(p.title, 80),
    text: p.text === undefined ? base.text : str(p.text, 240),
    image,
    link: p.link === undefined ? base.link : str(p.link, 60)
  };
}

export function withDefaults(partial: any): TicketPromos {
  const out = {} as TicketPromos;
  for (const id of PROMO_SLOTS) {
    const base = PROMO_DEFAULTS[id];
    const saved = (partial && typeof partial === 'object') ? partial[id] : null;
    out[id] = saved ? { ...base, ...saved } : { ...base };
  }
  return out;
}

export async function getPromos(): Promise<TicketPromos> {
  const pool = pg();
  if (pool) {
    try {
      await ensureSchema(pool);
      const { rows } = await pool.query(`SELECT data FROM ticket_promos WHERE id='default'`);
      if (!rows[0]) {
        await pool.query(`INSERT INTO ticket_promos(id,data) VALUES ('default',$1) ON CONFLICT (id) DO NOTHING`, [JSON.stringify(PROMO_DEFAULTS)]);
        return withDefaults({});
      }
      return withDefaults(rows[0].data);
    } catch { return withDefaults({}); }
  }
  if (!_mem) _mem = withDefaults({});
  return _mem;
}

export async function updatePromos(patch: any): Promise<TicketPromos> {
  const current = await getPromos();
  const next = {} as TicketPromos;
  for (const id of PROMO_SLOTS) {
    next[id] = cleanSlot(current[id], patch && typeof patch === 'object' ? patch[id] : null);
  }
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO ticket_promos(id,data,updated_at) VALUES ('default',$1,now())
       ON CONFLICT (id) DO UPDATE SET data=$1, updated_at=now()`, [JSON.stringify(next)]);
  } else {
    _mem = next;
  }
  return next;
}
