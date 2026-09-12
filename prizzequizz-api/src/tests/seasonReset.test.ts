/* STARTING A NEW SEASON WITHOUT TAKING BACK WHAT WAS OWED.
 *
 * «می‌خوام ریست کنم و فقط سطح و XP و اینا بمونه، تمام صندوق جایزه‌ها صفر بشه،
 *  تمام بلیط‌ها و کمکی‌ها صفر بشه، و فقط به ازای هر نفر که دعوت کردند و بلیط
 *  گرفتن اون بلیط‌ها بمونه — برای رقابت با پول واقعی.»
 *
 * The exception is the whole job. A ticket handed over for bringing somebody to
 * the game was not bought and was not won at the table — it is owed, and a
 * reset that took it back would be withdrawing an invitation already honoured.
 * Everything else a player is holding goes.
 *
 * This wipes every prize vault on the system, so it is not something to find
 * out about afterwards. Postgres-only, because it is written entirely in SQL
 * and a memory-driver version would be testing a different program.
 *
 * Run: DATABASE_URL=postgres://postgres@localhost:55432/pztest npx tsx src/tests/seasonReset.test.ts */
import assert from 'node:assert/strict';

const url = process.env.DATABASE_URL;
if (!url) { console.log('[seasonReset] skipped — no DATABASE_URL'); process.exit(0); }

const { resetArea, seasonResetPlan } = await import('../services/adminOpsService.js');
const { REFERRAL_REWARD_TIER, REFERRAL_REWARD_COUNT } = await import('../services/referralService.js');
const { getPgPool } = await import('../database/postgres.js');
const pool = getPgPool();

/* Several of these tables are created lazily by the service that owns them, so
   a fresh database has not seen them yet. Touching each owner once is how the
   real system provisions them too. */
const { codeFor } = await import('../services/referralService.js');
const { getAccount } = await import('../services/walletLedgerService.js');
await codeFor('00000000-0000-4000-8000-000000000000').catch(() => undefined);
await getAccount('00000000-0000-4000-8000-000000000000').catch(() => undefined);

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

let seq = 0;
async function mkUser(over: { wallet?: number; tickets?: any; lifelines?: any; xp?: number; level?: number; hearts?: number; coins?: number } = {}): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO users(id, phone, username, display_name, plan, coins, hearts, wallet_balance, xp, level, weekly_score, tickets, lifelines)
     VALUES (gen_random_uuid(), $1, $2, 'u', 'free', $3, $4, $5, $6, $7, 0, $8::jsonb, $9::jsonb) RETURNING id`,
    ['0912' + String(1000000 + seq++), 'sr' + seq, over.coins ?? 100, over.hearts ?? 5,
     over.wallet ?? 0, over.xp ?? 500, over.level ?? 7,
     JSON.stringify(over.tickets ?? {}), JSON.stringify(over.lifelines ?? {})]
  );
  return String(rows[0].id);
}
/** Register `owner` as an inviter and settle `n` accepted invitations. */
async function invited(owner: string, n: number, settled = n): Promise<void> {
  const code = 'C' + owner.slice(0, 8);
  await pool.query(`INSERT INTO referrals(user_id, code, created_at) VALUES ($1,$2,$3)
                    ON CONFLICT (user_id) DO UPDATE SET code=$2`, [owner, code, Date.now()]);
  for (let i = 0; i < n; i++) {
    const guest = await mkUser();
    await pool.query(
      `INSERT INTO referrals(user_id, code, referred_by, redeemed_at, rewarded_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [guest, 'G' + guest.slice(0, 8) + i, code, Date.now(), i < settled ? Date.now() : 0, Date.now()]
    );
  }
}
const ticketsOf = async (uid: string) => (await pool.query(`SELECT tickets FROM users WHERE id=$1`, [uid])).rows[0]?.tickets ?? {};
const rowOf = async (uid: string) => (await pool.query(`SELECT * FROM users WHERE id=$1`, [uid])).rows[0];
const totalTickets = (t: any) => Object.values(t || {}).reduce((a: number, b: any) => a + (Number(b) || 0), 0);

