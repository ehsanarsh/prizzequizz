/* «کد معرف.»
 *
 * «سیستم دعوت از دوستان — دعوت به مسابقه نه ها، دعوت به بازی — یعنی داشتن کد
 *  معرف باید فعال بشه. هر کاربر یه کد داشته باشه، و اگه هر کسی در قسمت کد معرف
 *  اون کد رو وارد کنه، به دارندهٔ کد یک بلیط سبز داده بشه به عنوان جایزه. و اون
 *  کد رو باید در اولین ثبت نام وارد کنن، وگرنه بعد از ثبت نام دیگه جایی نباشه
 *  که بتونی وارد کنی و جایزه ببری.»
 *
 * Two halves, and the second is the one that shapes the file:
 *
 *   · EVERYBODY HAS A CODE. It is theirs from the moment they are asked for
 *     it, it never changes, and it is not a secret — it is meant to be sent to
 *     friends. Derived once and stored, so it cannot drift.
 *
 *   · A CODE IS TYPED ONCE, AT SIGN-UP, AND NOWHERE ELSE. Not «the screen only
 *     shows the box there» — the box being absent is a UI decision and a UI
 *     decision is not a rule. `redeem` refuses a second time, refuses your own
 *     code, and the route that calls it refuses unless the account is being
 *     completed for the first time. Somebody who found the endpoint a year
 *     later gets the same answer as somebody who found the screen.
 *
 * The reward goes to the OWNER of the code, not to the person typing it — one
 * green ticket, granted through the ordinary ticket service so it lands in the
 * same place every other ticket does.
 */
import { getPgPool } from '../database/postgres.js';
import { grantTickets } from './ticketService.js';

export interface Referral {
  userId: string;
  code: string;
  /** The code this player typed at sign-up, if they typed one. */
  referredBy: string;
  redeemedAt: number;
  /** When the owner's ticket was actually paid. 0 = claimed, not yet earned. */
  rewardedAt: number;
  createdAt: number;
}

/** What the owner of a code gets each time somebody signs up with it. */
export const REFERRAL_REWARD_TIER = 'green';
export const REFERRAL_REWARD_COUNT = 1;

export class ReferralError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/* NO 0/O AND NO 1/I/L. A referral code is read off one screen and typed into
   another, usually from a photo of it, so the alphabet leaves out every pair
   that is guessed wrong at a glance. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 7;

function makeCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
}

/** Typed by a person, so read like one: case, spaces and dashes do not matter.
 *  Nothing is GUESSED, though — O, I, L, 0 and 1 are not in the alphabet, so a
 *  code containing one simply matches nothing and is refused by name. Folding
 *  them onto their look-alikes would mean handing somebody a reward for a code
 *  they did not type. */
