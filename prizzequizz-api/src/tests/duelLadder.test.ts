/* THE DUEL LADDER PAYS ONCE, FOR THE RUNG REACHED.
 *
 * The report: «با بلیط سبز ۲۵٬۰۰۰ اضافه میشه، ادامه میده و برنده میشه دوباره
 * ۵۰٬۰۰۰، و بازم ۱۰۰٬۰۰۰ — ولی باید فقط ۹۵٬۰۰۰ اضافه بشه.»
 *
 * They are right, and it was worse than a display bug. The ladder is real: each
 * rung enqueues at double the value and deliberately spends NO new ticket. But
 * the server settled every match on its own, so three wins credited three full
 * pots — 25,000 + 50,000 + 100,000 — against a single 12,500 ticket. The
 * platform funded the difference on every run.
 *
 * The run is what gets settled now. Winning parks the pot, «ادامه» rolls it
 * into the next rung, and money moves exactly once: netPrize of the rung
 * reached. Losing closes the run with nothing, and only the one entry ticket
 * was ever spent.
 *
 * Run: npx tsx src/tests/duelLadder.test.ts
 */
import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { createApiServer } from '../app.js';
import { repositories } from '../repositories/index.js';
import { createSession } from '../services/sessionService.js';
import { createMatchForPlayers, startMatch, forfeitMatch, getMatch } from '../services/matchEngine.js';
import { id } from '../utils/id.js';
import { getAccount } from '../services/walletLedgerService.js';
import { netPrize, feeFor } from '../services/prizeService.js';
import {
  startRun, openRunFor, getRun, recordWin, recordLoss, advance, _resetDuelRuns, RUN_IDLE_SETTLE_MS
} from '../services/duelRunService.js';
import { settleRunToWallet, sweepIdleRuns } from '../services/duelRunPayout.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ': ' + (e as Error).message); }
}

