import { appConfig } from './core/config.js';
import { createApiServer } from './app.js';
import { loadPersistedConfig } from './services/configService.js';
import { startScheduler } from './services/scheduledNotificationService.js';

const server = createApiServer();

// Apply any admin config overrides saved in the DB BEFORE we start serving, so
// edits made in the panel survive container restarts / rebuilds.
loadPersistedConfig()
  .catch(() => { /* no DB / first boot → ship the on-disk defaults */ })
  .finally(() => {
    startScheduler();   // deliver admin-scheduled notifications at their set times
    server.listen(appConfig.port, () => {
      console.log(`[PrizzeQuizz API] listening on http://localhost:${appConfig.port}${appConfig.basePath}`);
    });
  });
