import { gameConfig } from '../config/game.config';
import { questionSeed } from '../config/questions.seed';
import type { PrizzeQuizzApi } from './client';
import type { LeaderboardDto, LeaderboardKind, MatchSnapshotDto, QuestionDto, SubmitAnswerRequest, UserDto, WalletDto } from './contracts';

let qIndex = 0;
let wallet = 900000;
let coins = 350;
let hearts = 3;
let tickets = { bronze: 1, silver: 0, gold: 0 };
let activeMatch: MatchSnapshotDto | null = null;
let characterInventory = { userId: 'u1', unlockedItemIds: ['none_head','none_body','none_shoes','cap_blue','hoodie_sky','sneakers_blue'], loadout: { state: 'idle' as const, outfit: { head: 'none_head', body: 'none_body', shoes: 'none_shoes' } }, updatedAt: new Date().toISOString() };
let notificationPrefs = { userId: 'u1', matchUpdates: true, leaderboardUpdates: true, walletUpdates: true, promos: false, updatedAt: new Date().toISOString() };
let betaInvites:any[] = [{ code: 'BETA-DEMO', maxUses: 25, usedCount: 1, status: 'active', note: 'Demo invite', createdBy: 'system', createdAt: new Date().toISOString() }];
let betaUsers:any[] = [{ userId: 'u1', inviteCode: 'BETA-DEMO', grantedAt: new Date().toISOString(), grantedBy: 'system' }];
let errorReports:any[] = [];
let paymentIntents:any[] = [];
let supportTicketsAdmin = [{ id: 'st1', userId: 'u1', title: 'مشکل برداشت', category: 'مالی', body: 'برداشت من pending مانده', status: 'open' as const, priority: 'high' as const, reply: 'در صف بررسی', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
let withdrawals = [{ id: 'w1', type: 'withdraw', currency: 'cash' as const, amount: 50000, direction: 'out' as const, status: 'pending' as const, createdAt: new Date().toISOString(), reference: 'WD-MOCK' }];
let rewardHolds = [{ id: 'rh1', rewardId: 'r1', userId: 'u1', matchId: 'match_mock', rewardType: 'cash' as const, amount: 60000, status: 'pending' as const, riskScore: 75, riskLevel: 'high' as const, reason: 'high_risk_reward_review', evidence: { mock: true }, idempotencyKey: 'mock-hold', createdAt: new Date().toISOString() }];
let riskUsers = [{ userId: 'u1', riskScore: 45, riskLevel: 'medium' as const, reasons: ['fast answer'], deviceCount: 1, sharedDeviceCount: 0, integritySignalCount: 1, updatedAt: new Date().toISOString() }];
let deviceBindings = [{ id: 'db1', userId: 'u1', deviceId: 'dev1', firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), trustStatus: 'new' as const, riskScore: 45, sharedUsers: 1, device: { id: 'dev1', fingerprintHash: 'mockhash', clientDeviceId: 'mock', platform: 'web', firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), trustStatus: 'new' as const } }];
let integritySignals = [
  { id: 'is1', matchId: 'match_mock', userId: 'u1', type: 'FAST_CORRECT_ANSWER' as const, severity: 'warn' as const, riskScore: 45, status: 'open' as const, evidence: { answerTimeMs: 620 }, createdAt: new Date().toISOString() }
];
let notificationsList = [
  { id: 'n1', userId: 'u1', type: 'system' as const, title: 'به PrizzeQuizz خوش آمدی', body: 'اعلان‌های مهم اینجا نمایش داده می‌شوند.', data: {}, channel: 'in_app' as const, status: 'queued' as const, createdAt: new Date().toISOString() }
];

const mockUser: UserDto = {
  id: 'u1',
  username: 'Shahab_9865',
  displayName: 'شهاب',
  plan: 'free',
  level: 3,
  xp: 3400,
  weeklyScore: 820,
  balances: { wallet, coins, hearts, tickets }
};