async function player(name: string): Promise<string> {
  const userId = id();
  await repositories.users.save({
    id: userId, phone: '0912' + Math.floor(Math.random() * 1e7), username: 'n_' + userId.slice(0, 6),
    displayName: name, plan: 'premium', level: 1, xp: 0, weeklyScore: 0,
    wallet: 0, coins: 0, hearts: 5, tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  return userId;
}
const balance = async (userId: string) => (await getAccount(userId)).available;

async function main(): Promise<void> {
  process.env.REPOSITORY_DRIVER = 'memory';
  const server = createApiServer({ attachRealtime: false });
  server.listen(0);
  await once(server, 'listening');
  const port = (server.address() as any).port as number;
  const base = `http://127.0.0.1:${port}/v1`;

  try {
    _resetDuelRuns();

    /* The three rungs of a green entry: 12,500 → 25,000 → 50,000 a side. */
    const GREEN = 12_500;
    console.log('a green ticket climbed all the way:');

    const a = await player('A');
    const sa = createSession(a);
    const run = await startRun(a, 'green', GREEN);

    await check('winning the first rung pays nothing yet', async () => {
      await recordWin(run.id, GREEN * 2);
      assert.equal(await balance(a), 0, 'the wallet moved on a rung');
      const cur = await openRunFor(a);
      assert.equal(cur!.status, 'won');
      assert.equal(cur!.pendingGross, 25_000);
    });

    await check('«ادامه» doubles the stake without another ticket', async () => {
      const next = await advance(run.id);
      assert.equal(next!.stage, 2);
      assert.equal(next!.stake, 25_000, 'stake ' + next!.stake);
      assert.equal(next!.status, 'open');
      assert.equal(next!.entryTier, 'green', 'the run forgot which ticket opened it');
    });

    await check('and the second rung pays nothing either', async () => {
      await recordWin(run.id, 50_000);
      assert.equal(await balance(a), 0);
      assert.equal((await openRunFor(a))!.pendingGross, 50_000);
    });

    await check('the third rung is the last one that matters', async () => {
      await advance(run.id);
      const cur = await openRunFor(a);
      assert.equal(cur!.stage, 3);
      assert.equal(cur!.stake, 50_000);
      await recordWin(run.id, 100_000);
      assert.equal(await balance(a), 0, 'still nothing until they stop');
    });

    /* 100,000 gross, commission taken once → 95,000. The number in the report. */
    await check('«برداشت» pays the net of the rung reached, once', async () => {
      const res = await fetch(`${base}/duel-runs/current/cashout`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sa.accessToken}` },
        body: '{}'
      });
      const body = await res.json() as any;
      assert.equal(body.ok, true, JSON.stringify(body));
      assert.equal(body.data.paid, netPrize(100_000), 'paid ' + body.data.paid);
      assert.equal(body.data.paid, 100_000 - feeFor(100_000));
      assert.equal(await balance(a), netPrize(100_000), 'wallet ' + (await balance(a)));
    });

    await check('and not the sum of every rung it climbed', async () => {
      const bal = await balance(a);
      assert.notEqual(bal, 25_000 + 50_000 + 100_000, 'every rung paid again');
      assert.ok(bal <= 100_000, 'more than one pot reached the wallet: ' + bal);
    });

    await check('pressing it twice does not pay twice', async () => {
      const before = await balance(a);
      const res = await fetch(`${base}/duel-runs/current/cashout`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sa.accessToken}` }, body: '{}'
      });
      const body = await res.json() as any;
      assert.equal(body.data.paid, 0);
      assert.equal(await balance(a), before, 'a second tap moved money');
    });

    /* THE TRANSACTION THE PLAYER READS. It used to be the gross with the
       commission taken back on a separate row that players never see — so the
       list said «۱۰۰٬۰۰۰» for a prize that put 95,000 in the wallet. */
    await check('the transaction says what actually arrived', async () => {
      const res = await fetch(`${base}/wallet/transactions`, { headers: { authorization: `Bearer ${sa.accessToken}` } });
      const body = await res.json() as any;
      const rows: any[] = Array.isArray(body.data) ? body.data : (body.data?.rows ?? body.data?.items ?? []);
      const prize = rows.find((r) => Number(r.amount) > 0 && /جایزه/.test(String(r.description ?? r.title ?? '')));
      assert.ok(prize, 'no prize row found in ' + JSON.stringify(rows).slice(0, 300));
      assert.equal(Number(prize.amount), netPrize(100_000), 'the row says ' + prize.amount);
    });

    /* AND THE REAL PATH, not just the bookkeeping underneath it: a duel that
       actually ends must park the pot in the run instead of paying it out.
       This is the exact shape of the report — a rung won, money in the wallet
       that should not be there yet. */
    console.log('\na real duel finishing inside a run:');
    const d = await player('D');
    const e = await player('E');
    await startRun(d, 'green', GREEN);
    const live = await createMatchForPlayers(d, e, 'duel', 'v12500' as any, GREEN);
    await startMatch(live.id);
    /* Served a question = really played, so the entry is spent and the ending
       settles rather than voiding. */
    live.startedAt = new Date().toISOString();
    await repositories.matches.save(live);

    await check('a won duel puts nothing in the wallet while the run is open', async () => {
      await forfeitMatch(live.id, e);                 // E walks out, D wins
      const settled = await getMatch(live.id);
      assert.equal(settled.winnerUserId, d, 'winner ' + settled.winnerUserId);
      assert.equal(await balance(d), 0, 'the rung paid straight into the wallet: ' + (await balance(d)));
    });

    await check('it is parked in the run instead', async () => {
      const cur = await openRunFor(d);
      assert.ok(cur, 'the run vanished');
      assert.equal(cur!.status, 'won');
      assert.equal(cur!.pendingGross, GREEN * 2, 'parked ' + cur!.pendingGross);
    });

    await check('and stopping there pays the net of that one rung', async () => {
      const sd = createSession(d);
      const res = await fetch(`${base}/duel-runs/current/cashout`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sd.accessToken}` }, body: '{}'
      });
      const body = await res.json() as any;
      assert.equal(body.data.paid, netPrize(GREEN * 2), 'paid ' + body.data.paid);
      assert.equal(await balance(d), netPrize(25_000));
    });

    console.log('\na run that ends in a loss:');
    const b = await player('B');
    const runB = await startRun(b, 'green', GREEN);

    await check('a rung won and then a rung lost pays nothing at all', async () => {
      await recordWin(runB.id, 25_000);
      await advance(runB.id);
      await recordLoss(runB.id);
      assert.equal(await balance(b), 0, 'the burnt run paid ' + (await balance(b)));
      const cur = await openRunFor(b);
      assert.equal(cur, null, 'a lost run is still open');
      /* And the record says so too. A closed-as-lost run still carrying a
         figure is a lie in the books, and the day something reads the amount
         without checking the status it becomes money again. */
      const dead = await getRun(runB.id);
      assert.equal(dead!.status, 'lost');
      assert.equal(dead!.pendingGross, 0, 'a lost run still has ' + dead!.pendingGross + ' riding on it');
    });

    await check('and there is nothing left to cash out', async () => {
      const paid = await settleRunToWallet(runB.id, b);
      assert.equal(paid, 0);
      assert.equal(await balance(b), 0);
    });

    console.log('\na player who just walked away:');
    const c = await player('C');
    const runC = await startRun(c, 'green', GREEN);

    await check('a win left sitting is not swept while it is fresh', async () => {
      await recordWin(runC.id, 25_000);
      const swept = await sweepIdleRuns(Date.now());
      assert.equal(swept, 0, 'swept a run the player may still be looking at');
      assert.equal(await balance(c), 0);
    });

    await check('but their money is paid to them once it is clear they are gone', async () => {
      const later = Date.now() + RUN_IDLE_SETTLE_MS + 1000;
      const swept = await sweepIdleRuns(later);
      assert.equal(swept, 1, 'swept ' + swept);
      assert.equal(await balance(c), netPrize(25_000), 'wallet ' + (await balance(c)));
    });

    await check('and the sweeper does not pay the same run again', async () => {
      const before = await balance(c);
      await sweepIdleRuns(Date.now() + RUN_IDLE_SETTLE_MS * 5);
      assert.equal(await balance(c), before);
    });
  } finally {
    server.close();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}

await main();
