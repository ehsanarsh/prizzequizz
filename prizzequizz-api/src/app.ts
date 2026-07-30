import { createServer, type Server } from 'node:http';
import { appConfig } from './core/config.js';
import { Router } from './http/router.js';
import { json } from './http/response.js';
import { seedMemory } from './repositories/memory.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { registerUserRoutes } from './modules/users/routes.js';
import { registerMatchRoutes } from './modules/matches/routes.js';
import { registerMatchmakingRoutes } from './modules/matchmaking/routes.js';
import { registerLeaderboardRoutes } from './modules/leaderboards/routes.js';
import { registerNotificationRoutes } from './modules/notifications/routes.js';
import { registerDeviceRoutes } from './modules/devices/routes.js';
import { registerCharacterRoutes } from './modules/characters/routes.js';
import { registerPaymentRoutes } from './modules/payments/routes.js';
import { registerMonitoringRoutes } from './modules/monitoring/routes.js';
import { registerBetaRoutes } from './modules/beta/routes.js';
import { registerQuestionRoutes } from './modules/questions/routes.js';
import { registerWalletRoutes } from './modules/wallet/routes.js';
import { registerFriendRoutes } from './modules/friends/routes.js';
import { registerSupportRoutes } from './modules/support/routes.js';
import { registerOpsRoutes } from './modules/ops/routes.js';
import { registerShopRoutes } from './modules/shop/routes.js';
import { registerLastSurvivorRoutes } from './modules/lastSurvivor/routes.js';
import { registerSmsRoutes } from './modules/sms/routes.js';
import { registerAdminRoutes } from './modules/admin/routes.js';
import { attachRealtimeGateway } from './realtime/gateway.js';
import { startMatchmakingWorker } from './services/matchmakingWorker.js';
import { startLastSurvivorWorker } from './services/lastSurvivorWorker.js';

export interface ApiServerOptions {
  attachRealtime?: boolean;
  seed?: boolean;
}

export function createApiServer(options: ApiServerOptions = {}): Server {
  if (options.seed !== false) seedMemory();

  const router = new Router();
  const base = appConfig.basePath;

  router.add('GET', `${base}/health`, (ctx) => json(ctx.res, 200, { status: 'ok', service: 'prizzequizz-api', env: appConfig.nodeEnv, version: appConfig.appVersion, buildId: appConfig.buildId }));
  router.add('GET', `${base}/release`, (ctx) => json(ctx.res, 200, { service: 'prizzequizz-api', version: appConfig.appVersion, buildId: appConfig.buildId, env: appConfig.nodeEnv, checkedAt: new Date().toISOString() }));
  registerAuthRoutes(router, base);
  registerUserRoutes(router, base);
  registerMatchRoutes(router, base);
  registerMatchmakingRoutes(router, base);
  registerLeaderboardRoutes(router, base);
  registerNotificationRoutes(router, base);
  registerDeviceRoutes(router, base);
  registerCharacterRoutes(router, base);
  registerPaymentRoutes(router, base);
  registerMonitoringRoutes(router, base);
  registerBetaRoutes(router, base);
  registerQuestionRoutes(router, base);
  registerWalletRoutes(router, base);
  registerFriendRoutes(router, base);
  registerSupportRoutes(router, base);
  registerOpsRoutes(router, base);
  registerShopRoutes(router, base);
  registerLastSurvivorRoutes(router, base);
  registerSmsRoutes(router, base);
  registerAdminRoutes(router, base);

  const server = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type,authorization,x-device-id,x-device-fingerprint,x-platform,x-admin-key');
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    void router.handle(req, res);
  });

  if (options.attachRealtime !== false) attachRealtimeGateway(server);
  if (process.env.MATCHMAKING_WORKER !== 'false') startMatchmakingWorker();
  if (process.env.LAST_SURVIVOR_WORKER !== 'false') startLastSurvivorWorker();
  return server;
}
