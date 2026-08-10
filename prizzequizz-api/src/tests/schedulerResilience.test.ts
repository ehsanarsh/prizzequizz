/* THE BACKGROUND SWEEP THAT TOOK THE GAME DOWN.
 *
 * Production log, verbatim, right before the container exited(1):
 *
 *   ls_tick_list_failed  "Connection terminated due to connection timeout"
 *   Error: Connection terminated due to connection timeout
 *       at async dispatchDue (…/scheduledNotificationService.js:133:30)
 *   Node.js v20.20.2
 *
 * Postgres was unreachable for one moment. The Last Survivor worker caught its
 * own failure and logged a warning — that loop was written defensively. The
 * notification sweep was not: its claim query sat inside try/finally with no
 * catch, and the scheduler calls it as a floating `void dispatchDue()`. Node
 * saw an unhandled rejection and ended the process, and the whole game was
 * down for ten hours because nothing restarted it.
 *
 * The cost of the failure it was "protecting" against: a notification arriving
 * twenty seconds late.
 *
 * Run: npx tsx src/tests/schedulerResilience.test.ts
 */
import assert from 'node:assert/strict';
import { dispatchDue, startScheduler } from '../services/scheduledNotificationService.js';
import { closePgPool } from '../database/postgres.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  \u2714 ' + name); }
  catch (e) { failed++; console.error('  \u2718 ' + name + ': ' + (e as Error).message); }
}

/* A REAL unreachable database rather than a stub: port 1 refuses immediately,
 * which is the same class of failure as the production timeout and goes
 * through the actual pg pool the service uses. ESM exports cannot be
 * reassigned anyway, so a mock was never an option here. */
async function withUnreachablePg<T>(fn: () => Promise<T>): Promise<T> {
  const realUrl = process.env.DATABASE_URL;
  const realTimeout = process.env.PG_CONNECTION_TIMEOUT_MS;
  await closePgPool();
  process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:1/nope';
  process.env.PG_CONNECTION_TIMEOUT_MS = '300';
  try {
    return await fn();
  } finally {
    await closePgPool().catch(() => undefined);
    if (realUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = realUrl;
    if (realTimeout === undefined) delete process.env.PG_CONNECTION_TIMEOUT_MS; else process.env.PG_CONNECTION_TIMEOUT_MS = realTimeout;
  }
}

async function run(): Promise<void> {
  await check('a sweep against a timing-out database does not throw', async () => {
    await withUnreachablePg(async () => {
      const fired = await dispatchDue();
      assert.equal(fired, 0, 'nothing was delivered, and that is all that happened');
    });
  });

  await check('and it does not leave itself latched shut', async () => {
    /* dispatchDue refuses to run while another sweep is in flight. If the
       failing path skipped the reset, the scheduler would go quiet for good
       even after the database came back. */
    await withUnreachablePg(async () => { await dispatchDue(); });
    const fired = await dispatchDue();
    assert.equal(typeof fired, 'number', 'the next sweep still runs');
  });

  await check('no unhandled rejection escapes the scheduler timer', async () => {
    /* The real killer was not the throw — it was that nobody was listening.
       This asserts on the process, which is where the damage happened. */
    const seen: string[] = [];
    const onUnhandled = (r: unknown) => seen.push(r instanceof Error ? r.message : String(r));
    process.on('unhandledRejection', onUnhandled);
    try {
      await withUnreachablePg(async () => {
        startScheduler();
        await dispatchDue();
        // Give any floating promise a chance to reject and be reported.
        await new Promise((r) => setTimeout(r, 150));
      });
    } finally { process.off('unhandledRejection', onUnhandled); }
    assert.deepEqual(seen, [], 'nothing reached the process as unhandled');
  });

  await check('the process survives an unhandled rejection from anywhere else', async () => {
    /* The net under the guards. Without the handler installed in index.ts this
       is what exits the process. */
    const { readFileSync } = await import('node:fs');
    const entry = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    assert.match(entry, /process\.on\('unhandledRejection'/, 'the net is installed at the entry point');
    assert.doesNotMatch(entry.split("process.on('unhandledRejection'")[1]!.slice(0, 300), /process\.exit/, 'and it does not itself exit');
  });

  console.log(`[schedulerResilience] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
