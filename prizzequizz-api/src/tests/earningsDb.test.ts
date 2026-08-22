/* THE EARNINGS FIGURE, COMPUTED FOR REAL.
 *
 *   «در پنل مدیریت سود رو بد حساب میکنه… سود ما از درصد کمسیون بازی‌ها و
 *    تبلیغات و فروش آیتم‌ها در فروشگاه — به غیر از بلیط مسابقات — هست… و پات
 *    بدون برنده اونم باید جزیی از سود باشه.»
 *
 * earnings.test.ts checks the RULE — arithmetic on a literal, and the shape the
 * report hands back. It cannot check the sums, because financeReport reads a
 * database and returns an empty report without one: in memory the whole
 * computation is skipped, so a mutant that put ticket money back into the
 * profit survived every test in the suite.
 *
 * This one seeds a real ledger and a real house book and reads the answer off
 * the real function. Run with a database:
 *
 *     DATABASE_URL=postgres://... npx tsx src/tests/earningsDb.test.ts
 */
import assert from 'node:assert';

const DB = process.env.DATABASE_URL || '';
if (!DB) {
  console.log('earningsDb: SKIPPED — needs a real database (set DATABASE_URL).');
  console.log('The figure being tested is only ever computed against one.');
  process.exit(0);
}

let pass = 0, fail = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e: any) { fail++; console.log('  FAIL ' + name + '\n       ' + (e?.message || e)); }
}

const { getPgPool } = await import('../database/postgres.js');
const pool = getPgPool();
const { financeReport } = await import('../services/accountingService.js');
const { bookHouseRevenue } = await import('../services/houseRevenueService.js');

/* A clean slate for the period under test. Everything is stamped inside it so
   nothing another test left behind can drift into the answer. */
const DAY = '2031-03-05';
const FROM = DAY, TO = DAY;
const AT = DAY + ' 12:00:00';

/* The ledger references users, so one has to exist. The real table has more
   required columns than a stub would guess, so it is created by the app's own
   schema and filled in through the repository rather than by hand. */
const { repositories } = await import('../repositories/index.js');
const UID = '00000000-0000-4000-8000-0000000000e1';
/* Not swallowed: if the player cannot be created the ledger rows below fail on
   a foreign key and every figure reads zero, which would look like a passing
   test of an empty period rather than a broken setup. */
await repositories.users.save({
  id: UID, username: 'earner', displayName: 'earner', phone: '+989000000001',
  plan: 'free', role: 'user', status: 'active',
  wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, weeklyScore: 0,
  createdAt: new Date().toISOString()
} as any);
{
  const { rows } = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [UID]);
  assert.equal(rows.length, 1, 'the test player was not created — every figure would read zero');
}

