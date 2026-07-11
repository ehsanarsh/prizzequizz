import type { PrizzeQuizzApi } from './client';
import { createHttpApi } from './httpAdapter';
import { createMockApi } from './mockAdapter';
import { MockRealtimeClient, WebSocketRealtimeClient } from './realtime';

const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;

export const api: PrizzeQuizzApi = baseUrl
  ? createHttpApi({ baseUrl, getToken: () => localStorage.getItem('pq_access_token'), retries: 1 })
  : createMockApi();

function realtimeUrl(): string {
  if (!baseUrl) return '';
  const url = new URL(baseUrl, window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = url.pathname.replace(/\/$/, '') + '/realtime';
  const token = localStorage.getItem('pq_access_token');
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

export const realtime = baseUrl ? new WebSocketRealtimeClient(realtimeUrl) : new MockRealtimeClient();

export * from './contracts';
export * from './client';
export * from './errors';
export * from './realtime';
