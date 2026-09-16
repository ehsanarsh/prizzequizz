/* THE RED RESET BUTTONS — THE ONES THAT DID NOTHING.
 *
 * «قسمت ریست، اونایی که دکمه قرمز دارن یعنی ریست‌های حساس، کار نمیکنه. وقتی کلمه
 *  RESET رو می‌نویسم و تأیید رو می‌زنی ارور می‌ده.»
 *
 * Two errors, both from the database, both meaning the same thing: the reset
 * named one table and forgot what the database knows about it.
 *
 *   wallet_ledger rows are immutable
 *   update or delete on table "transactions" violates foreign key constraint
 *   "payment_intents_transaction_id_fkey" on table "payment_intents"
 *
 * Neither is reachable without a REAL Postgres: the trigger and the foreign key
 * ARE the test. On the memory driver every one of these resets "passes" by
 * doing nothing, which is how they shipped broken — so this file says so out
 * loud and skips rather than pretending.
 *
 * Run: DATABASE_URL=… npx tsx src/tests/resetAreas.test.ts */
import assert from 'node:assert/strict';
import { getPgPool } from '../database/postgres.js';
import { RESET_AREAS, resetArea } from '../services/adminOpsService.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

if (!process.env.DATABASE_URL) {
  console.log('  — skipped: the trigger and the foreign keys only exist on Postgres, and they are what is being tested');
  console.log('[resetAreas] 0 passed, 0 failed');
  process.exit(0);
}

const pool = getPgPool();
const q = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows;
const count = async (t: string): Promise<number> => {
  try { return Number((await q(`SELECT count(*)::int n FROM ${t}`))[0].n); } catch { return -1; }
};

/* NO SCHEMA IS BUILT HERE. This runs against the MIGRATED database, because
 * the trigger and the foreign keys are the subject: a hand-rolled table would
 * only ever prove that my idea of the schema agrees with itself. The two tables
 * the accounting reset uses are created at runtime by their own services, so
 * those are the only ones asked for. */
async function ensureAccountingTables(): Promise<void> {
  await q(`CREATE TABLE IF NOT EXISTS company_expenses (id TEXT PRIMARY KEY, title TEXT NOT NULL,
    category VARCHAR(40) DEFAULT 'other', amount BIGINT NOT NULL DEFAULT 0,
    spent_at DATE DEFAULT current_date, note TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS shop_purchases (id TEXT PRIMARY KEY, user_id TEXT, item_id TEXT,
    price BIGINT DEFAULT 0, currency VARCHAR(12) DEFAULT 'cash', created_at TIMESTAMPTZ DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS house_revenue (id TEXT PRIMARY KEY, amount BIGINT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS monitor_servers (id TEXT PRIMARY KEY, name TEXT,
    hourly_cost BIGINT NOT NULL DEFAULT 0)`);
}

const U = '11111111-1111-4111-8111-111111111111';
const M = '22222222-2222-4222-8222-222222222222';
const T = '33333333-3333-4333-8333-333333333333';
const P = '44444444-4444-4444-8444-444444444444';

