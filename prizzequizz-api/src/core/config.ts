import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

export const appConfig = {
  port: Number(process.env.PORT ?? 3000),
  basePath: process.env.API_BASE_PATH ?? '/v1',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  appVersion: process.env.APP_VERSION ?? '0.1.0-dev',
  buildId: process.env.BUILD_ID ?? 'local',
  publicAppUrl: process.env.PUBLIC_APP_URL ?? 'http://localhost:4173',
  publicApiUrl: process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 3000}${process.env.API_BASE_PATH ?? '/v1'}`
};

export const gameConfig = JSON.parse(readFileSync(resolve(root, 'config/game-config.json'), 'utf8')) as any;
