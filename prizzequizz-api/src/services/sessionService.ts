import { id } from '../utils/id.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from './tokenService.js';

export interface SessionRecord {
  id: string;
  userId: string;
  refreshJti: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}

const sessions = new Map<string, SessionRecord>();

export function createSession(userId: string, role: 'user' | 'admin' = 'user'): { accessToken: string; refreshToken: string; sessionId: string } {
  const accessToken = signAccessToken(userId, role);
  const refreshToken = signRefreshToken(userId, role);
  const payload = verifyRefreshToken(refreshToken)!;
  const sessionId = id();
  sessions.set(sessionId, {
    id: sessionId,
    userId,
    refreshJti: payload.jti,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(payload.exp * 1000).toISOString()
  });
  return { accessToken, refreshToken, sessionId };
}

export function refreshSession(refreshToken: string): { accessToken: string; refreshToken: string; sessionId: string } | null {
  const payload = verifyRefreshToken(refreshToken);
  if (!payload) return null;
  const existing = [...sessions.values()].find((s) => s.userId === payload.sub && s.refreshJti === payload.jti && !s.revokedAt);
  if (!existing) return null;
  existing.revokedAt = new Date().toISOString();
  return createSession(payload.sub, payload.role ?? 'user');
}

export function revokeRefreshToken(refreshToken: string): boolean {
  const payload = verifyRefreshToken(refreshToken);
  if (!payload) return false;
  const session = [...sessions.values()].find((s) => s.userId === payload.sub && s.refreshJti === payload.jti && !s.revokedAt);
  if (!session) return false;
  session.revokedAt = new Date().toISOString();
  return true;
}