export function createMockApi(): PrizzeQuizzApi {
  return {
    auth: {
      async login() { return delay({ otpRequired: true, requestId: 'otp_mock_1' }); },
      async verifyOtp() { return delay({ accessToken: 'mock_access', refreshToken: 'mock_refresh', user: mockUser }); },
      async refresh() { return delay({ accessToken: 'mock_access_refreshed', refreshToken: 'mock_refresh_refreshed', sessionId: 'mock_session' }); },
      async logout() { return delay({ revoked: true }); }
    },
    beta: {
      async status() { return delay({ required: false, access: betaUsers[0] }); },
      async redeem(code) { const access = { userId: 'u1', inviteCode: code.toUpperCase(), grantedAt: new Date().toISOString(), grantedBy: 'self' }; betaUsers.unshift(access); return delay(access); }
    },
    users: {
      async me() { return delay({ ...mockUser, balances: { wallet, coins, hearts, tickets } }); },
      async profile(userId) { return delay({ id: userId, username: 'Opponent', displayName: 'حریف', avatar: '🦊', level: 5, league: 'Bronze', winRate: 62, totalPrize: 1250000 }); }
    },

    leaderboards: {
      async get(kind, limit = 50) { return delay(mockLeaderboard(kind, limit)); },
      async weekly(limit = 50) { return delay(mockLeaderboard('weekly', limit)); },
      async overall(limit = 50) { return delay(mockLeaderboard('overall', limit)); },
      async winnings(limit = 50) { return delay(mockLeaderboard('winnings', limit)); }
    },
    characters: {
      async catalog() { return delay(mockCharacterCatalog()); },
      async me() { return delay(characterInventory as any); },
      async equip(input) { if (input.state) (characterInventory.loadout as any).state = input.state; if (input.slot && input.itemId) (characterInventory.loadout.outfit as any)[input.slot] = input.itemId; characterInventory.updatedAt = new Date().toISOString(); return delay(characterInventory as any); },
      async unlock(itemId) { if (!characterInventory.unlockedItemIds.includes(itemId)) characterInventory.unlockedItemIds.push(itemId); return delay(characterInventory as any); },
      async purchase(itemId) { if (!characterInventory.unlockedItemIds.includes(itemId)) characterInventory.unlockedItemIds.push(itemId); return delay(characterInventory as any); },
      async randomize() { const c = mockCharacterCatalog(); for (const slot of c.slots) { const choices = c.items.filter((i:any)=>i.slot===slot && characterInventory.unlockedItemIds.includes(i.id)); (characterInventory.loadout.outfit as any)[slot] = choices[Math.floor(Math.random()*choices.length)]?.id ?? (characterInventory.loadout.outfit as any)[slot]; } characterInventory.loadout.state = c.states[Math.floor(Math.random()*c.states.length)].id as any; return delay(characterInventory as any); }
    },
    matchmaking: {
      async enqueue(input) { const created = await createMockApi().matches.create(input); return delay({ id: `mm_${Date.now()}`, userId: 'u1', modeId: input.modeId, economyType: input.economyType, coinStake: input.entry?.coinStake, skill: input.skill ?? 1000, status: 'matched', matchId: created.matchId, opponentUserId: 'op1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any); },
      async get(ticketId) { return delay({ id: ticketId, userId: 'u1', modeId: 'duel', economyType: 'free', skill: 1000, status: 'matched', matchId: activeMatch?.matchId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any); },
      async cancel(ticketId) { return delay({ id: ticketId, userId: 'u1', modeId: 'duel', economyType: 'free', skill: 1000, status: 'cancelled', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any); },
      async bot(ticketId) { return delay({ id: ticketId, userId: 'u1', modeId: 'duel', economyType: 'free', skill: 1000, status: 'matched', matchId: activeMatch?.matchId, opponentUserId: 'bot', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any); },
      async stats() { return delay({ queued: 0, matched: 1 }); }
    },
    matches: {
      async create(input) {
        activeMatch = {
          matchId: uid('match'),
          modeId: input.modeId,
          phase: 'matchmaking',
          round: 0,
          players: [
            { userId: 'u1', username: 'Shahab_9865', avatar: '🦁', score: 0, correctAnswers: 0, wrongAnswers: 0 },
            { userId: 'op1', username: 'رضا', avatar: '🦊', score: 0, correctAnswers: 0, wrongAnswers: 0 }
          ],
          timerSeconds: gameConfig[input.modeId]?.timerSeconds ?? 10
        };
        return delay({ matchId: activeMatch.matchId, status: activeMatch.phase, configVersion: 'mock-config-v1' });
      },
      async get() { return delay(requireMatch()); },
      async start() { const m = requireMatch(); m.phase = 'question'; return delay(m); },
      async continue() { const m = requireMatch(); m.phase = 'question'; m.round += 1; return delay(m); },
      async exit() { const m = requireMatch(); m.phase = 'finished'; return delay(m); }
    },
    questions: {
      async next(): Promise<QuestionDto> {
        const q = questionSeed[qIndex % questionSeed.length];
        qIndex += 1;
        return delay(q);
      },
      async submitAnswer(input: SubmitAnswerRequest) {
        const q = questionSeed.find((item) => item.id === input.questionId) ?? questionSeed[0];
        return delay({ correct: input.selectedIndex === q.correctIndex, selectedIndex: input.selectedIndex, correctIndex: q.correctIndex, score: 0, phase: 'revealing', events: [] });
      }
    },
    monitoring: {
      async report(input) { const report = { id: `er_${Date.now()}`, userId: 'u1', source: input.source || 'frontend', severity: input.severity || 'error', status: 'open', message: input.message, stack: input.stack, route: input.route, userAgent: input.userAgent, appVersion: input.appVersion, buildId: input.buildId, deviceId: input.deviceId, metadata: input.metadata ?? {}, createdAt: new Date().toISOString() }; errorReports.unshift(report); return delay(report as any); }
    },
    payments: {
      async createIntent(input) { const intent = { id: `pi_${Date.now()}`, userId: 'u1', provider: 'sandbox', amount: input.amount, currency: 'cash', status: 'pending', transactionId: `txn_${Date.now()}`, paymentUrl: '/mock-pay', idempotencyKey: input.idempotencyKey || `mock_${Date.now()}`, metadata: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; paymentIntents.unshift(intent); return delay(intent as any); },
      async getIntent(id) { return delay(paymentIntents.find((p:any)=>p.id===id) as any); },
      async verifyIntent(id, status = 'paid') { paymentIntents = paymentIntents.map((p:any)=>p.id===id?{...p,status,paidAt:status==='paid'?new Date().toISOString():undefined,updatedAt:new Date().toISOString()}:p); const intent = paymentIntents.find((p:any)=>p.id===id); if (intent?.status === 'paid') wallet += intent.amount; return delay(intent as any); }
    },
    notifications: {
      async list() { return delay(notificationsList); },
      async preferences() { return delay(notificationPrefs); },
      async updatePreferences(patch) { notificationPrefs = { ...notificationPrefs, ...patch, updatedAt: new Date().toISOString() }; return delay(notificationPrefs); },
      async subscribe(input) { notificationsList.unshift({ id: `n_${Date.now()}`, userId: 'u1', type: 'system', title: 'اعلان‌ها فعال شد', body: 'اعلان‌های مرورگر برای این دستگاه فعال شد.', data: {}, channel: 'in_app', status: 'queued', createdAt: new Date().toISOString() } as any); return delay({ id: `ps_${Date.now()}`, userId: 'u1', endpoint: input.endpoint, deviceLabel: input.deviceLabel, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() }); },
      async revoke() { return delay({ revoked: true }); },
      async markRead(id) { notificationsList = notificationsList.map((n) => n.id === id ? { ...n, status: 'read', readAt: new Date().toISOString() } as any : n); return delay({ updated: true }); },
      async markAllRead() { const count = notificationsList.filter((n:any) => !n.readAt).length; notificationsList = notificationsList.map((n) => ({ ...n, status: 'read', readAt: new Date().toISOString() } as any)); return delay({ updated: count }); }
    },
    rewards: {
      async claim() { return delay({ claimed: true, reward: { type: 'coins', amount: 100, status: 'granted' }, balances: { wallet, coins, hearts, tickets } }); }
    },
    wallet: {
      async get(): Promise<WalletDto> { return delay({ wallet, coins, hearts, tickets, transactions: [] }); },
      async topup(amount) { wallet += amount; return delay({ wallet, coins, hearts, tickets, transactions: [] }); },
      async withdraw(amount) { wallet -= amount; return delay({ wallet, coins, hearts, tickets, transactions: [] }); }
    },
    friends: {
      async list() { return delay([{ id: 'f1', username: 'reza_fast', displayName: 'رضا', avatar: '🦊', online: true, status: 'آنلاین', unread: 1 }]); },
      async sendRequest() { return delay({ sent: true }); },
      async invite() { return delay({ sent: true }); }
    },
    support: {
      async listTickets() { return delay([]); },
      async createTicket(input) { return delay({ id: String(Date.now()), ...input, status: 'open', createdAt: new Date().toISOString() }); }
    },
    admin: {
      async characterCatalog() { return delay(mockCharacterCatalog().items.map((i:any)=>({ ...i, status:'active', createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() })) as any); },
      async upsertCharacterItem(input) { return delay({ id: input.id, slot: input.slot || 'head', title: input.title || input.id, src: input.src || '/character-assets/outfits/head/none.png', rarity: input.rarity || 'common', priceCoins: input.priceCoins || 0, unlockLevel: input.unlockLevel || 1, tags: input.tags || [], status: input.status || 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any); },
      async updateCharacterItemStatus(id, status) { const item = mockCharacterCatalog().items.find((i:any)=>i.id===id) || mockCharacterCatalog().items[0]; return delay({ ...item, status, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any); },
      async unlockCharacterForUser(_userId, itemId) { if (!characterInventory.unlockedItemIds.includes(itemId)) characterInventory.unlockedItemIds.push(itemId); return delay(characterInventory as any); },
      async characterUnlockEvents(userId) { return delay(characterInventory.unlockedItemIds.map((itemId, index)=>({ id:'cue_'+index, userId, itemId, reason:'default', createdAt:new Date().toISOString() })) as any); },
      async getConfig() { return delay({ version: 'mock-config', modes: gameConfig }); },
      async updateConfig(config) { return delay(config); },
      async patchMode(modeId, patch) { return delay({ modeId, patch }); },
      async analytics() { return delay({ matches: 12, questions: questionSeed.length, transactions: 3, rewards: 2, activeUsersEstimate: 1 }); },
      async betaDiagnostics() { return delay({ required: false, activeInvites: betaInvites.filter((i:any)=>i.status==='active').length, disabledInvites: betaInvites.filter((i:any)=>i.status==='disabled').length, expiredInvites: 0, grantedUsers: betaUsers.length, remainingUses: betaInvites.reduce((s:any,i:any)=>s+Math.max(0,i.maxUses-i.usedCount),0) }); },
      async betaInvites() { return delay(betaInvites); },
      async createBetaInvite(input) { const invite = { code: (input.code || `BETA-${Date.now()}`).toUpperCase(), maxUses: input.maxUses || 1, usedCount: 0, status: 'active', note: input.note, createdBy: 'admin', createdAt: new Date().toISOString(), expiresAt: input.expiresAt }; betaInvites.unshift(invite); return delay(invite as any); },
      async updateBetaInviteStatus(code, status) { betaInvites = betaInvites.map((i:any)=>i.code===code?{...i,status}:i); return delay(betaInvites.find((i:any)=>i.code===code)); },
      async betaUsers() { return delay(betaUsers); },
      async databaseStatus() { return delay([]); },
      async databaseVerify() { return delay({ ok: true, checkedAt: new Date().toISOString(), migrations: { configured: false, pending: 0, applied: 0, total: 0, rows: [] }, tables: [], indexes: [] }); },
      async paymentDiagnostics() { return delay({ provider: 'sandbox', created: 0, pending: paymentIntents.filter((p:any)=>p.status==='pending').length, paid: paymentIntents.filter((p:any)=>p.status==='paid').length, failed: paymentIntents.filter((p:any)=>p.status==='failed').length, totalPaidAmount: paymentIntents.filter((p:any)=>p.status==='paid').reduce((s:any,p:any)=>s+p.amount,0), pendingAmount: paymentIntents.filter((p:any)=>p.status==='pending').reduce((s:any,p:any)=>s+p.amount,0) }); },
      async paymentIntents() { return delay(paymentIntents as any); },
      async financeDiagnostics() { return delay({ totalTopups: wallet, totalWithdrawRequests: 50000, pendingWithdrawAmount: 50000, paidWithdrawAmount: 0, failedWithdrawAmount: 0, totalRewardsPaid: 0, pendingRewardHoldAmount: rewardHolds.reduce((s:any,h:any)=>s+h.amount,0), netCashFlow: wallet, pendingWithdrawCount: withdrawals.filter((w:any)=>w.status==='pending').length }); },
      async supportDiagnostics() { return delay({ open: supportTicketsAdmin.filter((t:any)=>t.status==='open').length, answered: supportTicketsAdmin.filter((t:any)=>t.status==='answered').length, escalated: 0, closed: 0, urgent: supportTicketsAdmin.filter((t:any)=>t.priority==='urgent').length, unassigned: supportTicketsAdmin.filter((t:any)=>!t.assignedAdminId).length }); },
      async supportTickets() { return delay(supportTicketsAdmin as any); },
      async supportTicket(id) { return delay({ ticket: supportTicketsAdmin.find((t:any)=>t.id===id) ?? supportTicketsAdmin[0], messages: [] } as any); },
      async replySupportTicket(id, body) { supportTicketsAdmin = supportTicketsAdmin.map((t:any)=>t.id===id?{...t,reply:body,status:'answered'}:t); return delay(supportTicketsAdmin.find((t:any)=>t.id===id) as any); },
      async updateSupportTicketStatus(id, status) { supportTicketsAdmin = supportTicketsAdmin.map((t:any)=>t.id===id?{...t,status}:t); return delay(supportTicketsAdmin.find((t:any)=>t.id===id) as any); },
      async withdrawals() { return delay(withdrawals as any); },
      async updateWithdrawalStatus(id, action) { withdrawals = withdrawals.map((w:any)=>w.id===id?{...w,status:action==='approve'?'paid':'failed'}:w); return delay(withdrawals.find((w:any)=>w.id===id) as any); },
      async auditLogs() { return delay([]); },
      async users() { return delay([{ id: 'u1', phone: '+989120000000', username: mockUser.username, displayName: mockUser.displayName, plan: mockUser.plan, role: 'user', status: 'active', level: mockUser.level, xp: mockUser.xp, weeklyScore: mockUser.weeklyScore, wallet, coins, hearts, riskScore: 45, riskLevel: 'medium' }]); },
      async userOverview(id) { return delay({ user: { id, phone: '+989120000000', username: mockUser.username, displayName: mockUser.displayName, plan: mockUser.plan, role: 'user', status: 'active', level: mockUser.level, xp: mockUser.xp, weeklyScore: mockUser.weeklyScore, wallet, coins, hearts, riskScore: 45, riskLevel: 'medium' }, balances: { wallet, coins, hearts, tickets }, transactions: [], devices: deviceBindings, riskProfile: riskUsers[0], tickets: supportTicketsAdmin, integritySignals, rewardHolds } as any); },
      async updateUserStatus(id, status) { return delay({ id, phone: '+989120000000', username: mockUser.username, displayName: mockUser.displayName, plan: mockUser.plan, role: 'user', status, level: mockUser.level, xp: mockUser.xp, weeklyScore: mockUser.weeklyScore, wallet, coins, hearts } as any); },
      async updateUserRole(id, role) { return delay({ id, phone: '+989120000000', username: mockUser.username, displayName: mockUser.displayName, plan: mockUser.plan, role, status: 'active', level: mockUser.level, xp: mockUser.xp, weeklyScore: mockUser.weeklyScore, wallet, coins, hearts } as any); },
      async listQuestions() { return delay(questionSeed); },
      async createQuestion(input) { return delay({ id: `q_${Date.now()}`, category: input.category ?? 'عمومی', difficulty: input.difficulty ?? 'easy', text: input.text ?? 'سؤال جدید', options: input.options ?? ['الف','ب','ج','د'], correctIndex: input.correctIndex ?? 0 }); },
      async updateQuestionStatus(id, status) { const q = questionSeed.find((x) => x.id === id) ?? questionSeed[0]; return delay({ ...q, status } as any); },
      async exportQuestions() { return delay(questionSeed); },
      async importQuestions(questions) { return delay({ imported: questions.length }); },
      async rewardTuning() { return delay(gameConfig); },
      async rewardHoldDiagnostics() { return delay({ pending: rewardHolds.filter((h:any)=>h.status==='pending').length, approved: rewardHolds.filter((h:any)=>h.status==='approved').length, rejected: rewardHolds.filter((h:any)=>h.status==='rejected').length, released: rewardHolds.filter((h:any)=>h.status==='released').length, totalHeldAmount: rewardHolds.reduce((s:any,h:any)=>s+h.amount,0), pendingAmount: rewardHolds.filter((h:any)=>h.status==='pending').reduce((s:any,h:any)=>s+h.amount,0) }); },
      async rewardHolds() { return delay(rewardHolds as any); },
      async updateRewardHoldStatus(id, status) { rewardHolds = rewardHolds.map((h:any)=>h.id===id?{...h,status:status==='approved'?'released':'rejected',reviewedAt:new Date().toISOString(),releasedAt:status==='approved'?new Date().toISOString():undefined}:h); return delay(rewardHolds.find((h:any)=>h.id===id) as any); },
      async patchReward(modeId, patch) { return delay({ modeId, ...patch }); },
      async featureFlags() { return delay([{ key:'daily_rewards', enabled:true, description:'Daily rewards' },{ key:'battle_pass', enabled:false, description:'Future battle pass' }]); },
      async patchFeatureFlag(key, enabled) { return delay({ key, enabled, description:'Updated flag' }); },
      async themes() { return delay([{ id:'paid', name:'Paid Gold', primary:'#FFD21F', accent:'#F5B90D', enabled:true },{ id:'free', name:'Practice Sky', primary:'#73D9FF', accent:'#1597D2', enabled:true }]); },
      async upsertTheme(input) { return delay({ id: input.id || 'theme_mock', name: input.name || 'Theme', primary: input.primary || '#FFD21F', accent: input.accent || '#F5B90D', enabled: input.enabled ?? true }); },
      async leaderboardDiagnostics() { return delay({ adapter: 'memory', boardSizes: { weekly: 3, overall: 3, winnings: 3 }, lastUpdatedAt: new Date().toISOString(), fallbackAvailable: true }); },
      async monitoringDiagnostics() { return delay({ open: errorReports.filter((r:any)=>r.status==='open').length, triaged: 0, resolved: 0, ignored: 0, fatal: errorReports.filter((r:any)=>r.severity==='fatal').length, frontend: errorReports.length, backend: 0, last24h: errorReports.length, topMessages: [] }); },
      async monitoringReports() { return delay(errorReports as any); },
      async updateMonitoringReportStatus(id, status) { errorReports = errorReports.map((r:any)=>r.id===id?{...r,status}:r); return delay(errorReports.find((r:any)=>r.id===id) as any); },
      async notificationDiagnostics() { return delay({ provider: 'log', vapidConfigured: false, subscriptions: 1, queued: notificationsList.length, sent: 0, failed: 0, unread: notificationsList.filter((n:any)=>!n.readAt).length }); },
      async deviceDiagnostics() { return delay({ devices: 1, bindings: deviceBindings.length, sharedDevices: 0, highRiskUsers: 0, criticalRiskUsers: 0, topRiskUsers: riskUsers }); },
      async riskUsers() { return delay(riskUsers as any); },
      async userDevices() { return delay(deviceBindings as any); },
      async updateDeviceBindingStatus(id, status) { deviceBindings = deviceBindings.map((b:any)=>b.id===id?{...b,trustStatus:status}:b); return delay(deviceBindings.find((b:any)=>b.id===id) as any); },
      async integrityDiagnostics() { return delay({ totalSignals: integritySignals.length, openSignals: integritySignals.filter((s:any)=>s.status==='open').length, criticalSignals: integritySignals.filter((s:any)=>s.severity==='critical').length, reviewingSignals: integritySignals.filter((s:any)=>s.status==='reviewing').length, confirmedSignals: integritySignals.filter((s:any)=>s.status==='confirmed').length, dismissedSignals: integritySignals.filter((s:any)=>s.status==='dismissed').length, avgRiskScore: Math.round(integritySignals.reduce((a:any,b:any)=>a+b.riskScore,0)/Math.max(1,integritySignals.length)), topSignalTypes: [{ type: 'FAST_CORRECT_ANSWER', count: integritySignals.length }], topRiskUsers: [{ userId: 'u1', riskScore: 45, signals: integritySignals.length }] }); },
      async integritySignals() { return delay(integritySignals as any); },
      async updateIntegritySignalStatus(id, status) { integritySignals = integritySignals.map((s:any)=>s.id===id?{...s,status,reviewedAt:new Date().toISOString()}:s); return delay(integritySignals.find((s:any)=>s.id===id) as any); },
      async broadcastNotification(input) { notificationsList.unshift({ id: `n_${Date.now()}`, userId: 'u1', type: input.type, title: input.title, body: input.body, data: input.data ?? {}, channel: input.push ? 'push' : 'in_app', status: 'queued', createdAt: new Date().toISOString() } as any); return delay({ created: 1, sent: 0, skipped: 0 }); }
    }
  };
}




function mockCharacterCatalog() {
  const states = [
    { id:'idle', title:'آماده', src:'/character-assets/states/idle.png' },
    { id:'happy', title:'خوشحال', src:'/character-assets/states/happy.png' },
    { id:'sad', title:'ناراحت', src:'/character-assets/states/sad.png' },
    { id:'win', title:'برنده', src:'/character-assets/states/win.png' },
    { id:'lose', title:'بازنده', src:'/character-assets/states/lose.png' }
  ];
  const i = (id:string, slot:string, title:string, src:string, rarity='common', priceCoins=0, unlockLevel=1, tags:string[]=[])=>( { id, slot, title, src, rarity, priceCoins, unlockLevel, tags } );
  const items = [
    i('none_head','head','بدون آیتم','/character-assets/outfits/head/none.png'), i('cap_blue','head','کلاه آبی','/character-assets/outfits/head/cap_blue.png','common',120), i('crown_gold','head','تاج طلایی','/character-assets/outfits/head/crown_gold.png','legendary',900,5), i('halo','head','هاله نور','/character-assets/outfits/head/halo.png','epic',650,4),
    i('none_body','body','لباس اصلی','/character-assets/outfits/body/none.png'), i('hoodie_sky','body','هودی آسمانی','/character-assets/outfits/body/hoodie_sky.png','common',180), i('jacket_purple','body','ژاکت بنفش','/character-assets/outfits/body/jacket_purple.png','rare',350,2), i('badge_star','body','نشان ستاره','/character-assets/outfits/body/badge_star.png','epic',500,3),
    i('none_shoes','shoes','کفش اصلی','/character-assets/outfits/shoes/none.png'), i('sneakers_blue','shoes','اسنیکر آبی','/character-assets/outfits/shoes/sneakers_blue.png','common',160), i('boots_black','shoes','بوت مشکی','/character-assets/outfits/shoes/boots_black.png','rare',320,2), i('gold_steps','shoes','کفش طلایی','/character-assets/outfits/shoes/gold_steps.png','legendary',850,5)
  ];
  return { states, items, slots:['head','body','shoes'], defaultLoadout: { state:'idle', outfit:{ head:'none_head', body:'none_body', shoes:'none_shoes' } } } as any;
}

function mockLeaderboard(kind: LeaderboardKind, limit: number): LeaderboardDto {
  const base = [
    { userId: 'u5', username: 'NimaX77', displayName: 'نیما', avatar: '👾', level: 8, weekly: 12850, overall: 28100, winnings: 2350000 },
    { userId: 'u6', username: 'SanaGamer01', displayName: 'ثنا', avatar: '🐙', level: 7, weekly: 11920, overall: 25000, winnings: 1980000 },
    { userId: 'u1', username: mockUser.username, displayName: mockUser.displayName, avatar: '🦁', level: mockUser.level, weekly: mockUser.weeklyScore, overall: mockUser.xp, winnings: wallet }
  ];
  const metricLabel = kind === 'weekly' ? 'weeklyScore' : kind === 'overall' ? 'xp' : 'winnings';
  const title = kind === 'weekly' ? 'Weekly XP League' : kind === 'overall' ? 'Overall XP' : 'Highest Winnings';
  return {
    kind,
    title,
    metricLabel,
    generatedAt: new Date().toISOString(),
    entries: base
      .map((item) => ({ ...item, score: Number(item[kind]), metric: kind, highlighted: item.userId === 'u1' }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item, index) => ({ rank: index + 1, userId: item.userId, username: item.username, displayName: item.displayName, avatar: item.avatar, level: item.level, score: item.score, metric: kind, highlighted: item.highlighted }))
  };
}

function requireMatch(): MatchSnapshotDto {
  if (!activeMatch) throw new Error('No active mock match');
  return activeMatch;
}

function uid(prefix: string): string { return `${prefix}_${Math.random().toString(36).slice(2, 10)}`; }
function delay<T>(value: T, ms = 120): Promise<T> { return new Promise((resolve) => setTimeout(() => resolve(value), ms)); }
