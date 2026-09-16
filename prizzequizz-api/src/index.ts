import { appConfig } from './core/config.js';
import { createApiServer } from './app.js';
import { loadPersistedConfig } from './services/configService.js';
import { startScheduler } from './services/scheduledNotificationService.js';
import { ensureOwnerSeed, refreshTokenCache } from './services/adminAccountService.js';
import { ensureUsernameIndex } from './services/usernameService.js';

/* A BACKGROUND TIMER MUST NOT BE ABLE TO KILL THE GAME.
 *
 * The API exited(1) in production and stayed down for ten hours because a
 * scheduled-notification sweep hit a one-second Postgres connection timeout.
 * The sweep is a floating promise, so Node saw an unhandled rejection and did
 * what Node does: it ended the process. Nobody was playing a quiz that needed
 * ending; a notification was simply going to be late.
 *
 * Each loop guards itself — that is the real fix and it is done. This is the
 * net under it, because the next unguarded await will be written by someone
 * who did not read this comment. It logs at error level with the stack so the
 * bug is loud rather than hidden, and keeps serving.
 *
 * uncaughtException is deliberately NOT swallowed the same way: a synchronous
 * throw that escapes to here means state we cannot reason about, and carrying
 * on with a half-finished match is worse than restarting. It is logged and
 * then rethrown, so `restart: unless-stopped` brings the API straight back.
 */
process.on('unhandledRejection', (reason) => {
  const e = reason instanceof Error ? reason : new Error(String(reason));
  console.error('[PrizzeQuizz API] unhandled_rejection', e.message, e.stack);
});
process.on('uncaughtException', (error) => {
  console.error('[PrizzeQuizz API] uncaught_exception', error.message, error.stack);
  throw error;
});

const server = createApiServer();

// Apply any admin config overrides saved in the DB BEFORE we start serving, so
// edits made in the panel survive container restarts / rebuilds.
loadPersistedConfig()
  .catch(() => { /* no DB / first boot → ship the on-disk defaults */ })
  .finally(() => {
    startScheduler();   // deliver admin-scheduled notifications at their set times
    // Seed the owner admin account + warm the token cache so account logins work.
    ensureOwnerSeed().then(() => refreshTokenCache()).catch(() => { /* first boot / no DB */ });
    /* The unique index that makes two players with the same name impossible
       rather than unlikely. Best-effort and never fatal: a database that already
       holds the duplicates cannot take the index, and refusing to start over a
       name would take the whole game down. It says which names are in the way. */
    ensureUsernameIndex()
      .then((r) => {
        if (r.blockedBy.length) {
          console.warn('[PrizzeQuizz API] duplicate usernames block the unique index — rename one of each pair: ' + r.blockedBy.join(' ; '));
        }
      })
      .catch(() => { /* no DB yet */ });
    server.listen(appConfig.port, () => {
      console.log(`[PrizzeQuizz API] listening on http://localhost:${appConfig.port}${appConfig.basePath}`);
    });
  });
