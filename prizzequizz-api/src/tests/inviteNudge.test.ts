/* «هیچ دعوتی نمیره و اگه بره هم با خیلی تاخیر میره.»
 *
 * An invite lives sixty seconds and was only ever found by a poll that ran every
 * twelve. So the fastest possible answer was «some time in the next twelve
 * seconds», the average was six, and a player who happened to be on one of the
 * screens the poll skips never saw it at all — it expired. From the sender's
 * side «they said no» and «they were never asked» look identical.
 *
 * This is the server half: the moment an invite exists, the person it is for is
 * told over the socket that is already open.
 *
 * Two properties are worth more than the delivery itself:
 *   — it reaches THAT PLAYER and nobody else. A topic keyed slightly wrong
 *     sends one person's invitations to a room full of strangers.
 *   — it can never break the send. An invitation that failed because telling
 *     somebody failed is worse than a late one.
 *
 * Run: npx tsx src/tests/inviteNudge.test.ts */
import assert from 'node:assert/strict';
import { realtimeRooms } from '../realtime/roomRegistry.js';
import { nudgeUser, userTopic } from '../realtime/nudge.js';

let pass = 0, fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

/* A socket as the registry actually uses one: it checks `readyState` against
   the socket's own OPEN and calls send() with a JSON string. */
function fakeSocket(): { sent: string[]; readyState: number; OPEN: number; send(s: string): void } {
  return { sent: [], readyState: 1, OPEN: 1, send(s: string) { this.sent.push(s); } };
}
function connect(userId: string): { sock: ReturnType<typeof fakeSocket>; clientId: string } {
  const sock = fakeSocket();
  const meta = realtimeRooms.add(sock as any, userId);
  realtimeRooms.joinTopic(meta.id, userTopic(userId));
  return { sock, clientId: meta.id };
}
const kinds = (sock: { sent: string[] }): string[] =>
  sock.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'server:nudge').map((m) => m.payload.kind);

check('the player is told the instant an invite exists', () => {
  const a = connect('u-alice');
  nudgeUser('u-alice', 'invite', { inviteId: 'inv-1' });
  assert.deepEqual(kinds(a.sock), ['invite']);
  const m = a.sock.sent.map((s) => JSON.parse(s)).find((x) => x.type === 'server:nudge');
  assert.equal(m.payload.inviteId, 'inv-1', 'the nudge did not say which invite');
  realtimeRooms.remove(a.clientId);
});

check('and nobody else is', () => {
  /* A topic keyed on anything shared — the connection, the room, a fallback id
     — sends one person's invitations to every stranger who happens to be on it.
     This is the check that would catch that. */
  const a = connect('u-alice'), b = connect('u-bob');
  nudgeUser('u-bob', 'invite', {});
  assert.deepEqual(kinds(b.sock), ['invite']);
  assert.deepEqual(kinds(a.sock), [], 'alice was told about bob’s invitation');
  realtimeRooms.remove(a.clientId); realtimeRooms.remove(b.clientId);
});

check('two devices of the same player both hear it', () => {
  /* Somebody with the game open on a phone and a laptop is one player, and the
     invitation is for the player, not for a device. */
  const one = connect('u-carol'), two = connect('u-carol');
  nudgeUser('u-carol', 'duel_call', {});
  assert.deepEqual(kinds(one.sock), ['duel_call']);
  assert.deepEqual(kinds(two.sock), ['duel_call']);
  realtimeRooms.remove(one.clientId); realtimeRooms.remove(two.clientId);
});

check('a player who is not connected is simply not told, and nothing throws', () => {
  /* The poll underneath is what makes delivery certain; this is only the fast
     path. Throwing here would take the whole invitation down with it. */
  assert.doesNotThrow(() => nudgeUser('u-nobody-at-all', 'invite', {}));
  assert.doesNotThrow(() => nudgeUser('', 'invite', {}));
});

