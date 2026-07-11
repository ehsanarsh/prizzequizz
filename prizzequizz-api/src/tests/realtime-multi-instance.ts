import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApiServer } from '../app.js';

async function main(): Promise<void> {
  process.env.REPOSITORY_DRIVER = 'memory';
  const a = createApiServer({ attachRealtime: true });
  const b = createApiServer({ attachRealtime: true, seed: false });
  a.listen(0); b.listen(0);
  await Promise.all([once(a, 'listening'), once(b, 'listening')]);
  const pa = (a.address() as any).port as number;
  const pb = (b.address() as any).port as number;
  const base = `http://127.0.0.1:${pa}/v1`;
  try {
    const verified = await post<{ accessToken: string }>(`${base}/auth/otp/verify`, { requestId: (await post<{ requestId: string }>(`${base}/auth/login`, { phone: '+989120000000' })).requestId, code: '1234' });
    const auth = { authorization: `Bearer ${verified.accessToken}` };
    const match = await post<{ matchId: string }>(`${base}/matches`, { modeId: 'duel', economyType: 'free', entry: { coinStake: 25 } }, auth);
    await post(`${base}/matches/${match.matchId}/start`, {}, auth);

    const ws1 = await connect(pa, verified.accessToken);
    const ws2 = await connect(pb, verified.accessToken);
    const m1: any[] = []; const m2: any[] = [];
    ws1.on('message', (raw) => m1.push(JSON.parse(String(raw))));
    ws2.on('message', (raw) => m2.push(JSON.parse(String(raw))));
    // server:connected may arrive before the test listener is attached; join_match is the reliable readiness check.
    ws1.send(JSON.stringify({ type: 'client:join_match', payload: { matchId: match.matchId } }));
    ws2.send(JSON.stringify({ type: 'client:join_match', payload: { matchId: match.matchId } }));
    await waitFor(() => m1.some((m) => m.type === 'server:presence') && m2.some((m) => m.type === 'server:presence'));

    ws1.send(JSON.stringify({ type: 'client:send_chat', payload: { matchId: match.matchId, text: 'cross-instance' } }));
    await waitFor(() => m2.some((m) => m.type === 'server:chat' && m.payload?.text === 'cross-instance'));

    ws1.close(); ws2.close();
    console.log('[realtime-multi-instance] smoke passed');
  } finally {
    a.close(); b.close();
  }
}

async function connect(port: number, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime?token=${encodeURIComponent(token)}`);
  await once(ws, 'open');
  return ws;
}

async function post<T = any>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const payload = await res.json() as any;
  if (!payload.ok) throw new Error(payload.error?.message ?? 'request failed');
  return payload.data as T;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1800): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('waitFor timeout');
}

main().catch((error) => { console.error(error); process.exit(1); });