export function normalizeCode(raw: string): string {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

const mem = new Map<string, Referral>();

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS referrals (
    user_id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    referred_by TEXT NOT NULL DEFAULT '',
    redeemed_at BIGINT NOT NULL DEFAULT 0,
    rewarded_at BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL)`);
  /* Said twice on purpose — `CREATE TABLE IF NOT EXISTS` does nothing to a
     table that already exists, so a column added after the first release
     reaches a fresh database and no other. */
  for (const col of [
    `referred_by TEXT NOT NULL DEFAULT ''`,
    `redeemed_at BIGINT NOT NULL DEFAULT 0`,
    `rewarded_at BIGINT NOT NULL DEFAULT 0`
  ]) {
    await pool.query(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS ${col}`);
  }
  /* One code, one owner. Without this two players could be handed the same
     code by two racing first-reads, and every reward after that would go to
     whichever row was found first. */
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS referrals_code ON referrals(code)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS referrals_by ON referrals(referred_by)`);
  _schemaReady = true;
}

const rowTo = (r: any): Referral => ({
  userId: String(r.user_id), code: String(r.code),
  referredBy: String(r.referred_by || ''), redeemedAt: Number(r.redeemed_at) || 0,
  rewardedAt: Number(r.rewarded_at) || 0,
  createdAt: Number(r.created_at) || 0
});

/** This player's own code, made on the first ask and theirs from then on. */
export async function codeFor(userId: string): Promise<string> {
  const uid = String(userId || '');
  if (!uid) throw new ReferralError('NO_USER', 'کاربر مشخص نیست');
  const pool = pg();
  if (!pool) {
    const have = mem.get(uid);
    if (have) return have.code;
    /* BOUNDED, like the database path below. `while (taken) draw again` reads
       as harmless — the alphabet is 31 characters and the code is seven of
       them — but «practically never» is not «never», and an unbounded loop on
       a value that could stop being unique is a hang, not a retry. Eight
       draws, then say so. */
    let code = '';
    for (let i = 0; i < 8; i++) {
      const c = makeCode();
      if (![...mem.values()].some((r) => r.code === c)) { code = c; break; }
    }
    if (!code) throw new ReferralError('CODE_UNAVAILABLE', 'کد ساخته نشد؛ دوباره تلاش کن');
    mem.set(uid, { userId: uid, code, referredBy: '', redeemedAt: 0, rewardedAt: 0, createdAt: Date.now() });
    return code;
  }
  await ensureSchema(pool);
  const found = await pool.query(`SELECT * FROM referrals WHERE user_id=$1`, [uid]);
  if (found.rows[0]) return rowTo(found.rows[0]).code;
  /* A clash is possible and cheap to survive: the unique index refuses it and
     the next attempt draws again. */
  for (let i = 0; i < 8; i++) {
    const code = makeCode();
    const { rows } = await pool.query(
      `INSERT INTO referrals (user_id, code, referred_by, redeemed_at, created_at)
       VALUES ($1,$2,'',0,$3) ON CONFLICT DO NOTHING RETURNING code`,
      [uid, code, Date.now()]
    );
    if (rows[0]) return String(rows[0].code);
    /* Either the code was taken or this user already has one — read back. */
    const again = await pool.query(`SELECT code FROM referrals WHERE user_id=$1`, [uid]);
    if (again.rows[0]) return String(again.rows[0].code);
  }
  throw new ReferralError('CODE_UNAVAILABLE', 'کد ساخته نشد؛ دوباره تلاش کن');
}

/** Who owns this code, if anybody. */
export async function ownerOf(code: string): Promise<string> {
  const c = normalizeCode(code);
  if (!c) return '';
  const pool = pg();
  if (!pool) {
    for (const r of mem.values()) if (r.code === c) return r.userId;
    return '';
  }
  await ensureSchema(pool);
  const { rows } = await pool.query(`SELECT user_id FROM referrals WHERE code=$1`, [c]);
  return rows[0] ? String(rows[0].user_id) : '';
}

/** Has this player already used somebody's code? */
export async function hasRedeemed(userId: string): Promise<boolean> {
  const pool = pg();
  if (!pool) return !!mem.get(String(userId))?.redeemedAt;
  await ensureSchema(pool);
  const { rows } = await pool.query(`SELECT redeemed_at FROM referrals WHERE user_id=$1`, [String(userId)]);
  return !!(rows[0] && Number(rows[0].redeemed_at) > 0);
}

/** Type somebody's code. Once, and never your own. The reward goes to them. */
export async function redeem(userId: string, rawCode: string): Promise<{ ownerUserId: string; code: string }> {
  const uid = String(userId || '');
  const code = normalizeCode(rawCode);
  if (!uid) throw new ReferralError('NO_USER', 'کاربر مشخص نیست');
  if (!code) throw new ReferralError('BAD_CODE', 'کد معرف را وارد کن');
  /* Make sure this player has a row (and a code) of their own before anything
     is written on it. */
  const mine = await codeFor(uid);
  if (code === mine) throw new ReferralError('OWN_CODE', 'کد خودت را نمی‌توانی وارد کنی');
  if (await hasRedeemed(uid)) throw new ReferralError('ALREADY_REDEEMED', 'قبلاً یک کد معرف ثبت کرده‌ای');
  const owner = await ownerOf(code);
  if (!owner) throw new ReferralError('CODE_NOT_FOUND', 'این کد معرف پیدا نشد');

  const now = Date.now();
  const pool = pg();
  if (!pool) {
    const r = mem.get(uid)!;
    if (r.redeemedAt) throw new ReferralError('ALREADY_REDEEMED', 'قبلاً یک کد معرف ثبت کرده‌ای');
    r.referredBy = code; r.redeemedAt = now; mem.set(uid, r);
  } else {
    /* The write is the claim: `redeemed_at=0` in the WHERE is what makes two
       simultaneous attempts pay out once. */
    const { rowCount } = await pool.query(
      `UPDATE referrals SET referred_by=$2, redeemed_at=$3 WHERE user_id=$1 AND redeemed_at=0`,
      [uid, code, now]
    );
    if (!rowCount) throw new ReferralError('ALREADY_REDEEMED', 'قبلاً یک کد معرف ثبت کرده‌ای');
  }
  /* NOTHING IS PAID HERE ANY MORE.
     «بعد از ثبت نام، بعد از اولین بازیِ دعوت‌شده، به فرستنده یه بلیط سبز
      می‌دیم.» Signing up is free and takes a minute; a reward that lands on
     sign-up alone pays for accounts, not for players. So this call only
     RECORDS the claim, and `payReferralReward` below settles it the first time
     the new player actually finishes a match. */
  return { ownerUserId: owner, code };
}

/* ── SETTLING UP, ONCE, AFTER THE FIRST REAL GAME ────────────────────────
   «بعد از ثبت‌نام، بعد از اولین بازیِ دعوت‌شده، به فرستنده یه بلیط سبز می‌دیم.
    و بعد از دریافت بلیط باید بهش اطلاع‌رسانی بشه که به شما یک بلیط سبز تعلق
    گرفت … الان کاربر هیچ خبری نداره که بلیطش اضافه شده یا نه.»

   Called on every match a player finishes; it does nothing at all except the
   one time it matters. `rewarded_at=0` in the WHERE is what makes that true
   even if two matches end at the same instant — the row is claimed by whoever
   updates it, and the loser of that race pays nothing.

   The ticket lands and then the owner is TOLD, by name. A reward nobody
   notices is a reward that does not do its job: it is meant to be the reason
   somebody invites the next person. */
export async function payReferralReward(userId: string): Promise<{ ownerUserId: string; tier: string; count: number } | null> {
  const uid = String(userId || '');
  if (!uid) return null;
  const pool = pg();
  let owner = '';
  if (!pool) {
    const r = mem.get(uid);
    if (!r || !r.redeemedAt || r.rewardedAt) return null;
    owner = await ownerOf(r.referredBy);
    if (!owner) return null;
    r.rewardedAt = Date.now(); mem.set(uid, r);
  } else {
    await ensureSchema(pool);
    /* Claim and read the code back in one statement — nothing between the two
       for a second call to slip through. */
    const { rows } = await pool.query(
      `UPDATE referrals SET rewarded_at=$2
        WHERE user_id=$1 AND redeemed_at>0 AND rewarded_at=0 AND referred_by<>''
        RETURNING referred_by`,
      [uid, Date.now()]
    );
    if (!rows[0]) return null;
    owner = await ownerOf(String(rows[0].referred_by));
    if (!owner) return null;
  }
  await grantTickets(owner, REFERRAL_REWARD_TIER, REFERRAL_REWARD_COUNT);
  return { ownerUserId: owner, tier: REFERRAL_REWARD_TIER, count: REFERRAL_REWARD_COUNT };
}

/** Whether this player's referral has already been settled. */
export async function wasRewarded(userId: string): Promise<boolean> {
  const pool = pg();
  if (!pool) return !!mem.get(String(userId))?.rewardedAt;
  await ensureSchema(pool);
  const { rows } = await pool.query(`SELECT rewarded_at FROM referrals WHERE user_id=$1`, [String(userId)]);
  return !!(rows[0] && Number(rows[0].rewarded_at) > 0);
}

/** How many people have signed up with this player's code. */
export async function inviteCount(userId: string): Promise<number> {
  const code = await codeFor(userId);
  const pool = pg();
  if (!pool) return [...mem.values()].filter((r) => r.referredBy === code).length;
  await ensureSchema(pool);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM referrals WHERE referred_by=$1`, [code]);
  return Number(rows[0]?.n) || 0;
}

/** Tests only. */
export function _resetReferrals(): void { mem.clear(); _schemaReady = false; }
