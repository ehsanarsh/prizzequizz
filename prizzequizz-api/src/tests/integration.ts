import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { createApiServer } from '../app.js';
import { WebSocket } from 'ws';

interface ApiEnvelope<T> { ok: true; data: T; requestId: string }

async function main(): Promise<void> {
  process.env.REPOSITORY_DRIVER = 'memory';
  const server = createApiServer({ attachRealtime: true });
  server.listen(0);
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/v1`;

  try {
    const health = await get<{ status: string }>(`${base}/health`);
    assert.equal(health.status, 'ok');

    const deviceHeaders = { 'x-device-id': 'integration-device-a', 'x-device-fingerprint': 'shared-fingerprint-a', 'x-platform': 'integration' };
    const login = await post<{ otpRequired: boolean; requestId: string }>(`${base}/auth/login`, { phone: '+989120000000' }, deviceHeaders);
    assert.equal(login.otpRequired, true);

    const verified = await post<{ accessToken: string; user: { id: string; balances: { coins: number; hearts: number } } }>(`${base}/auth/otp/verify`, { requestId: login.requestId, code: '1234' }, deviceHeaders);
    assert.ok(verified.accessToken);
    const auth = { authorization: `Bearer ${verified.accessToken}`, ...deviceHeaders };

    const currentDevice = await get<{ device: { id: string }; riskProfile: { userId: string; riskScore: number } }>(`${base}/devices/current`, auth);
    assert.ok(currentDevice.device.id);
    assert.equal(currentDevice.riskProfile.userId, 'u1');
    const myDevices = await get<Array<{ id: string; trustStatus: string }>>(`${base}/devices`, auth);
    assert.ok(myDevices.length >= 1);

    const me = await get<{ username: string; balances: { coins: number; hearts: number } }>(`${base}/users/me`, auth);
    assert.equal(me.username, 'Shahab_9865');

    const characterCatalog = await get<{ items: Array<{ id: string; slot: string }>; states: Array<{ id: string }> }>(`${base}/characters/catalog`, auth);
    assert.ok(characterCatalog.items.some((item) => item.id === 'cap_blue'));
    const characterMe = await get<{ unlockedItemIds: string[]; loadout: { outfit: Record<string, string> } }>(`${base}/characters/me`, auth);
    assert.ok(characterMe.unlockedItemIds.includes('cap_blue'));
    const equippedCharacter = await post<{ loadout: { outfit: Record<string, string> } }>(`${base}/characters/equip`, { slot: 'head', itemId: 'cap_blue' }, auth);
    assert.equal(equippedCharacter.loadout.outfit.head, 'cap_blue');
    const randomizedCharacter = await post<{ loadout: { state: string } }>(`${base}/characters/randomize`, {}, auth);
    assert.ok(randomizedCharacter.loadout.state);
    const adminCharacterItems = await get<Array<{ id: string; status: string }>>(`${base}/admin/characters/catalog`, { 'x-admin-key': 'dev-admin' });
    assert.ok(adminCharacterItems.some((item) => item.id === 'cap_blue'));
    const newCharacterItem = await post<{ id: string; status: string }>(`${base}/admin/characters/items`, { id: 'qa_hat', slot: 'head', title: 'کلاه QA', src: '/character-assets/outfits/head/cap_blue.png', rarity: 'rare', priceCoins: 10, unlockLevel: 1, tags: ['qa'], status: 'active' }, { 'x-admin-key': 'dev-admin' });
    assert.equal(newCharacterItem.id, 'qa_hat');
    const archivedCharacterItem = await patch<{ status: string }>(`${base}/admin/characters/items/qa_hat/status`, { status: 'archived' }, { 'x-admin-key': 'dev-admin' });
    assert.equal(archivedCharacterItem.status, 'archived');
    const betaInvite = await post<{ code: string; status: string }>(`${base}/admin/beta/invites`, { code: 'BETA-QA', maxUses: 3, note: 'integration' }, { 'x-admin-key': 'dev-admin' });
    assert.equal(betaInvite.code, 'BETA-QA');
    const betaRedeem = await post<{ inviteCode: string }>(`${base}/beta/redeem`, { code: 'BETA-QA' }, auth);
    assert.equal(betaRedeem.inviteCode, 'BETA-QA');
    const betaDiag = await get<{ activeInvites: number; grantedUsers: number }>(`${base}/admin/beta/diagnostics`, { 'x-admin-key': 'dev-admin' });
    assert.ok(betaDiag.grantedUsers >= 1);
    const betaUsers = await get<Array<{ userId: string }>>(`${base}/admin/beta/users`, { 'x-admin-key': 'dev-admin' });
    assert.ok(betaUsers.some((user) => user.userId === 'u1'));

    const mm = await post<{ id: string; status: string }>(`${base}/matchmaking/enqueue`, { modeId: 'duel', economyType: 'free', entry: { coinStake: 10 }, skill: 800 }, auth);
    assert.ok(mm.id);
    const mmStatus = await get<{ id: string; status: string }>(`${base}/matchmaking/${mm.id}`, auth);
    assert.equal(mmStatus.id, mm.id);
    const mmStats = await get<{ queued: number; matched: number }>(`${base}/matchmaking/stats`, auth);
    assert.ok(mmStats.queued >= 0);

    const created = await post<{ matchId: string; status: string }>(`${base}/matches`, { modeId: 'duel', economyType: 'free', entry: { coinStake: 25 } }, auth);
    assert.ok(created.matchId);
    assert.equal(created.status, 'matchmaking');

    const started = await post<{ phase: string }>(`${base}/matches/${created.matchId}/start`, {}, auth);
    assert.equal(started.phase, 'question');

    const q = await get<{ id: string; correctIndex: number; options: string[] }>(`${base}/questions/next`, auth);
    assert.ok(q.id);
    assert.equal(q.options.length, 4);

    const idem = `idem-${Date.now()}`;
    const ans1 = await post<{ correct: boolean; duplicate: boolean; score: number }>(`${base}/matches/${created.matchId}/answer`, { questionId: q.id, selectedIndex: q.correctIndex, answerTimeMs: 1200, idempotencyKey: idem }, auth);
    assert.equal(ans1.correct, true);
    assert.equal(ans1.duplicate, false);

    const ans2 = await post<{ duplicate: boolean; score: number }>(`${base}/matches/${created.matchId}/answer`, { questionId: q.id, selectedIndex: q.correctIndex, answerTimeMs: 1200, idempotencyKey: idem }, auth);
    assert.equal(ans2.duplicate, true);
    assert.equal(ans2.score, ans1.score, 'duplicate answer must not increment score');

    const suspicious = await post<{ duplicate: boolean }>(`${base}/matches/${created.matchId}/answer`, { questionId: q.id, selectedIndex: q.correctIndex, answerTimeMs: 10, idempotencyKey: `sus-${Date.now()}` }, auth);
    assert.equal(suspicious.duplicate, false);
    const integritySignals = await get<Array<{ id: string; type: string; status: string }>>(`${base}/admin/integrity/signals?limit=10`, { 'x-admin-key': 'dev-admin' });
    assert.ok(integritySignals.some((signal) => signal.type === 'IMPOSSIBLE_ANSWER_TIME'));
    const integrityDiag = await get<{ openSignals: number; criticalSignals: number }>(`${base}/admin/integrity/diagnostics`, { 'x-admin-key': 'dev-admin' });
    assert.ok(integrityDiag.openSignals >= 1);
    assert.ok(integrityDiag.criticalSignals >= 1);
    const reviewedSignal = await patch<{ status: string }>(`${base}/admin/integrity/signals/${integritySignals[0]!.id}/status`, { status: 'reviewing' }, { 'x-admin-key': 'dev-admin' });
    assert.equal(reviewedSignal.status, 'reviewing');

    // Deposit via the SECURE flow: create intent → settle through the signed
    // sandbox pay URL (a client can no longer self-credit an intent).
    const depositIntent = await post<{ intentId: string; status: string; amount: number; paymentUrl: string }>(`${base}/wallet/deposits`, { amount: 500000, idempotencyKey: `dep-${Date.now()}` }, auth);
    assert.equal(depositIntent.status, 'pending');
    const settle = await get<{ paid: boolean }>(`${base}${depositIntent.paymentUrl.replace('/v1', '')}`);
    assert.equal(settle.paid, true);
    const walletDash = await get<{ wallet: number; available: number; totalDeposits: number }>(`${base}/wallet`, auth);
    assert.ok(walletDash.available >= 500000);
    assert.ok(walletDash.totalDeposits >= 500000);
    const paymentDiag = await get<{ paid: number; totalPaidAmount: number }>(`${base}/admin/payments/diagnostics`, { 'x-admin-key': 'dev-admin' });
    assert.ok(paymentDiag.paid >= 1);
    assert.ok(paymentDiag.totalPaidAmount >= 500000);
    // Withdraw lifecycle through the ledger: request locks funds → admin pays.
    const wd = await post<{ id: string; status: string }>(`${base}/wallet/withdrawals`, { amount: 300000, destination: 'IR012345678901234567890123', otp: '1234' }, auth);
    assert.equal(wd.status, 'pending');
    const afterLock = await get<{ available: number; locked: number }>(`${base}/wallet`, auth);
    assert.ok(afterLock.locked >= 300000);
    const adminWds = await get<{ rows: Array<{ id: string; status: string }> }>(`${base}/admin/wallet/withdrawals?status=pending`, { 'x-admin-key': 'dev-admin' });
    assert.ok(adminWds.rows.some((r) => r.id === wd.id));
    const approved = await post<{ status: string }>(`${base}/admin/wallet/withdrawals/${wd.id}/approve`, {}, { 'x-admin-key': 'dev-admin' });
    assert.equal(approved.status, 'approved');
    const paidWd = await post<{ status: string; paymentReference?: string }>(`${base}/admin/wallet/withdrawals/${wd.id}/paid`, { paymentReference: 'BANK-1' }, { 'x-admin-key': 'dev-admin' });
    assert.equal(paidWd.status, 'paid');
    const afterPaid = await get<{ locked: number; totalWithdrawn: number }>(`${base}/wallet`, auth);
    assert.equal(afterPaid.locked, 0);
    assert.ok(afterPaid.totalWithdrawn >= 300000);
    // Ledger history + consistency
    const txns = await get<{ rows: Array<{ entryType: string; availableBefore: number; availableAfter: number }>; total: number }>(`${base}/wallet/transactions?pageSize=50`, auth);
    assert.ok(txns.total >= 3);
    assert.ok(txns.rows.every((r) => typeof r.availableBefore === 'number' && typeof r.availableAfter === 'number'));
    const consistency = await get<{ mismatches: unknown[] }>(`${base}/admin/wallet/consistency`, { 'x-admin-key': 'dev-admin' });
    assert.equal(consistency.mismatches.length, 0);

    // Friends API (the old /friends/invites endpoint no longer exists).
    const friendsList = await get<unknown[]>(`${base}/friends`, auth);
    assert.ok(Array.isArray(friendsList));

    const ticket = await post<{ id: string; status: string }>(`${base}/support/tickets`, { title: 'test', category: 'qa', body: 'integration', linkedTransactionId: wd.id }, auth);
    assert.equal(ticket.status, 'open');
    const supportDiag = await get<{ open: number; unassigned: number }>(`${base}/admin/support/diagnostics`, { 'x-admin-key': 'dev-admin' });
    assert.ok(supportDiag.open >= 1);
    const adminTickets = await get<Array<{ id: string; status: string }>>(`${base}/admin/support/tickets?status=open`, { 'x-admin-key': 'dev-admin' });
    assert.ok(adminTickets.some((t) => t.id === ticket.id));
    const answeredTicket = await post<{ status: string; reply: string }>(`${base}/admin/support/tickets/${ticket.id}/reply`, { body: 'پاسخ تستی ادمین' }, { 'x-admin-key': 'dev-admin' });
    assert.equal(answeredTicket.status, 'answered');
    const closedTicket = await patch<{ status: string }>(`${base}/admin/support/tickets/${ticket.id}/status`, { status: 'closed' }, { 'x-admin-key': 'dev-admin' });
    assert.equal(closedTicket.status, 'closed');

    const prefs = await get<{ matchUpdates: boolean; promos: boolean }>(`${base}/notifications/preferences`, auth);
    assert.equal(prefs.matchUpdates, true);
    const updatedPrefs = await put<{ promos: boolean }>(`${base}/notifications/preferences`, { promos: true }, auth);
    assert.equal(updatedPrefs.promos, true);
    const sub = await post<{ id: string; endpoint: string }>(`${base}/notifications/push-subscriptions`, { endpoint: 'https://push.example.test/u1', keys: { p256dh: 'p256dh-test', auth: 'auth-test' }, deviceLabel: 'integration' }, auth);
    assert.ok(sub.id);
    const broadcast = await post<{ created: number }>(`${base}/admin/notifications/broadcast`, { userIds: ['u1'], type: 'system', title: 'integration', body: 'hello', push: true }, { 'x-admin-key': 'dev-admin' });
    assert.equal(broadcast.created, 1);
    const notificationsList = await get<Array<{ id: string; title: string; readAt?: string }>>(`${base}/notifications`, auth);
    assert.ok(notificationsList.some((n) => n.title === 'integration'));
    const firstNotification = notificationsList[0]!;
    const marked = await post<{ updated: boolean }>(`${base}/notifications/${firstNotification.id}/read`, {}, auth);
    assert.equal(marked.updated, true);
    const notificationDiagnostics = await get<{ provider: string; subscriptions: number }>(`${base}/admin/notifications/diagnostics`, { 'x-admin-key': 'dev-admin' });
    assert.ok(notificationDiagnostics.subscriptions >= 1);

    const errorReport = await post<{ id: string; status: string }>(`${base}/monitoring/reports`, { source: 'frontend', severity: 'fatal', message: 'integration crash report', route: '/integration', metadata: { test: true } }, auth);
    assert.equal(errorReport.status, 'open');
    const monitoringDiag = await get<{ open: number; fatal: number }>(`${base}/admin/monitoring/diagnostics`, { 'x-admin-key': 'dev-admin' });
    assert.ok(monitoringDiag.open >= 1);
    assert.ok(monitoringDiag.fatal >= 1);
    const monitoringReports = await get<Array<{ id: string }>>(`${base}/admin/monitoring/reports?status=open`, { 'x-admin-key': 'dev-admin' });
    assert.ok(monitoringReports.some((r) => r.id === errorReport.id));
    const resolvedReport = await patch<{ status: string }>(`${base}/admin/monitoring/reports/${errorReport.id}/status`, { status: 'resolved' }, { 'x-admin-key': 'dev-admin' });
    assert.equal(resolvedReport.status, 'resolved');

    const login2 = await post<{ requestId: string }>(`${base}/auth/login`, { phone: '+989990000001' }, { 'x-device-id': 'integration-device-b', 'x-device-fingerprint': 'shared-fingerprint-a', 'x-platform': 'integration' });
    await post(`${base}/auth/otp/verify`, { requestId: login2.requestId, code: '1234' }, { 'x-device-id': 'integration-device-b', 'x-device-fingerprint': 'shared-fingerprint-a', 'x-platform': 'integration' });
    const deviceDiagnostics = await get<{ devices: number; sharedDevices: number }>(`${base}/admin/devices/diagnostics`, { 'x-admin-key': 'dev-admin' });
    assert.ok(deviceDiagnostics.devices >= 1);
    assert.ok(deviceDiagnostics.sharedDevices >= 1);
    const riskUsers = await get<Array<{ userId: string; riskScore: number }>>(`${base}/admin/risk/users?limit=10`, { 'x-admin-key': 'dev-admin' });
    assert.ok(riskUsers.some((u) => u.userId === 'u1'));
    const userDevices = await get<Array<{ id: string; trustStatus: string }>>(`${base}/admin/users/u1/devices`, { 'x-admin-key': 'dev-admin' });
    assert.ok(userDevices.length >= 1);
    const limitedDevice = await patch<{ trustStatus: string }>(`${base}/admin/devices/bindings/${userDevices[0]!.id}/status`, { status: 'limited' }, { 'x-admin-key': 'dev-admin' });
    assert.equal(limitedDevice.trustStatus, 'limited');

    const analytics = await get<{ matches: number; questions: number }>(`${base}/admin/analytics`, { 'x-admin-key': 'dev-admin' });
    assert.ok(analytics.questions >= 1);
    const adminUsers = await get<Array<{ id: string; username: string; status: string; role: string }>>(`${base}/admin/users?q=Shahab`, { 'x-admin-key': 'dev-admin' });
    assert.ok(adminUsers.some((user) => user.id === 'u1'));
    const userOverview = await get<{ user: { id: string }; transactions: unknown[]; devices: unknown[] }>(`${base}/admin/users/u1/overview`, { 'x-admin-key': 'dev-admin' });
    assert.equal(userOverview.user.id, 'u1');
    const bannedUser = await patch<{ status: string }>(`${base}/admin/users/u1/status`, { status: 'banned', reason: 'integration' }, { 'x-admin-key': 'dev-admin' });
    assert.equal(bannedUser.status, 'banned');
    const activeUser = await patch<{ status: string }>(`${base}/admin/users/u1/status`, { status: 'active' }, { 'x-admin-key': 'dev-admin' });
    assert.equal(activeUser.status, 'active');
    const adminRole = await patch<{ role: string }>(`${base}/admin/users/u1/role`, { role: 'admin' }, { 'x-admin-key': 'dev-admin' });
    assert.equal(adminRole.role, 'admin');
    await patch(`${base}/admin/users/u1/role`, { role: 'user' }, { 'x-admin-key': 'dev-admin' });

    // Boards are REAL now: a user appears only after a finished duel awards
    // cup/xp/winnings, so a solo (mock-opponent) match keeps the boards empty.
    const weeklyBefore = await get<{ entries: Array<{ userId: string; score: number }> }>(`${base}/leaderboards/weekly?limit=5`, auth);
    assert.ok(Array.isArray(weeklyBefore.entries));
    const overallBefore = await get<{ entries: Array<{ userId: string; score: number }> }>(`${base}/leaderboards/overall?limit=5`, auth);
    assert.ok(Array.isArray(overallBefore.entries));
    const leaderboardDiagnostics = await get<{ adapter: string; boardSizes: Record<string, number> }>(`${base}/admin/leaderboards/diagnostics`, { 'x-admin-key': 'dev-admin' });
    assert.ok(['memory', 'redis'].includes(leaderboardDiagnostics.adapter));

    const cfg = await get<{ version: string }>(`${base}/admin/config`, { 'x-admin-key': 'dev-admin' });
    assert.ok(cfg.version);

    const deep = await get<{ ok: boolean; checks: Record<string, { ok: boolean }> }>(`${base}/health/deep`);
    assert.equal(deep.ok, true);

    const metrics = await get<{ totalRequests: number }>(`${base}/metrics`);
    assert.ok(metrics.totalRequests >= 1);

    await realtimeSmoke(address.port, verified.accessToken, created.matchId, q.id, q.correctIndex);

    const leaderboardMatch = await post<{ matchId: string }>(`${base}/matches`, { modeId: 'duel', economyType: 'paid' }, auth);
    await post<{ phase: string }>(`${base}/matches/${leaderboardMatch.matchId}/start`, {}, auth);
    for (let i = 0; i < 5; i++) {
      await post(`${base}/matches/${leaderboardMatch.matchId}/answer`, { questionId: q.id, selectedIndex: q.correctIndex, answerTimeMs: 800 + i, idempotencyKey: `lb-${Date.now()}-${i}` }, auth);
    }
    // A solo match never finishes under real lockstep scoring (the mock
    // opponent never answers), so no reward/cup is granted — boards stay
    // shape-valid but empty for u1. Reward-once + ledger crediting semantics
    // are covered end-to-end by tests/wallet.test.ts.
    const weeklyAfter = await get<{ entries: Array<{ userId: string; score: number }> }>(`${base}/leaderboards/weekly?limit=5`, auth);
    assert.ok(Array.isArray(weeklyAfter.entries));
    const holdDiag = await get<{ pending: number; pendingAmount: number }>(`${base}/admin/rewards/holds/diagnostics`, { 'x-admin-key': 'dev-admin' });
    assert.ok(holdDiag.pending >= 0);
    const winningsAfter = await get<{ entries: Array<{ userId: string; score: number }> }>(`${base}/leaderboards/winnings?limit=5`, auth);
    assert.ok(Array.isArray(winningsAfter.entries));

    await expectFail(`${base}/auth/otp/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'bad', code: '0000' }) }, 401);
    // The old client-amount topup hole is gone: the route must not exist.
    await expectFail(`${base}/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ amount: 100000 }) }, 404);
    // A forged settle signature must be rejected.
    await expectFail(`${base}/payments/sandbox/${depositIntent.intentId}/pay?sig=${'ab'.repeat(32)}&status=paid`, { method: 'GET' }, 403);
    await expectFail(`${base}/admin/config`, { method: 'GET' }, 403);

    console.log('[integration] all checks passed');
  } finally {
    server.close();
  }
}



async function realtimeSmoke(port: number, token: string, matchId: string, questionId: string, correctIndex: number): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime?token=${encodeURIComponent(token)}`);
  const messages: any[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
  await once(ws, 'open');
  await waitFor(() => messages.some((m) => m.type === 'server:connected'));
  ws.send(JSON.stringify({ type: 'client:subscribe_leaderboard', payload: { kind: 'weekly' }, requestId: 'lb1' }));
  await waitFor(() => messages.some((m) => m.type === 'server:leaderboard_update'));
  ws.send(JSON.stringify({ type: 'client:join_match', payload: { matchId }, requestId: 'join1' }));
  await waitFor(() => messages.some((m) => m.type === 'server:match_snapshot'));
  ws.send(JSON.stringify({ type: 'client:ping', requestId: 'ping1' }));
  await waitFor(() => messages.some((m) => m.type === 'server:pong'));
  ws.send(JSON.stringify({ type: 'client:send_chat', payload: { matchId, text: 'سلام' } }));
  await waitFor(() => messages.some((m) => m.type === 'server:chat'));
  ws.send(JSON.stringify({ type: 'client:submit_answer', payload: { matchId, questionId, selectedIndex: correctIndex, answerTimeMs: 900, idempotencyKey: `ws-${Date.now()}` } }));
  await waitFor(() => messages.some((m) => m.type === 'server:answer_result'));
  await waitFor(() => messages.some((m) => m.type === 'server:match_snapshot'));
  ws.close();
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('waitFor timeout');
}

async function expectFail(url: string, options: RequestInit, status: number): Promise<void> {
  const res = await fetch(url, options);
  if (res.status !== status) {
    const body = await res.text();
    throw new Error(`Expected ${status} for ${url}, got ${res.status}: ${body}`);
  }
}

async function get<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers });
  return unwrap<T>(res);
}

async function post<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return unwrap<T>(res);
}

async function put<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return unwrap<T>(res);
}

async function patch<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return unwrap<T>(res);
}

async function unwrap<T>(res: Response): Promise<T> {
  const payload = await res.json() as ApiEnvelope<T> | { ok: false; error: { message: string } };
  if (!res.ok || !payload.ok) throw new Error(!payload.ok ? payload.error.message : res.statusText);
  return payload.data;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
