import type { IncomingMessage, ServerResponse } from 'node:http';
import { error } from './response.js';
import { id } from '../utils/id.js';
import { toAppError } from '../core/errors.js';
import { recordSecurityEvent } from '../services/securityEvents.js';
import { verifyAccessToken } from '../services/tokenService.js';
import { rateLimit } from '../middleware/rateLimiter.js';
import { logger } from '../services/logger.js';
import { recordHttpRequest } from '../services/metrics.js';
import { observeRequestDevice } from '../services/deviceRiskService.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Handler = (ctx: RequestContext) => Promise<void> | void;

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  userId?: string;
  role?: 'user' | 'admin';
  deviceId?: string;
  riskScore?: number;
}

interface Route {
  method: Method;
  path: string;
  parts: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: Method, path: string, handler: Handler): void {
    this.routes.push({ method, path, parts: path.split('/').filter(Boolean), handler });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const requestId = String(req.headers['x-request-id'] ?? id());
    res.setHeader('x-request-id', requestId);
    if (!rateLimit(req, res)) {
      recordHttpRequest({ method: req.method ?? 'GET', route: 'RATE_LIMITED', statusCode: res.statusCode, durationMs: performance.now() - started });
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = (req.method ?? 'GET') as Method;
    const pathParts = url.pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = match(route.parts, pathParts);
      if (!params) continue;
      try {
        const body = await parseBody(req);
        const auth = readAuth(req);
        const device = auth.userId ? await observeDeviceSafely(req, auth.userId) : null;
        await route.handler({ req, res, params, query: url.searchParams, body, userId: auth.userId, role: auth.role, deviceId: device?.device.id, riskScore: device?.riskProfile.riskScore });
      } catch (e) {
        const appError = toAppError(e);
        logger.error('request_failed', { method, path: url.pathname, code: appError.code, message: appError.message, status: appError.status });
        error(res, appError.status, appError.code, appError.message, appError.details);
      } finally {
        const durationMs = performance.now() - started;
        recordHttpRequest({ method, route: route.path, statusCode: res.statusCode, durationMs });
        logger.info('request_completed', { method, path: url.pathname, route: route.path, statusCode: res.statusCode, durationMs: Math.round(durationMs) });
      }
      return;
    }
    error(res, 404, 'NOT_FOUND', 'Route not found');
    recordHttpRequest({ method, route: 'NOT_FOUND', statusCode: 404, durationMs: performance.now() - started });
  }
}

function match(route: string[], path: string[]): Record<string, string> | null {
  if (route.length !== path.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < route.length; i++) {
    const r = route[i]!;
    const p = path[i]!;
    if (r.startsWith(':')) params[r.slice(1)] = decodeURIComponent(p);
    else if (r !== p) return null;
  }
  return params;
}

function parseBody(req: IncomingMessage): Promise<unknown> {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method ?? 'GET')) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk; if (raw.length > 1_000_000) reject(new Error('Payload too large')); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : undefined); } catch { reject(new Error('Invalid JSON')); } });
  });
}

function readAuth(req: IncomingMessage): { userId?: string; role?: 'user' | 'admin' } {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return {};
  const token = header.slice('Bearer '.length);
  const payload = verifyAccessToken(token);
  if (!payload) recordSecurityEvent({ req, eventType: 'INVALID_ACCESS_TOKEN', severity: 'warn' });
  return { userId: payload?.sub, role: payload?.role };
}

async function observeDeviceSafely(req: IncomingMessage, userId: string) {
  try {
    return await observeRequestDevice(req, userId);
  } catch (error) {
    logger.warn('device_observation_failed', { userId, message: error instanceof Error ? error.message : 'unknown' });
    return null;
  }
}