check('a socket that has gone away stops being told', () => {
  const a = connect('u-dave');
  realtimeRooms.remove(a.clientId);
  nudgeUser('u-dave', 'invite', {});
  assert.deepEqual(kinds(a.sock), [], 'a removed client was still written to');
});

check('and a closing socket is not written to either', () => {
  /* readyState 2 is CLOSING. Writing to it throws in the real ws library, and
     that throw would land inside the invite request. */
  const a = connect('u-erin');
  a.sock.readyState = 2;
  assert.doesNotThrow(() => nudgeUser('u-erin', 'invite', {}));
  assert.deepEqual(kinds(a.sock), []);
  realtimeRooms.remove(a.clientId);
});

check('the topic is the player’s own id and nothing else', () => {
  /* Stated as its own fact because everything above depends on it and it is one
     string concatenation away from being wrong. */
  assert.equal(userTopic('u-alice'), 'user:u-alice');
  assert.notEqual(userTopic('u-alice'), userTopic('u-alicia'));
});

/* ── AND THE SAME THING THROUGH A REAL SOCKET ─────────────────────────────
   Everything above drives the registry directly. This drives the GATEWAY: a
   real http server, a real WebSocket client, a real token. It is here for one
   property that the checks above cannot reach — an unauthenticated socket must
   not be listening on anybody's name. The gateway keeps a `'u1'` fallback for
   sockets whose token did not resolve, and joining a topic under that fallback
   would hand every stranger on it the same invitations. */
async function throughTheGateway(): Promise<void> {
  const http = await import('node:http');
  const wspkg = await import('ws');
  /* `ws` is CommonJS: depending on how it is interop-loaded the constructors
     are on the module or on its default. Taking whichever is really there
     beats guessing, and beats the test failing for a reason that has nothing
     to do with invitations. */
  const WebSocket: any = (wspkg as any).WebSocket ?? (wspkg as any).default?.WebSocket ?? (wspkg as any).default;
  const { attachRealtimeGateway } = await import('../realtime/gateway.js');
  const { signAccessToken } = await import('../services/tokenService.js');

  const server = http.createServer((_q, r) => { r.writeHead(200); r.end('ok'); });
  const wss = attachRealtimeGateway(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  const url = (q: string): string => `ws://127.0.0.1:${port}/v1/realtime${q}`;

  const heard: Record<string, unknown[]> = { signed: [], anon: [] };
  const listen = (ws: any, bucket: string): void => {
    ws.on('message', (raw: Buffer) => {
      try { const m = JSON.parse(String(raw)); if (m.type === 'server:nudge') heard[bucket]!.push(m.payload); } catch { /* not ours */ }
    });
  };
  const signed = new WebSocket(url('?token=' + signAccessToken('u-frank')));
  const anon = new WebSocket(url(''));
  listen(signed, 'signed'); listen(anon, 'anon');
  await new Promise<void>((r) => { let n = 0; const done = (): void => { if (++n === 2) r(); };
    signed.on('open', done); anon.on('open', done); signed.on('error', done); anon.on('error', done); });
  await new Promise((r) => setTimeout(r, 120));

  nudgeUser('u-frank', 'invite', { inviteId: 'inv-real' });
  nudgeUser('u1', 'invite', { inviteId: 'inv-for-the-fallback' });
  await new Promise((r) => setTimeout(r, 200));

  check('a real socket hears its own player’s invite', () => {
    assert.equal(heard.signed!.length, 1, 'the signed-in socket heard ' + heard.signed!.length);
    assert.equal((heard.signed![0] as any).inviteId, 'inv-real');
  });
  check('and a socket with no token hears nothing at all', () => {
    /* `u1` is the gateway's fallback id. If an unauthenticated socket joined a
       topic under it, every one of them would receive this. */
    assert.equal(heard.anon!.length, 0, 'an anonymous socket was sent ' + JSON.stringify(heard.anon));
  });

  try { signed.close(); anon.close(); } catch { /* closing anyway */ }
  wss.close(); server.close();
  await new Promise((r) => setTimeout(r, 80));
}

await throughTheGateway();

console.log(`[inviteNudge] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