/** One of everything, in the real tables, so a reset has something to fail on. */
async function seed(): Promise<void> {
  await q(`INSERT INTO users(id, phone, username, display_name, wallet_balance, xp, level)
           VALUES ($1,'0912000','p_reset','بازیکن',50000,900,7)
           ON CONFLICT (id) DO UPDATE SET wallet_balance=50000, xp=900, level=7`, [U]);
  await q(`INSERT INTO matches(id, mode_id, economy_type, status, config_version)
           VALUES ($1,'duel','free','finished','v1') ON CONFLICT (id) DO NOTHING`, [M]);
  await q(`INSERT INTO match_players(match_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [M, U]);
  await q(`INSERT INTO answers(id, match_id, user_id, correct, idempotency_key)
           VALUES (gen_random_uuid(),$1,$2,true,'k_'||gen_random_uuid())`, [M, U]);
  await q(`INSERT INTO transactions(id, user_id, type, currency, amount, direction, status)
           VALUES ($1,$2,'purchase','cash',25000,'debit','completed') ON CONFLICT (id) DO NOTHING`, [T, U]);
  await q(`INSERT INTO payment_intents(id, user_id, provider, amount, currency, status, transaction_id,
             payment_url, idempotency_key)
           VALUES ($1,$2,'blupal',25000,'cash','paid',$3,'https://pay.example/x',$4)
           ON CONFLICT (id) DO NOTHING`, [P, U, T, 'k_reset_' + P]);
  await q(`INSERT INTO wallet_ledger(id,user_id,entry_type,kind,amount,available_before,available_after,
             locked_before,locked_after,idempotency_key)
           VALUES (gen_random_uuid(),$1,'deposit','credit',50000,0,50000,0,0,'k_'||gen_random_uuid())`, [U]);
  await q(`INSERT INTO wallet_accounts(user_id, available) VALUES ($1,50000)
           ON CONFLICT (user_id) DO UPDATE SET available=50000`, [U]);
  await q(`INSERT INTO company_expenses(id,title,amount) VALUES ('e1','سرور',900000) ON CONFLICT (id) DO NOTHING`);
  await q(`INSERT INTO shop_purchases(id,user_id,item_id,price) VALUES ('s1','u1','i1',12000) ON CONFLICT (id) DO NOTHING`);
  await q(`INSERT INTO house_revenue(id, amount) VALUES ('h1', 400000) ON CONFLICT (id) DO NOTHING`);
  await q(`INSERT INTO monitor_servers(id,name,hourly_cost) VALUES ('m1','vps',1200)
           ON CONFLICT (id) DO UPDATE SET hourly_cost=1200`);
}

(async () => {
  await ensureAccountingTables();

  /* ── THE LEDGER ───────────────────────────────────────────────────────── */
  await check('the ledger really does refuse an ordinary DELETE', async () => {
    await seed();
    await assert.rejects(() => pool.query('DELETE FROM wallet_ledger'), /immutable/,
      'the guard this test exists for is not installed — the rest proves nothing');
  });

  await check('and the prize-vault reset clears it anyway', async () => {
    await seed();
    assert.ok(await count('wallet_ledger') > 0, 'nothing to clear');
    await resetArea('wallet');
    assert.equal(await count('wallet_ledger'), 0, 'the ledger still has rows in it');
    assert.equal(await count('wallet_accounts'), 0);
    assert.equal(Number((await q(`SELECT wallet_balance b FROM users WHERE id=$1`, [U]))[0].b), 0, 'the mirror on users was left');
  });

  await check('and the guard is back on afterwards', async () => {
    /* Lifted for one transaction, not for good. A reset that leaves the ledger
       writable is a worse outcome than a reset that fails. */
    await q(`INSERT INTO wallet_ledger(id,user_id,entry_type,kind,amount,available_before,available_after,
               locked_before,locked_after,idempotency_key)
             VALUES (gen_random_uuid(),$1,'deposit','credit',7,0,7,0,0,'k_'||gen_random_uuid())`, [U]);
    await assert.rejects(() => pool.query('DELETE FROM wallet_ledger'), /immutable/,
      'the ledger is still deletable — the trigger was never put back');
    await resetArea('wallet');
  });

  /* ── THE FOREIGN KEY ──────────────────────────────────────────────────── */
  await check('a payment intent really does hold its transaction down', async () => {
    await seed();
    await assert.rejects(() => pool.query('DELETE FROM transactions'), /foreign key|violates/,
      'the constraint from the error message is not here');
  });

  await check('and the transactions reset clears both, in the right order', async () => {
    await seed();
    await resetArea('transactions');
    assert.equal(await count('transactions'), 0, 'transactions survived');
    assert.equal(await count('payment_intents'), 0, 'the intents pointing at them survived');
  });

  await check('the match history takes its answers with it', async () => {
    await seed();
    await resetArea('matchHistory');
    assert.equal(await count('matches'), 0, 'matches survived');
    assert.equal(await count('match_players'), 0);
    assert.equal(await count('answers'), 0, 'answers still point at matches that are gone');
  });

  /* ── THE COMPANY'S OWN BOOKS ──────────────────────────────────────────── */
  await check('accounting starts the company from zero', async () => {
    /* «برای اعداد و ارقام حسابداری هم یه ریست بذار، یعنی انگار شرکت از صفر
       شروع می‌شه.» */
    await seed();
    await resetArea('accounting');
    assert.equal(await count('company_expenses'), 0, 'expenses survived');
    assert.equal(await count('shop_purchases'), 0, 'the sales log survived');
    assert.equal(await count('house_revenue'), 0, 'the house’s take survived');
    assert.equal(Number((await q(`SELECT hourly_cost c FROM monitor_servers WHERE id='m1'`))[0].c), 0,
      'the price on the machine was left');
  });

  await check('and it does not touch anybody’s money', async () => {
    /* The company's books and a player's wallet are different things. Clearing
       what the company spent must not clear what a player is owed. */
    await seed();
    await resetArea('accounting');
    assert.ok(await count('wallet_ledger') > 0, 'the accounting reset emptied the ledger');
    assert.ok(await count('wallet_accounts') > 0, 'the accounting reset emptied the wallet accounts');
    assert.ok(await count('transactions') > 0, 'the accounting reset took the transactions with it');
    assert.equal(Number((await q(`SELECT wallet_balance b FROM users WHERE id=$1`, [U]))[0].b), 50000,
      'a player’s balance was changed by an accounting reset');
  });

  /* ── AND THE BIG ONE ──────────────────────────────────────────────────── */
  await check('«full» runs every area without stopping at the first refusal', async () => {
    await seed();
    await resetArea('full');
    for (const t of ['wallet_ledger', 'wallet_accounts', 'transactions', 'payment_intents',
                     'matches', 'match_players', 'answers', 'company_expenses']) {
      assert.equal(await count(t), 0, t + ' survived a full reset');
    }
  });

  await check('a broken area is reported by name and the others still run', async () => {
    /* «ریست کامل» is thirteen areas in a row. The first refusal used to throw
       and the other twelve never happened — so one missing table on one server
       meant the whole button did nothing, silently. A table is taken away here
       on purpose: the rest must still clear, and the failure must come back
       with a name on it rather than as a shrug. */
    await seed();
    await q(`ALTER TABLE notifications RENAME TO notifications_hidden_for_test`);
    try {
      const r = await resetArea('full');
      assert.ok(r.failed.length > 0, 'a missing table went unreported');
      assert.match(r.failed.join(' '), /notifications/, 'the report does not say which area: ' + r.failed.join(' '));
      assert.equal(await count('wallet_ledger'), 0, 'the areas AFTER the failure never ran');
      assert.equal(await count('company_expenses'), 0, 'the areas after the failure never ran');
    } finally {
      await q(`ALTER TABLE notifications_hidden_for_test RENAME TO notifications`);
    }
  });

  await check('every area the panel offers can actually be run', async () => {
    /* The panel builds its buttons from RESET_AREAS, so an area that throws is
       a red button that does nothing — which is the whole complaint. */
    const broke: string[] = [];
    for (const a of RESET_AREAS) {
      await seed();
      try { await resetArea(a); } catch (e) { broke.push(a + ': ' + (e as Error).message.slice(0, 60)); }
    }
    assert.equal(broke.join(' | '), '', 'these areas still throw');
  });

  console.log(`[resetAreas] ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  process.exit(0);
})();
