import type { ServerResponse } from 'node:http';
import { id } from '../utils/id.js';

export function json(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: true, data, requestId: String(res.getHeader('x-request-id') ?? id()) }));
}

export function error(res: ServerResponse, status: number, code: string, message: string, details?: Record<string, unknown>): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: false, error: { code, message, status, details }, requestId: String(res.getHeader('x-request-id') ?? id()) }));
}
