/* A SESSION THAT SURVIVES A RESTART.
 *
 * «هرموقع برنامه رو می‌بندی دوباره کد می‌خواد… این‌طوری نبودا، جدیداً شد.»
 *
 * Sessions lived in a Map, and `refreshSession` refused any token it could not
 * find there. A Map lives in the process, so every restart of the API invalidated
 * every refresh token in the world at once — the JWT still had weeks left and
 * was signed by us; the server had simply forgotten. Every deploy logged
 * everybody out, which is exactly why it «started recently».
 *
 * The restart is what this file simulates, and it is the only way to test it:
 * the module's memory is cleared, as a restart clears it, and the same token is
 * presented again.
 *
 * Run: DATABASE_URL=postgres://postgres@localhost:55432/pztest npx tsx src/tests/sessionSurvives.test.ts
 */
import assert from 'node:assert/strict';
import { createSession, refreshSession, revokeRefreshToken, _resetSessions, pruneExpiredSessions } from '../services/sessionService.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

/** What a restart does: the process forgets, the database does not. */
const restart = () => _resetSessions();

(async () => {
  const withDb = !!process.env.DATABASE_URL;

  await check('a fresh session can be refreshed', async () => {
    const s = createSession('u-sess-1');
    const r = await refreshSession(s.refreshToken);
    assert.ok(r, 'a token minted a moment ago was refused');
    assert.notEqual(r!.refreshToken, s.refreshToken, 'the same refresh token came back');
  });

  await check('a refresh token cannot be used twice', async () => {
    /* It is rotated, so the old one is spent. Accepting it again would let a
       stolen token live alongside the real one. */
    const s = createSession('u-sess-2');
    assert.ok(await refreshSession(s.refreshToken));
    assert.equal(await refreshSession(s.refreshToken), null, 'the spent token was accepted again');
  });

  await check('logging out ends the session', async () => {
    const s = createSession('u-sess-3');
    assert.equal(await revokeRefreshToken(s.refreshToken), true);
    assert.equal(await refreshSession(s.refreshToken), null, 'a logged-out token still refreshes');
  });

  await check('a token nobody signed is refused', async () => {
    assert.equal(await refreshSession('not.a.token'), null);
    assert.equal(await refreshSession(''), null);
  });

  if (!withDb) {
    console.log('  — skipped: surviving a restart is a claim about storage, which needs Postgres');
    console.log(`[sessionSurvives] ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }

  /* ── THE BUG ITSELF ───────────────────────────────────────────────────── */

  await check('THE BUG: a session still works after the API restarts', async () => {
    const s = createSession('u-sess-restart');
    restart();                                   /* docker compose restart api */
    const r = await refreshSession(s.refreshToken);
    assert.ok(r, 'the restart logged this player out — they would be asked for the code again');
    assert.ok(r!.accessToken, 'no access token came back');
  });

  await check('and the new token from after the restart works too', async () => {
    const s = createSession('u-sess-chain');
    restart();
    const first = await refreshSession(s.refreshToken);
    assert.ok(first);
    restart();                                   /* deployed again an hour later */
    const second = await refreshSession(first!.refreshToken);
    assert.ok(second, 'the second restart logged them out');
  });

  await check('a restart does NOT bring a logged-out session back', async () => {
    /* The other half. If «forgotten» meant «allowed», then restarting the
       server would undo every logout — which is worse than the bug. */
    const s = createSession('u-sess-out');
    assert.equal(await revokeRefreshToken(s.refreshToken), true);
    restart();
    assert.equal(await refreshSession(s.refreshToken), null,
      'a restart resurrected a session that had been logged out');
  });

  await check('nor a token that was already spent', async () => {
    const s = createSession('u-sess-spent');
    const r = await refreshSession(s.refreshToken);
    assert.ok(r);
    restart();
    assert.equal(await refreshSession(s.refreshToken), null, 'a spent token worked again after a restart');
    /* …while the one that replaced it still does. */
    assert.ok(await refreshSession(r!.refreshToken), 'the live token was refused after a restart');
  });

  await check('expired rows can be swept up', async () => {
    const n = await pruneExpiredSessions();
    assert.ok(Number.isFinite(n), 'the sweep did not report what it did');
  });

  const { getPgPool } = await import('../database/postgres.js');
  await getPgPool().query(`DELETE FROM auth_sessions WHERE user_id LIKE 'u-sess-%'`).catch(() => {});
  console.log(`[sessionSurvives] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