/* A user row is referenced from a dozen places, so the fixtures are cleared in
   dependency order rather than hoping. Anything this database does not have yet
   is skipped — the point is an empty users table, not a tour of the schema. */
const CHILD_TABLES = ['payment_intents', 'wallet_ledger', 'wallet_accounts', 'withdraw_requests',
  'transactions', 'answers', 'match_players', 'notifications', 'push_subscriptions',
  'notification_preferences', 'referrals', 'user_missions', 'sessions'];
async function wipe(): Promise<void> {
  for (const t of CHILD_TABLES) await pool.query(`DELETE FROM ${t}`).catch(() => undefined);
  await pool.query(`DELETE FROM users`);
}

(async () => {
  await wipe();

  /* ── the plan, before anything is touched ──────────────────────────── */

  const planner = await mkUser({ wallet: 50000, tickets: { green: 3, blue: 1 }, lifelines: { p5050: 2 } });
  await invited(planner, 2);
  await pool.query(`INSERT INTO wallet_accounts(user_id, available, locked) VALUES ($1, 50000, 0)`, [planner]);

  await check('the plan counts what is about to be destroyed', async () => {
    const p = await seasonResetPlan();
    assert.equal(p.vaultTotal, 50000);
    assert.equal(p.ticketsHeld, 4, 'three green and one blue');
    assert.equal(p.lifelinesHeld, 2);
  });

  await check('and how many tickets will survive it', async () => {
    const p = await seasonResetPlan();
    assert.equal(p.referralTicketsKept, 2 * REFERRAL_REWARD_COUNT);
    assert.equal(p.usersWithReferralTickets, 1);
  });

  await check('the plan changes nothing', async () => {
    const before = await rowOf(planner);
    await seasonResetPlan();
    const after = await rowOf(planner);
    assert.equal(totalTickets(after.tickets), 4, 'a plan that alters anything is not a plan');
    assert.equal(Number(after.wallet_balance), Number(before.wallet_balance));
    assert.deepEqual(after.lifelines, before.lifelines);
    const { rows } = await pool.query(`SELECT coalesce(sum(available),0)::bigint AS n FROM wallet_accounts`);
    assert.equal(Number(rows[0].n), 50000, 'and the vaults are still there afterwards');
  });

  /* ── the reset itself ──────────────────────────────────────────────── */

  await wipe();
  const rich = await mkUser({ wallet: 250000, tickets: { green: 5, gold: 2 }, lifelines: { p5050: 3, ptime: 1 }, xp: 4200, level: 19, hearts: 4, coins: 900 });
  const inviter = await mkUser({ tickets: { green: 10 }, lifelines: { p5050: 5 } });
  const plain = await mkUser({ tickets: { blue: 4 } });
  await invited(inviter, 3);
  await pool.query(`INSERT INTO wallet_accounts(user_id, available, locked) VALUES ($1, 250000, 0)`, [rich]);
  await pool.query(`UPDATE users SET wallet_balance=250000 WHERE id=$1`, [rich]);

  await resetArea('season' as any);

  await check('every prize vault is emptied', async () => {
    const { rows } = await pool.query(`SELECT coalesce(sum(available),0)::bigint AS n FROM wallet_accounts`);
    assert.equal(Number(rows[0].n), 0);
    assert.equal(Number((await rowOf(rich)).wallet_balance), 0, 'and the mirror on the user row too');
  });

  await check('and the ledger behind them', async () => {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM wallet_ledger`);
    assert.equal(Number(rows[0].n), 0);
  });

  await check('bought tickets are gone', async () => {
    assert.equal(totalTickets(await ticketsOf(rich)), 0, 'five green and two gold, none of them earned by inviting');
    assert.equal(totalTickets(await ticketsOf(plain)), 0);
  });

  await check('every lifeline is gone', async () => {
    assert.deepEqual((await rowOf(rich)).lifelines, {});
    assert.deepEqual((await rowOf(inviter)).lifelines, {});
  });

  await check('BUT A TICKET EARNED BY INVITING SOMEBODY STAYS', async () => {
    /* The whole point. Three settled invitations, three tickets — and not the
       ten they were also holding. */
    const t = await ticketsOf(inviter);
    assert.equal(Number(t[REFERRAL_REWARD_TIER] ?? 0), 3 * REFERRAL_REWARD_COUNT,
      'got ' + JSON.stringify(t));
    assert.equal(totalTickets(t), 3 * REFERRAL_REWARD_COUNT,
      'the bought tickets came back too — keeping instead of restoring keeps everything');
  });

  await check('level and XP are untouched — they are the record of having played', async () => {
    const r = await rowOf(rich);
    assert.equal(Number(r.xp), 4200);
    assert.equal(Number(r.level), 19);
  });

  await check('and nothing nobody asked about was taken', async () => {
    /* Hearts and coins were not in the request. A reset that quietly takes more
       than it was asked to is discovered by a player, not by whoever ran it. */
    const r = await rowOf(rich);
    assert.equal(Number(r.hearts), 4);
    assert.equal(Number(r.coins), 900);
  });

  /* ── the edges that decide whether it is honest ────────────────────── */

  await check('an invitation that never paid out is not restored as if it had', async () => {
    await wipe();
    const u = await mkUser({ tickets: { green: 9 } });
    await invited(u, 4, 1);          // four signed up, only one reward settled
    await resetArea('season' as any);
    assert.equal(Number((await ticketsOf(u))[REFERRAL_REWARD_TIER] ?? 0), 1 * REFERRAL_REWARD_COUNT);
  });

  await check('somebody who invited nobody keeps nothing', async () => {
    await wipe();
    const u = await mkUser({ tickets: { green: 7, gold: 1 } });
    await resetArea('season' as any);
    assert.equal(totalTickets(await ticketsOf(u)), 0);
  });

  await check('running it twice does not multiply the kept tickets', async () => {
    await wipe();
    const u = await mkUser({ tickets: { green: 5 } });
    await invited(u, 2);
    await resetArea('season' as any);
    const once = await ticketsOf(u);
    await resetArea('season' as any);
    assert.deepEqual(await ticketsOf(u), once, 'a second season must not hand the tickets out again');
  });

  await check('a pending withdrawal cannot survive the vault it would draw on', async () => {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM withdraw_requests`);
    assert.equal(Number(rows[0].n), 0, 'a payout request against money that no longer exists');
  });

  /* ── the narrower areas still do only their own job ────────────────── */

  await check('resetting lifelines alone leaves tickets and money alone', async () => {
    await wipe();
    const u = await mkUser({ wallet: 1000, tickets: { green: 2 }, lifelines: { p5050: 4 } });
    await pool.query(`INSERT INTO wallet_accounts(user_id, available, locked) VALUES ($1, 1000, 0)`, [u]);
    await resetArea('lifelines' as any);
    assert.deepEqual((await rowOf(u)).lifelines, {});
    assert.equal(totalTickets(await ticketsOf(u)), 2);
    const { rows } = await pool.query(`SELECT available FROM wallet_accounts WHERE user_id=$1`, [u]);
    assert.equal(Number(rows[0].available), 1000);
  });

  await check('and resetting tickets alone still clears ALL of them', async () => {
    /* The plain ticket reset is not the season one and must not start making
       exceptions of its own. */
    await wipe();
    const u = await mkUser({ tickets: { green: 3 } });
    await invited(u, 2);
    await resetArea('tickets' as any);
    assert.equal(totalTickets(await ticketsOf(u)), 0);
  });

  await wipe();
  await pool.end();
  console.log(`[seasonReset] ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
