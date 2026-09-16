/* THE USERS SCREEN, MEASURED.
 *
 * «باید تعداد بلیط‌های کاربر رو ببینم… بتونم sort کنم طبق کیف پول، طبق بلیط سبز
 *  و آبی و قرمز، طبق بیشترین خرید، طبق تعداد برد و باخت، و هر موضوع کیا خوب
 *  زدن — یعنی موضوع فوتبال رو انتخاب کنم، sort کنه نسبت به اون موضوع.»
 *
 * Every claim below is a claim about ORDER, and the fixture is built so that
 * each ordering puts the three players in a DIFFERENT sequence. That is the
 * whole point: a test where «sort by green tickets» and «sort by all tickets»
 * happen to agree proves nothing about either.
 *
 * Run: DATABASE_URL=postgres://postgres@localhost:55432/pztest npx tsx src/tests/adminUserTable.test.ts
 */
import assert from 'node:assert/strict';
import { adminUserTable, ticketTiers } from '../services/adminUserTable.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

if (!process.env.DATABASE_URL) {
  /* Loudly, not quietly: a users screen that is only ever exercised against the
     memory driver is a users screen nobody has actually checked. */
  console.log('  — skipped: this needs Postgres; the ordering happens IN the database');
  console.log('[adminUserTable] 0 passed, 0 failed');
  process.exit(0);
}

const U = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
const M = (n: number) => `bbbbbbbb-0000-4000-8000-00000000000${n}`;
const Q = (n: number) => `cccccccc-0000-4000-8000-00000000000${n}`;
const A = U(1), B = U(2), C = U(3), D = U(4);
const TOPIC = 'فوتبال';
const OTHER = 'تاریخ';