await pool.query(`CREATE TABLE IF NOT EXISTS wallet_ledger (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  entry_type VARCHAR(32) NOT NULL,
  kind VARCHAR(8) NOT NULL DEFAULT 'debit',
  amount BIGINT NOT NULL DEFAULT 0,
  ref_type VARCHAR(32) NOT NULL DEFAULT '',
  ref_id TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
for (const col of [`metadata JSONB NOT NULL DEFAULT '{}'`, `ref_type VARCHAR(32) NOT NULL DEFAULT ''`, `ref_id TEXT NOT NULL DEFAULT ''`]) {
  await pool.query(`ALTER TABLE wallet_ledger ADD COLUMN IF NOT EXISTS ${col}`).catch(() => undefined);
}
/* THE LEDGER IS IMMUTABLE — a trigger refuses updates and deletes, which is
   exactly right for a book of money and means this test cannot tidy up after
   itself. So it does not: every row carries a fixed idempotency key and is
   written ON CONFLICT DO NOTHING, on a date no real traffic will ever land on.
   Running it twice leaves the same rows and the same answer. */
await pool.query(`CREATE TABLE IF NOT EXISTS house_revenue (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, ref_type TEXT NOT NULL DEFAULT '',
  ref_id TEXT NOT NULL DEFAULT '', amount BIGINT NOT NULL, description TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
let seq = 0;
const uid = () => '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0');
const KEY = (n: number) => 'earningsdb:' + DAY + ':' + n;
/* The real ledger table carries the running balances as NOT NULL. Nothing here
   reads them — the report sums `amount` — so they are written as zero rather
   than pretended to be a balance history. */
const entry = (entryType: string, amount: number, metadata: any = {}) =>
  pool.query(
    `INSERT INTO wallet_ledger(id,user_id,entry_type,kind,amount,
        available_before,available_after,locked_before,locked_after,
        idempotency_key,metadata,created_at)
     VALUES ($1,$2,$3,'debit',$4,0,0,0,0,$5,$6,$7)
     ON CONFLICT DO NOTHING`,
    [uid(), UID, entryType, amount, KEY(seq), JSON.stringify(metadata), AT]);

/* ── the money that came in ──────────────────────────────────────────────
   Chosen so every line is a different number: if two were swapped or one
   dropped, the total could not come out right by accident. */
await entry('fee', 1_000_000);                                     // duel + همه یا هیچ commission
await entry('ticket_purchase', 9_000_000);                         // NOT earnings
await entry('shop_purchase', 300_000, { category: 'util' });       // a real item
await entry('shop_purchase', 200_000, { category: 'coins' });      // a coin pack — earnings
await entry('shop_purchase', 700_000, { category: 'tickets' });    // a ticket sold in the shop — NOT earnings
await entry('lifeline_purchase', 150_000);
await entry('penalty', 50_000);
await entry('match_reward', 8_100_000);                            // paid out of the ticket money
await entry('deposit', 4_000_000);                                 // the player's own money arriving

/* ── and the money the game never saw ──────────────────────────────────── */
/* The house book HAS no immutability trigger, so this one can and must start
   clean: a leftover row from an earlier run is counted again and every figure
   comes out a multiple of what it should be. */
await pool.query(`DELETE FROM house_revenue WHERE created_at::date = $1::date`, [DAY]);
await pool.query(
  `INSERT INTO house_revenue(id,source,amount,created_at) VALUES
     ('earningsdb-rake','ls_rake',500000,$1),
     ('earningsdb-forf','ls_forfeited_pot',250000,$1),
     ('earningsdb-ads','ads',2000000,$1)
   ON CONFLICT (id) DO NOTHING`, [AT]);

/* THE SEED ITSELF IS CHECKED FIRST. Every figure below is read off a database,
   and a half-written seed produces wrong numbers that look like a wrong
   calculation — which is a long way to go to debug a fixture. */
{
  const led = await pool.query(
    `SELECT entry_type, sum(amount)::bigint AS total FROM wallet_ledger
      WHERE created_at::date = $1::date GROUP BY 1`, [DAY]);
  const got = new Map(led.rows.map((x: any) => [String(x.entry_type), Number(x.total)]));
  assert.strictEqual(got.get('fee'), 1_000_000, 'the ledger seed is not what this test assumes');
  assert.strictEqual(got.get('ticket_purchase'), 9_000_000, 'the ledger seed is not what this test assumes');
  assert.strictEqual(got.get('shop_purchase'), 1_200_000, 'the ledger seed is not what this test assumes');
  const hr = await pool.query(
    `SELECT source, sum(amount)::bigint AS total FROM house_revenue
      WHERE created_at::date = $1::date GROUP BY 1`, [DAY]);
  const hgot = new Map(hr.rows.map((x: any) => [String(x.source), Number(x.total)]));
  assert.strictEqual(hgot.get('ls_rake'), 500_000, 'the house book seed is doubled or missing');
  assert.strictEqual(hgot.get('ads'), 2_000_000, 'the house book seed is doubled or missing');
}

const r: any = await financeReport({ from: FROM, to: TO });
const e = r.earnings;

console.log('what the company earned that day:');
await check('the report ran against the database', () => {
  assert.equal(r.hasDatabase, true);
  assert.ok(e, 'no earnings block came back');
});

await check('commission is the fee rows', () => assert.strictEqual(e.commission, 1_000_000));
await check('Last Survivor’s commission comes from the house book', () => assert.strictEqual(e.lsRake, 500_000));
await check('so does the pot nobody won', () => assert.strictEqual(e.forfeitedPot, 250_000));
await check('advertising is what was entered by hand', () => assert.strictEqual(e.ads, 2_000_000));
await check('shop items are the ones that are not tickets or coins', () => assert.strictEqual(e.shopItems, 300_000));
await check('coin packs are their own line', () => assert.strictEqual(e.coins, 200_000));
await check('helps are their own line, counted once', () => assert.strictEqual(e.lifelines, 150_000));
await check('fines are their own line', () => assert.strictEqual(e.penalties, 50_000));

/* THE POINT OF THE WHOLE CHANGE. */
await check('ticket money is NOT in the profit', () => {
  assert.strictEqual(e.total, 1_000_000 + 500_000 + 250_000 + 300_000 + 200_000 + 150_000 + 2_000_000 + 50_000);
  assert.strictEqual(e.total, 4_450_000);
});
await check('and neither is a ticket sold from the shop’s own shelf', () => {
  /* 700,000 of tickets went through shop_purchase. If the shelf were ignored it
     would be sitting in shopItems and the total would be 700,000 higher. */
  assert.ok(e.shopItems < 700_000, 'shop earnings include ticket sales: ' + e.shopItems);
  assert.strictEqual(e.ticketsExcluded, 9_000_000 + 700_000);
});
await check('the prizes paid out of it are reported, not subtracted', () => {
  assert.strictEqual(e.prizesExcluded, 8_100_000);
  assert.ok(e.total > 0, 'prizes were taken off the profit: ' + e.total);
});
await check('deposits are nobody’s earnings', () => {
  assert.ok(e.total < 4_000_000 + 4_450_000, 'a deposit reached the profit');
});

/* ── THE CASH-FLOW FIGURE IS STILL SHOWN, SO IT STILL HAS TO BE RIGHT ────
   «گردش پول» answers a different question — did more arrive this month than
   left — and the panel prints it under the profit. */
await check('the cash-flow figure is a different number', () => {
  assert.notStrictEqual(r.grossProfit, e.total);
});
await check('helps are counted ONCE in the cash-flow income too', () => {
  /* They used to be added into the shop line AND kept as their own, so every
     help sold was counted twice in the total. */
  assert.strictEqual(r.income.shop, 300_000 + 200_000, 'the shop line has helps folded into it: ' + r.income.shop);
  assert.strictEqual(r.income.lifelines, 150_000);
});
await check('and a ticket sold from the shop is still counted as money in', () => {
  /* Kept out of the SHOP line because it is not earnings — but it did arrive,
     so leaving it in no line at all would make the cash-flow figure short. */
  assert.strictEqual(r.income.tickets, 9_000_000 + 700_000);
});
await check('the cash-flow income adds its own lines up', () => {
  assert.strictEqual(r.income.total,
    r.income.commission + r.income.tickets + r.income.shop + r.income.lifelines + r.income.penalties);
  assert.strictEqual(r.income.total, 1_000_000 + 9_700_000 + 500_000 + 150_000 + 50_000);
});

await check('net is the total less what the company spent', () => {
  assert.strictEqual(e.net, e.total - r.expenses.total);
});

/* ── nothing at all, on a day nothing happened ─────────────────────────── */
await check('an empty day earns nothing rather than something odd', async () => {
  const q: any = await financeReport({ from: '2031-03-06', to: '2031-03-06' });
  assert.strictEqual(q.earnings.total, 0);
  assert.strictEqual(q.earnings.ticketsExcluded, 0);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await pool.end?.();
process.exit(fail ? 1 : 0);
