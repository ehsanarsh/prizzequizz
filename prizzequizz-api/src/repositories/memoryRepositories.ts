import { db } from './memory.js';
import type { RepositoryBundle, RewardRecord } from './contracts.js';
import type { AnswerSubmission, BetaAccess, BetaInvite, BetaInviteStatus, CharacterInventory, CharacterItem, CharacterItemStatus, CharacterUnlockEvent, DeviceRecord, DeviceTrustStatus, ErrorReport, ErrorReportStatus, IntegritySignal, IntegrityStatus, Match, MatchEvent, NotificationPreferences, NotificationRecord, PaymentIntent, PaymentIntentStatus, PushSubscriptionRecord, Question, RewardHold, RewardHoldStatus, SupportMessage, SupportTicket, SupportTicketStatus, Transaction, User, UserDeviceBinding, UserRiskProfile } from '../types/domain.js';

export const memoryRepositories: RepositoryBundle = {
  beta: {
    async saveInvite(invite: BetaInvite): Promise<void> { db.betaInvites.set(invite.code.toUpperCase(), { ...invite, code: invite.code.toUpperCase() }); },
    async findInvite(code: string): Promise<BetaInvite | null> { return db.betaInvites.get(code.toUpperCase()) ?? null; },
    async listInvites(limit = 100): Promise<BetaInvite[]> { return [...db.betaInvites.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0, limit); },
    async updateInviteStatus(code: string, status: BetaInviteStatus): Promise<BetaInvite | null> { const invite = db.betaInvites.get(code.toUpperCase()); if (!invite) return null; invite.status = status; db.betaInvites.set(invite.code, invite); return invite; },
    async saveAccess(access: BetaAccess): Promise<void> { db.betaAccess.set(access.userId, access); },
    async findAccess(userId: string): Promise<BetaAccess | null> { return db.betaAccess.get(userId) ?? null; },
    async listAccess(limit = 100): Promise<BetaAccess[]> { return [...db.betaAccess.values()].sort((a,b)=>b.grantedAt.localeCompare(a.grantedAt)).slice(0, limit); }
  },
  characters: {
    async listItems(status?: CharacterItemStatus): Promise<CharacterItem[]> { return [...db.characterItems.values()].filter((item) => !status || item.status === status).sort((a,b)=>a.slot.localeCompare(b.slot)||a.title.localeCompare(b.title)); },
    async findItemById(id: string): Promise<CharacterItem | null> { return db.characterItems.get(id) ?? null; },
    async saveItem(item: CharacterItem): Promise<void> { db.characterItems.set(item.id, item); },
    async updateItemStatus(id: string, status: CharacterItemStatus): Promise<CharacterItem | null> { const item = db.characterItems.get(id); if (!item) return null; item.status = status; item.updatedAt = new Date().toISOString(); db.characterItems.set(id, item); return item; },
    async getInventory(userId: string): Promise<CharacterInventory | null> { return db.characterInventories.get(userId) ?? null; },
    async saveInventory(inventory: CharacterInventory): Promise<void> { db.characterInventories.set(inventory.userId, inventory); },
    async appendUnlockEvent(event: CharacterUnlockEvent): Promise<void> { db.characterUnlockEvents.set(event.id, event); },
    async listUnlockEvents(userId: string, limit = 100): Promise<CharacterUnlockEvent[]> { return [...db.characterUnlockEvents.values()].filter((e) => e.userId === userId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0, limit); }
  },
  users: {
    async findById(id: string): Promise<User | null> { return db.users.get(id) ?? null; },
    async findByPhone(phone: string): Promise<User | null> { return [...db.users.values()].find((u) => u.phone === phone) ?? null; },
    async list(limit = 1000): Promise<User[]> { return [...db.users.values()].slice(0, limit); },
    async save(user: User): Promise<void> { db.users.set(user.id, user); },
    async updateLifelines(userId: string, lifelines: { p5050: number; psecond: number; pstats: number }): Promise<void> { const u = db.users.get(userId); if (u) { u.lifelines = lifelines; db.users.set(userId, u); } }
  },
  questions: {
    async findById(id: string): Promise<Question | null> { return db.questions.get(id) ?? null; },
    async listApproved(): Promise<Question[]> { return [...db.questions.values()].filter((q) => q.status === 'approved'); },
    async listAll(status?: string): Promise<Question[]> { return [...db.questions.values()].filter((q) => !status || q.status === status); },
    async save(question: Question): Promise<void> { db.questions.set(question.id, question); }
  },
  matches: {
    async findById(id: string): Promise<Match | null> { return db.matches.get(id) ?? null; },
    async save(match: Match): Promise<void> { db.matches.set(match.id, match); }
  },
  answers: {
    async findByIdempotencyKey(key: string): Promise<AnswerSubmission | null> { return [...db.answers.values()].find((a) => a.idempotencyKey === key) ?? null; },
    async listByMatch(matchId: string): Promise<AnswerSubmission[]> { return [...db.answers.values()].filter((a) => a.matchId === matchId).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)); },
    async listByUser(userId: string, limit = 100): Promise<AnswerSubmission[]> { return [...db.answers.values()].filter((a) => a.userId === userId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0, limit); },
    async save(answer: AnswerSubmission): Promise<void> { db.answers.set(answer.id, answer); }
  },
  rewards: {
    async findByIdempotencyKey(key: string): Promise<RewardRecord | null> { return [...db.rewards.values()].find((r) => r.idempotencyKey === key) ?? null; },
    async save(reward: RewardRecord): Promise<void> { if (!reward.id) throw new Error('REWARD_ID_REQUIRED'); db.rewards.set(reward.id, reward); }
  },
  rewardHolds: {
    async save(hold: RewardHold): Promise<void> { db.rewardHolds.set(hold.id, hold); },
    async findById(id: string): Promise<RewardHold | null> { return db.rewardHolds.get(id) ?? null; },
    async findByIdempotencyKey(idempotencyKey: string): Promise<RewardHold | null> { return [...db.rewardHolds.values()].find((h) => h.idempotencyKey === idempotencyKey) ?? null; },
    async list(filter = {}): Promise<RewardHold[]> { const limit = Math.min(500, Math.max(1, Number((filter as any).limit ?? 100))); return [...db.rewardHolds.values()].filter((h) => !(filter as any).userId || h.userId === (filter as any).userId).filter((h) => !(filter as any).matchId || h.matchId === (filter as any).matchId).filter((h) => !(filter as any).status || h.status === (filter as any).status).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0, limit); },
    async updateStatus(id: string, status: RewardHoldStatus, reviewedBy: string, extra: Partial<RewardHold> = {}): Promise<RewardHold | null> { const hold = db.rewardHolds.get(id); if (!hold) return null; const now = new Date().toISOString(); Object.assign(hold, extra, { status, reviewedBy, reviewedAt: now }); db.rewardHolds.set(id, hold); return hold; }
  },
  support: {
    async saveTicket(ticket: SupportTicket): Promise<void> { db.supportTickets.set(ticket.id, ticket); },
    async findTicketById(id: string): Promise<SupportTicket | null> { return db.supportTickets.get(id) ?? null; },
    async listTickets(filter = {}): Promise<SupportTicket[]> { const f = filter as any; const limit = Math.min(500, Math.max(1, Number(f.limit ?? 100))); return [...db.supportTickets.values()].filter((t) => !f.userId || t.userId === f.userId).filter((t) => !f.status || t.status === f.status).filter((t) => !f.category || t.category === f.category).filter((t) => !f.priority || t.priority === f.priority).filter((t) => !f.assignedAdminId || t.assignedAdminId === f.assignedAdminId).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit); },
    async updateTicket(id: string, patch: Partial<SupportTicket>): Promise<SupportTicket | null> { const t = db.supportTickets.get(id); if (!t) return null; Object.assign(t, patch, { updatedAt: new Date().toISOString() }); db.supportTickets.set(id, t); return t; },
    async appendMessage(message: SupportMessage): Promise<void> { db.supportMessages.set(message.id, message); },
    async listMessages(ticketId: string): Promise<SupportMessage[]> { return [...db.supportMessages.values()].filter((m) => m.ticketId === ticketId).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)); }
  },
  transactions: {
    async findById(id: string): Promise<Transaction | null> { return db.transactions.get(id) ?? null; },
    async list(filter = {}): Promise<Transaction[]> {
      const f = filter as any;
      const limit = Math.min(1000, Math.max(1, Number(f.limit ?? 100)));
      return [...db.transactions.values()]
        .filter((t) => !f.userId || t.userId === f.userId)
        .filter((t) => !f.type || t.type === f.type)
        .filter((t) => !f.direction || t.direction === f.direction)
        .filter((t) => !f.status || t.status === f.status)
        .filter((t) => !f.currency || t.currency === f.currency)
        .sort((a,b)=>b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    },
    async listByUser(userId: string): Promise<Transaction[]> { return [...db.transactions.values()].filter((t) => t.userId === userId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)); },
    async listWinnings(limit = 100): Promise<{ userId: string; score: number }[]> {
      const totals = new Map<string, number>();
      for (const t of db.transactions.values()) {
        if (t.direction !== 'in' || t.status === 'failed') continue;
        if (!['reward', 'win'].includes(t.type)) continue;
        if (!['cash', 'coins'].includes(t.currency)) continue;
        totals.set(t.userId, (totals.get(t.userId) ?? 0) + Number(t.amount));
      }
      return [...totals.entries()].map(([userId, score]) => ({ userId, score })).sort((a,b)=>b.score-a.score).slice(0, limit);
    },
    async save(transaction: Transaction): Promise<void> { db.transactions.set(transaction.id, transaction); },
    async updateStatus(id: string, status: Transaction['status'], reference?: string): Promise<Transaction | null> { const txn = db.transactions.get(id); if (!txn) return null; txn.status = status; if (reference) txn.reference = reference; db.transactions.set(id, txn); return txn; }
  },
  matchEvents: {
    async append(event: MatchEvent): Promise<void> { db.matchEvents.set(event.id, event); },
    async listByMatch(matchId: string): Promise<MatchEvent[]> { return [...db.matchEvents.values()].filter((e) => e.matchId === matchId).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)); }
  },
  devices: {
    async findById(id: string): Promise<DeviceRecord | null> { return db.devices.get(id) ?? null; },
    async findByFingerprintHash(fingerprintHash: string): Promise<DeviceRecord | null> { return [...db.devices.values()].find((d) => d.fingerprintHash === fingerprintHash) ?? null; },
    async saveDevice(device: DeviceRecord): Promise<void> { db.devices.set(device.id, device); },
    async listDevices(limit = 500): Promise<DeviceRecord[]> { return [...db.devices.values()].sort((a,b)=>b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, limit); },
    async findBinding(userId: string, deviceId: string): Promise<UserDeviceBinding | null> { return [...db.userDeviceBindings.values()].find((b) => b.userId === userId && b.deviceId === deviceId) ?? null; },
    async saveBinding(binding: UserDeviceBinding): Promise<void> { db.userDeviceBindings.set(binding.id, binding); },
    async listBindingsByUser(userId: string): Promise<UserDeviceBinding[]> { return [...db.userDeviceBindings.values()].filter((b) => b.userId === userId).sort((a,b)=>b.lastSeenAt.localeCompare(a.lastSeenAt)); },
    async listBindingsByDevice(deviceId: string): Promise<UserDeviceBinding[]> { return [...db.userDeviceBindings.values()].filter((b) => b.deviceId === deviceId).sort((a,b)=>b.lastSeenAt.localeCompare(a.lastSeenAt)); },
    async updateBindingStatus(bindingId: string, status: DeviceTrustStatus): Promise<UserDeviceBinding | null> { const b = db.userDeviceBindings.get(bindingId); if (!b) return null; b.trustStatus = status; b.lastSeenAt = new Date().toISOString(); db.userDeviceBindings.set(bindingId, b); return b; },
    async getRiskProfile(userId: string): Promise<UserRiskProfile | null> { return db.userRiskProfiles.get(userId) ?? null; },
    async saveRiskProfile(profile: UserRiskProfile): Promise<void> { db.userRiskProfiles.set(profile.userId, profile); },
    async listRiskProfiles(limit = 100): Promise<UserRiskProfile[]> { return [...db.userRiskProfiles.values()].sort((a,b)=>b.riskScore-a.riskScore || b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit); }
  },
  integrity: {
    async save(signal: IntegritySignal): Promise<void> { db.integritySignals.set(signal.id, signal); },
    async list(filter = {}): Promise<IntegritySignal[]> {
      const limit = Math.min(500, Math.max(1, Number((filter as any).limit ?? 100)));
      return [...db.integritySignals.values()]
        .filter((s) => !(filter as any).userId || s.userId === (filter as any).userId)
        .filter((s) => !(filter as any).matchId || s.matchId === (filter as any).matchId)
        .filter((s) => !(filter as any).status || s.status === (filter as any).status)
        .filter((s) => !(filter as any).severity || s.severity === (filter as any).severity)
        .sort((a,b)=>b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    },
    async findById(id: string): Promise<IntegritySignal | null> { return db.integritySignals.get(id) ?? null; },
    async updateStatus(id: string, status: IntegrityStatus, reviewedBy: string): Promise<IntegritySignal | null> { const signal = db.integritySignals.get(id); if (!signal) return null; signal.status = status; signal.reviewedBy = reviewedBy; signal.reviewedAt = new Date().toISOString(); db.integritySignals.set(id, signal); return signal; }
  },
  errorReports: {
    async save(report: ErrorReport): Promise<void> { db.errorReports.set(report.id, report); },
    async findById(id: string): Promise<ErrorReport | null> { return db.errorReports.get(id) ?? null; },
    async list(filter = {}): Promise<ErrorReport[]> { const f = filter as any; const limit = Math.min(500, Math.max(1, Number(f.limit ?? 100))); return [...db.errorReports.values()].filter((r)=>!f.userId||r.userId===f.userId).filter((r)=>!f.status||r.status===f.status).filter((r)=>!f.source||r.source===f.source).filter((r)=>!f.severity||r.severity===f.severity).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0, limit); },
    async updateStatus(id: string, status: ErrorReportStatus, resolvedBy: string): Promise<ErrorReport | null> { const report = db.errorReports.get(id); if (!report) return null; report.status = status; if (status === 'resolved' || status === 'ignored') { report.resolvedAt = new Date().toISOString(); report.resolvedBy = resolvedBy; } db.errorReports.set(id, report); return report; }
  },
  payments: {
    async save(intent: PaymentIntent): Promise<void> { db.paymentIntents.set(intent.id, intent); },
    async findById(id: string): Promise<PaymentIntent | null> { return db.paymentIntents.get(id) ?? null; },
    async findByIdempotencyKey(key: string): Promise<PaymentIntent | null> { return [...db.paymentIntents.values()].find((i) => i.idempotencyKey === key) ?? null; },
    async list(filter = {}): Promise<PaymentIntent[]> { const f = filter as any; const limit = Math.min(500, Math.max(1, Number(f.limit ?? 100))); return [...db.paymentIntents.values()].filter((i)=>!f.userId||i.userId===f.userId).filter((i)=>!f.status||i.status===f.status).filter((i)=>!f.provider||i.provider===f.provider).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0, limit); },
    async updateStatus(id: string, status: PaymentIntentStatus, patch: Partial<PaymentIntent> = {}): Promise<PaymentIntent | null> { const intent = db.paymentIntents.get(id); if (!intent) return null; Object.assign(intent, patch, { status, updatedAt: new Date().toISOString() }); db.paymentIntents.set(id, intent); return intent; }
  },
  notifications: {
    async listSubscriptions(userId: string): Promise<PushSubscriptionRecord[]> { return [...db.pushSubscriptions.values()].filter((s) => s.userId === userId && !s.revokedAt).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)); },
    async saveSubscription(subscription: PushSubscriptionRecord): Promise<void> { db.pushSubscriptions.set(subscription.id, subscription); },
    async revokeSubscription(subscriptionId: string, userId: string): Promise<boolean> { const item = db.pushSubscriptions.get(subscriptionId); if (!item || item.userId !== userId || item.revokedAt) return false; item.revokedAt = new Date().toISOString(); item.updatedAt = item.revokedAt; db.pushSubscriptions.set(item.id, item); return true; },
    async getPreferences(userId: string): Promise<NotificationPreferences | null> { return db.notificationPreferences.get(userId) ?? null; },
    async savePreferences(preferences: NotificationPreferences): Promise<void> { db.notificationPreferences.set(preferences.userId, preferences); },
    async listNotifications(userId: string, limit = 50): Promise<NotificationRecord[]> { return [...db.notifications.values()].filter((n) => n.userId === userId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0, limit); },
    async saveNotification(notification: NotificationRecord): Promise<void> { db.notifications.set(notification.id, notification); },
    async markRead(notificationId: string, userId: string): Promise<boolean> { const n = db.notifications.get(notificationId); if (!n || n.userId !== userId) return false; n.readAt = n.readAt ?? new Date().toISOString(); n.status = 'read'; db.notifications.set(n.id, n); return true; },
    async markAllRead(userId: string): Promise<number> { let count = 0; for (const n of db.notifications.values()) { if (n.userId === userId && !n.readAt) { n.readAt = new Date().toISOString(); n.status = 'read'; count++; } } return count; }
  }
};