(async () => {
  const { getPgPool } = await import('../database/postgres.js');
  const pool = getPgPool();
  const tiers = ticketTiers();

  async function wipe(): Promise<void> {
    await pool.query(`DELETE FROM answers WHERE user_id = ANY($1::uuid[])`, [[A, B, C]]);
    await pool.query(`DELETE FROM match_players WHERE user_id = ANY($1::uuid[])`, [[A, B, C]]);
    await pool.query(`DELETE FROM transactions WHERE user_id = ANY($1::uuid[])`, [[A, B, C]]);
    await pool.query(`DELETE FROM referrals WHERE user_id = ANY($1::text[])`, [[A, B, C]]);
    await pool.query(`DELETE FROM matches WHERE id = ANY($1::uuid[])`, [[M(1), M(2), M(3), M(4), M(5), M(6), M(7), M(8)]]);
    await pool.query(`DELETE FROM questions WHERE id = ANY($1::uuid[])`, [[Q(1), Q(2)]]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[]) OR username LIKE 'tbl-%' OR username LIKE 'punct-%'`, [[A, B, C, D]]);
  }
  await wipe();

  /* ── THE FIXTURE ──────────────────────────────────────────────────────────
   *            wallet   green  blue  red  total   cash spent   played wins
   *   tbl-a    900000       1    40    0     41           0        1     1
   *   tbl-b    500000      20     0    0     20      300000        4     3
   *   tbl-c        10       0     0    3      3     1000000        2     0
   *   … and on «فوتبال»: a 1/1, b 1/4, c 0/0 — while c is 3/3 on «تاریخ».
   */
  /* Eleven digits, as a real Iranian mobile is — the last ten identify the
     line, and a ten-digit stand-in would make the +98 spelling untestable. */
  let phone = 1000000;
  const mk = async (id: string, name: string, wallet: number, t: Record<string, number>) =>
    pool.query(
      `INSERT INTO users(id, phone, username, display_name, wallet_balance, coins, tickets)
       VALUES ($1,$2,$3,$4,$5,0,$6::jsonb)`,
      [id, '0912' + (++phone), name, name, wallet, JSON.stringify(t)]);
  await mk(A, 'tbl-a', 900000, { green: 1, blue: 40, red: 0 });
  await mk(B, 'tbl-b', 500000, { green: 20, blue: 0, red: 0 });
  await mk(C, 'tbl-c', 10, { green: 0, blue: 0, red: 3 });
  /* Nothing normalises a phone number on the way IN — it is stored as the
     client sent it. So an account really can hold «+98 912 100 0009», and the
     only thing that finds it is comparing the column on its digits. Kept out of
     the `tbl-` set so it does not disturb the orderings above. */
  await pool.query(
    `INSERT INTO users(id, phone, username, display_name, wallet_balance, coins, tickets)
     VALUES ($1,'+98 912 100 0009','punct-d','دال',0,0,'{}'::jsonb)`, [D]);

  /* `tbl-a` is also made the OLDEST row, so «the richest» and «the most recent»
     are opposite ends of the list. A page cut before the sort returns the wrong
     person, and this is what proves the cut happens after. */
  await pool.query(`UPDATE users SET updated_at = now() - interval '9 days' WHERE id=$1`, [A]);
  await pool.query(`UPDATE users SET updated_at = now() - interval '1 day'  WHERE id=$1`, [B]);
  await pool.query(`UPDATE users SET updated_at = now()                     WHERE id=$1`, [C]);

  const match = async (n: number, winner: string | null, players: string[]) => {
    await pool.query(
      `INSERT INTO matches(id, mode_id, economy_type, status, config_version, winner_user_id)
       VALUES ($1,'duel','free','finished','v1',$2)`, [M(n), winner]);
    for (const p of players) {
      await pool.query(`INSERT INTO match_players(match_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [M(n), p]);
    }
  };
  await match(1, A, [A, B]);          // a: 1 played, 1 win   b: +1 played
  await match(2, B, [B, C]);          // b: +1 win
  await match(3, B, [B, C]);          // b: +1 win
  await match(4, B, [B]);             // b: +1 win  → b = 4 played, 3 wins
  //                                     c = 2 played, 0 wins

  const tx = async (u: string, currency: string, direction: string, amount: number, n: number) =>
    pool.query(
      `INSERT INTO transactions(id, user_id, type, currency, amount, direction, status)
       VALUES ($1,$2,'purchase',$3,$4,$5,'settled')`, [M(n), u, currency, amount, direction]);
  await tx(B, 'cash', 'debit', 300000, 5);
  /* Coins are not money: a player who spent nine hundred thousand COINS has not
     spent anything, and must not outrank somebody who paid. */
  await tx(B, 'coins', 'debit', 900000, 6);
  await tx(C, 'cash', 'debit', 1000000, 7);
  /* And charging a wallet is not spending from it: `tbl-a` put five million in
     and has bought nothing. Counting it would make the biggest depositor look
     like the biggest customer. */
  await tx(A, 'cash', 'credit', 5000000, 8);

  await pool.query(
    `INSERT INTO questions(id, text, options, correct_index, category, difficulty)
     VALUES ($1,'q1','["a","b"]'::jsonb,0,$2,'easy'), ($3,'q2','["a","b"]'::jsonb,0,$4,'easy')`,
    [Q(1), TOPIC, Q(2), OTHER]);
  let k = 0;
  const ans = async (u: string, q: string, correct: boolean) =>
    pool.query(
      `INSERT INTO answers(id, match_id, user_id, question_id, selected_index, correct, idempotency_key)
       VALUES (gen_random_uuid(), $1, $2, $3, 0, $4, $5)`,
      [M(1), u, q, correct, 'tbl-key-' + (++k)]);
  await ans(A, Q(1), true);                                   // a: 1/1 on فوتبال
  await ans(B, Q(1), true);
  await ans(B, Q(1), false); await ans(B, Q(1), false); await ans(B, Q(1), false);  // b: 1/4
  await ans(C, Q(2), true); await ans(C, Q(2), true); await ans(C, Q(2), true);     // c: 3/3, but on تاریخ

  /* `tbl-a` brought two people in; only one of them settled into a ticket. */
  const ref = async (u: string, code: string, by: string, rewarded: number) =>
    pool.query(
      `INSERT INTO referrals(user_id, code, referred_by, redeemed_at, rewarded_at, created_at)
       VALUES ($1,$2,$3,0,$4,0)`, [u, code, by, rewarded]);
  await ref(A, 'TBL-A', '', 0);
  await ref(B, 'TBL-B', 'TBL-A', 1700000000000);
  await ref(C, 'TBL-C', 'TBL-A', 0);

  const names = (r: any) => r.rows.map((x: any) => x.username);
  const one = (r: any, u: string) => r.rows.find((x: any) => x.username === u);
  const T = (o: any = {}) => adminUserTable({ query: 'tbl-', limit: 50, ...o });

  /* ── WHAT THE OPERATOR ASKED FOR ──────────────────────────────────────── */

  await check('the ticket count is shown per tier, and as a total', async () => {
    const r = await T();
    assert.deepEqual(r.tiers.slice(0, 3), ['green', 'blue', 'red'], 'the columns the panel builds');
    const a = one(r, 'tbl-a');
    assert.equal(a.tickets.green, 1);
    assert.equal(a.tickets.blue, 40);
    assert.equal(a.tickets.red, 0);
    assert.equal(a.ticketTotal, 41);
    assert.equal(one(r, 'tbl-c').tickets.red, 3);
  });

  await check('sorting by wallet gives the richest, not the most recent', async () => {
    /* `tbl-a` is the oldest row in the table AND the richest. Cutting the page
       before the ordering hands back `tbl-c`, who has ten rials. */
    const r = await T({ sort: 'wallet', dir: 'desc', limit: 1 });
    assert.deepEqual(names(r), ['tbl-a']);
    assert.equal(r.total, 3, 'the pager must count all of them, not the page');
  });

  await check('and asking for it the other way round means the other way round', async () => {
    assert.deepEqual(names(await T({ sort: 'wallet', dir: 'asc' })), ['tbl-c', 'tbl-b', 'tbl-a']);
  });

  await check('sorting by ONE ticket colour is not sorting by all of them', async () => {
    /* The distinction the operator actually asked for. `tbl-a` holds the most
       tickets; `tbl-b` holds the most GREEN ones. */
    assert.deepEqual(names(await T({ sort: 'tickets', dir: 'desc' })), ['tbl-a', 'tbl-b', 'tbl-c']);
    assert.deepEqual(names(await T({ sort: 'ticket', tier: 'green', dir: 'desc' })), ['tbl-b', 'tbl-a', 'tbl-c']);
    assert.deepEqual(names(await T({ sort: 'ticket', tier: 'blue', dir: 'desc' })), ['tbl-a', 'tbl-b', 'tbl-c']);
    assert.deepEqual(names(await T({ sort: 'ticket', tier: 'red', dir: 'desc' })), ['tbl-c', 'tbl-a', 'tbl-b']);
  });

  await check('«most spent» means money, and coins are not money', async () => {
    const r = await T({ sort: 'spent', dir: 'desc' });
    assert.deepEqual(names(r), ['tbl-c', 'tbl-b', 'tbl-a']);
    assert.equal(one(r, 'tbl-b').spent, 300000, 'the 900,000 coins were counted as money');
    assert.equal(one(r, 'tbl-a').spent, 0, 'a 5,000,000 top-up was counted as a purchase');
  });

  await check('wins, losses and played are counted from the matches', async () => {
    const r = await T();
    const b = one(r, 'tbl-b');
    assert.equal(b.played, 4);
    assert.equal(b.wins, 3);
    assert.equal(b.losses, 1, 'losses is what is left after the wins');
    const c = one(r, 'tbl-c');
    assert.equal(c.played, 2); assert.equal(c.wins, 0); assert.equal(c.losses, 2);
  });

  await check('and «most wins» is a different question from «best record»', async () => {
    /* tbl-b won three of four; tbl-a won its only game. */
    assert.deepEqual(names(await T({ sort: 'wins', dir: 'desc' })), ['tbl-b', 'tbl-a', 'tbl-c']);
    assert.deepEqual(names(await T({ sort: 'winRate', dir: 'desc' })), ['tbl-a', 'tbl-b', 'tbl-c']);
    assert.deepEqual(names(await T({ sort: 'losses', dir: 'desc' })), ['tbl-c', 'tbl-b', 'tbl-a']);
  });

  await check('«کیا فوتبال رو خوب زدن» counts فوتبال, not every answer', async () => {
    /* tbl-c answered three of three correctly — all of them on تاریخ. Sorting
       the football column must leave them last, not first. */
    const r = await T({ sort: 'topic', topic: TOPIC, dir: 'desc' });
    assert.deepEqual(names(r), ['tbl-a', 'tbl-b', 'tbl-c']);
    assert.equal(one(r, 'tbl-a').topicRate, 100);
    assert.equal(one(r, 'tbl-b').topicTotal, 4);
    assert.equal(one(r, 'tbl-b').topicCorrect, 1);
    assert.equal(one(r, 'tbl-b').topicRate, 25);
    assert.equal(one(r, 'tbl-c').topicTotal, 0, 'answers from another topic leaked in');
  });

  await check('and a different topic gives a different answer', async () => {
    const r = await T({ sort: 'topic', topic: OTHER, dir: 'desc' });
    assert.deepEqual(names(r), ['tbl-c', 'tbl-a', 'tbl-b']);
    assert.equal(one(r, 'tbl-c').topicRate, 100);
  });

  await check('with no topic chosen, no topic figure is invented', async () => {
    const a = one(await T(), 'tbl-a');
    assert.equal(a.topicRate, undefined, 'a percentage appeared for a topic nobody picked');
  });

  await check('invites are counted, and a ticket handed over is counted apart', async () => {
    /* Two people signed up with tbl-a's code; one of them actually produced a
       ticket. Reporting the same number twice would say the game gave away a
       ticket it never gave away. */
    const r = await T({ sort: 'invited', dir: 'desc' });
    assert.deepEqual(names(r)[0], 'tbl-a');
    assert.equal(one(r, 'tbl-a').invited, 2);
    assert.equal(one(r, 'tbl-a').invitesRewarded, 1);
    assert.equal(one(r, 'tbl-b').invited, 0);
  });

  await check('and the row says when the account was opened', async () => {
    /* The list marks accounts that arrived since this admin last looked; with
       no date on the row every account is silently «not new». */
    const a = one(await T(), 'tbl-a');
    assert.ok(Number(a.createdAt) > 0, 'no opening date on the row');
  });

  await check('the page is a page, and the count is the whole', async () => {
    const r = await T({ sort: 'wallet', dir: 'desc', limit: 2 });
    assert.equal(r.rows.length, 2);
    assert.equal(r.total, 3);
    const p2 = await T({ sort: 'wallet', dir: 'desc', limit: 2, offset: 2 });
    assert.deepEqual(names(p2), ['tbl-c'], 'the second page did not continue the first');
  });

  await check('a phone number is found however it was typed', async () => {
    /* A support case arrives as a phone number and almost never in the shape
       the column holds. All three of these are one line. */
    const full = one(await T(), 'tbl-a').phone;
    const tail = full.slice(-7);
    const persian = tail.replace(/[0-9]/g, (d: string) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
    for (const typed of [full, '+98' + full.slice(1), persian]) {
      const r = await adminUserTable({ query: typed, limit: 50 });
      assert.deepEqual(r.rows.map((x) => x.username), ['tbl-a'], 'not found as «' + typed + '»');
    }
  });

  await check('and however it was STORED', async () => {
    const r = await adminUserTable({ query: '09121000009', limit: 50 });
    assert.deepEqual(r.rows.map((x) => x.username), ['punct-d'],
      'a number stored as «+98 912 100 0009» could not be found by dialling it');
  });

  /* ── AND WHAT NOBODY ASKED FOR ────────────────────────────────────────── */

  await check('a sort key from the request cannot become SQL', async () => {
    const r = await T({ sort: "wallet'; DROP TABLE users--" });
    assert.equal(r.sort, 'recent', 'an unknown key must fall back, not be used');
    /* And the real query must still have run: falling through to the degraded
       list would hide an injection behind a shrug. */
    assert.ok(r.rows.some((x) => x.spent > 0), 'the full query did not run');
    const { rows } = await pool.query(`SELECT count(*)::int n FROM users WHERE username LIKE 'tbl-%'`);
    assert.equal(rows[0].n, 3, 'the table is gone');
  });

  await check('nor can a ticket tier', async () => {
    const r = await T({ sort: 'ticket', tier: "green') , (SELECT 1", dir: 'desc' });
    /* Falls back to the first real tier — green — and orders by it. */
    assert.deepEqual(names(r), ['tbl-b', 'tbl-a', 'tbl-c']);
  });

  await check('nor a topic name', async () => {
    const r = await T({ sort: 'topic', topic: "x' OR '1'='1", dir: 'desc' });
    assert.equal(r.rows.length, 3);
    assert.ok(r.rows.every((x) => (x.topicTotal ?? 0) === 0), 'the topic filter was bypassed');
  });

  await wipe();
  console.log(`[adminUserTable] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
