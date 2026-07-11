import { appConfig } from './core/config.js';
import { createApiServer } from './app.js';

const server = createApiServer();

server.listen(appConfig.port, () => {
  console.log(`[PrizzeQuizz API] listening on http://localhost:${appConfig.port}${appConfig.basePath}`);
});
