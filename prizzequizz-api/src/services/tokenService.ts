import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { appConfig } from '../core/config.js';

export interface TokenPayload {
  sub: string;
  typ: 'access' | 'refresh';
  role?: 'user' | 'admin';
  exp: number;
  iat: number;
  jti: string;
}

const accessSecret = process.env.JWT_ACCESS_SECRET || (appConfig.nodeEnv === 'production' ? '' : 'dev-access-secret');
const refreshSecret = process.env.JWT_REFRESH_SECRET || (appConfig.nodeEnv === 'production' ? '' : 'dev-refresh-secret');

if (appConfig.nodeEnv === 'production' && (!accessSecret || !refreshSecret)) {
  throw new Error('JWT secrets must be configured in production');
}

export function signAccessToken(userId: string, role: 'user' | 'admin' = 'user'): string {
  return sign({ sub: userId, typ: 'access', role, iat: now(), exp: now() + 15 * 60, jti: randomUUID() }, accessSecret);
}

export function signRefreshToken(userId: string, role: 'user' | 'admin' = 'user'): string {
  return sign({ sub: userId, typ: 'refresh', role, iat: now(), exp: now() + 30 * 24 * 60 * 60, jti: randomUUID() }, refreshSecret);
}

export function verifyAccessToken(token: string): TokenPayload | null {
  const payload = verify(token, accessSecret);
  return payload?.typ === 'access' ? payload : null;
}

export function verifyRefreshToken(token: string): TokenPayload | null {
  const payload = verify(token, refreshSecret);
  return payload?.typ === 'refresh' ? payload : null;
}

function sign(payload: TokenPayload, secret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = b64(JSON.stringify(header));
  const encodedPayload = b64(JSON.stringify(payload));
  const signature = hmac(`${encodedHeader}.${encodedPayload}`, secret);
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verify(token: string, secret: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];
  const expected = hmac(`${header}.${payload}`, secret);
  if (!safeEqual(sig, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenPayload;
    if (!parsed.exp || parsed.exp < now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function hmac(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function b64(input: string): string {
  return Buffer.from(input).toString('base64url');
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}
