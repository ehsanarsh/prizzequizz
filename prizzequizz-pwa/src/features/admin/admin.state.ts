import { api } from '../../api';
import type { AdminAnalyticsDto, AdminAuditLogDto, AdminFeatureFlagDto, AdminThemeDto, AdminUserDto, BetaAccessDto, BetaDiagnosticsDto, BetaInviteDto, BetaInviteStatus, AdminUserOverviewDto, CharacterItemDto, CharacterItemStatus, DeviceBindingDto, DeviceDiagnosticsDto, DeviceTrustStatus, ErrorReportDiagnosticsDto, ErrorReportDto, ErrorReportStatus, FinanceDiagnosticsDto, IntegrityDiagnosticsDto, IntegritySignalDto, IntegrityStatus, LeaderboardDiagnosticsDto, NotificationDiagnosticsDto, NotificationType, PaymentDiagnosticsDto, PaymentIntentDto, DatabaseVerificationDto, MigrationStatusDto, QuestionDto, RewardHoldDiagnosticsDto, RewardHoldDto, TransactionDto, SupportDiagnosticsDto, SupportTicketDto } from '../../api/contracts';
import { runTask } from '../../core/asyncTask';

export type AdminTab = 'overview' | 'beta' | 'users' | 'characters' | 'config' | 'questions' | 'rewards' | 'rewardReview' | 'finance' | 'payments' | 'database' | 'supportOps' | 'leaderboards' | 'monitoring' | 'notifications' | 'integrity' | 'devices' | 'flags' | 'themes' | 'audit';

let activeTab: AdminTab = 'overview';
let characterItems: CharacterItemDto[] = [];
let config: Record<string, unknown> | null = null;
let analytics: AdminAnalyticsDto | null = null;
let betaDiagnostics: BetaDiagnosticsDto | null = null;
let betaInvites: BetaInviteDto[] = [];
let betaUsers: BetaAccessDto[] = [];
let adminUsers: AdminUserDto[] = [];
let selectedUserOverview: AdminUserOverviewDto | null = null;
let auditLogs: AdminAuditLogDto[] = [];
let questions: QuestionDto[] = [];
let questionFilter = 'approved';
let rewardTuning: Record<string, unknown> | null = null;
let rewardHoldDiagnostics: RewardHoldDiagnosticsDto | null = null;
let rewardHolds: RewardHoldDto[] = [];
let financeDiagnostics: FinanceDiagnosticsDto | null = null;
let paymentDiagnostics: PaymentDiagnosticsDto | null = null;
let paymentIntents: PaymentIntentDto[] = [];
let databaseVerification: DatabaseVerificationDto | null = null;
let migrationStatus: MigrationStatusDto[] = [];
let withdrawals: TransactionDto[] = [];
let supportDiagnostics: SupportDiagnosticsDto | null = null;
let supportTickets: SupportTicketDto[] = [];
let flags: AdminFeatureFlagDto[] = [];
let themes: AdminThemeDto[] = [];
let leaderboardDiagnostics: LeaderboardDiagnosticsDto | null = null;
let monitoringDiagnostics: ErrorReportDiagnosticsDto | null = null;
let errorReports: ErrorReportDto[] = [];
let notificationDiagnostics: NotificationDiagnosticsDto | null = null;
let integrityDiagnostics: IntegrityDiagnosticsDto | null = null;
let integritySignals: IntegritySignalDto[] = [];
let deviceDiagnostics: DeviceDiagnosticsDto | null = null;
let riskUsers: import('../../api/contracts').UserRiskProfileDto[] = [];
let selectedUserDevices: DeviceBindingDto[] = [];

export function getAdminTab(): AdminTab { return activeTab; }
export function setAdminTab(tab: AdminTab): void { activeTab = tab; }
export function getAdminCharacters(): CharacterItemDto[] { return characterItems; }
export function getAdminConfig(): Record<string, unknown> | null { return config; }
export function getAdminAnalytics(): AdminAnalyticsDto | null { return analytics; }
export function getBetaDiagnostics(): BetaDiagnosticsDto | null { return betaDiagnostics; }
export function getBetaInvites(): BetaInviteDto[] { return betaInvites; }
export function getBetaUsers(): BetaAccessDto[] { return betaUsers; }
export function getAdminUsers(): AdminUserDto[] { return adminUsers; }
export function getSelectedUserOverview(): AdminUserOverviewDto | null { return selectedUserOverview; }
export function getAdminAuditLogs(): AdminAuditLogDto[] { return auditLogs; }
export function getAdminQuestions(): QuestionDto[] { return questions; }
export function getQuestionFilter(): string { return questionFilter; }
export function getRewardTuning(): Record<string, unknown> | null { return rewardTuning; }
export function getRewardHoldDiagnostics(): RewardHoldDiagnosticsDto | null { return rewardHoldDiagnostics; }
export function getRewardHolds(): RewardHoldDto[] { return rewardHolds; }
export function getFinanceDiagnostics(): FinanceDiagnosticsDto | null { return financeDiagnostics; }
export function getPaymentDiagnostics(): PaymentDiagnosticsDto | null { return paymentDiagnostics; }
export function getPaymentIntents(): PaymentIntentDto[] { return paymentIntents; }
export function getDatabaseVerification(): DatabaseVerificationDto | null { return databaseVerification; }
export function getMigrationStatus(): MigrationStatusDto[] { return migrationStatus; }
export function getWithdrawals(): TransactionDto[] { return withdrawals; }
export function getSupportDiagnostics(): SupportDiagnosticsDto | null { return supportDiagnostics; }
export function getAdminSupportTickets(): SupportTicketDto[] { return supportTickets; }
export function getFeatureFlags(): AdminFeatureFlagDto[] { return flags; }
export function getAdminThemes(): AdminThemeDto[] { return themes; }
export function getLeaderboardDiagnostics(): LeaderboardDiagnosticsDto | null { return leaderboardDiagnostics; }
export function getMonitoringDiagnostics(): ErrorReportDiagnosticsDto | null { return monitoringDiagnostics; }
export function getErrorReports(): ErrorReportDto[] { return errorReports; }
export function getNotificationDiagnostics(): NotificationDiagnosticsDto | null { return notificationDiagnostics; }
export function getIntegrityDiagnostics(): IntegrityDiagnosticsDto | null { return integrityDiagnostics; }
export function getIntegritySignals(): IntegritySignalDto[] { return integritySignals; }
export function getDeviceDiagnostics(): DeviceDiagnosticsDto | null { return deviceDiagnostics; }
export function getRiskUsers() { return riskUsers; }
export function getSelectedUserDevices(): DeviceBindingDto[] { return selectedUserDevices; }
export function getAdminKey(): string { try { return localStorage.getItem('pq_admin_key') ?? 'dev-admin'; } catch { return 'dev-admin'; } }
export function setAdminKey(key: string): void { try { localStorage.setItem('pq_admin_key', key); } catch {} }

export async function hydrateAdmin(): Promise<void> {
  await runTask('admin.hydrate', async () => {
    const [chars, betaDiag, betaInviteRows, betaUserRows, cfg, an, usersRows, fin, dbVerify, dbStatus, payDiag, payRows, withdrawalsRows, supDiag, supTickets, logs, qs, rewards, holdsDiag, holds, ff, th, lb, monDiag, monReports, nd, integ, sigs, dd, risks] = await Promise.all([
      api.admin.characterCatalog(), api.admin.betaDiagnostics(), api.admin.betaInvites(50), api.admin.betaUsers(50), api.admin.getConfig(), api.admin.analytics(), api.admin.users(), api.admin.financeDiagnostics(), api.admin.databaseVerify(), api.admin.databaseStatus(), api.admin.paymentDiagnostics(), api.admin.paymentIntents({ limit: 30 }), api.admin.withdrawals({ status: 'pending', limit: 50 }) as Promise<TransactionDto[]>, api.admin.supportDiagnostics(), api.admin.supportTickets({ limit: 50 }), api.admin.auditLogs(), api.admin.listQuestions(questionFilter), api.admin.rewardTuning(), api.admin.rewardHoldDiagnostics(), api.admin.rewardHolds({ status: 'pending', limit: 50 }), api.admin.featureFlags(), api.admin.themes(), api.admin.leaderboardDiagnostics(), api.admin.monitoringDiagnostics(), api.admin.monitoringReports({ status: 'open', limit: 50 }), api.admin.notificationDiagnostics(), api.admin.integrityDiagnostics(), api.admin.integritySignals({ limit: 30 }), api.admin.deviceDiagnostics(), api.admin.riskUsers(20)
    ]);
    characterItems = chars; betaDiagnostics = betaDiag; betaInvites = betaInviteRows; betaUsers = betaUserRows; config = cfg; analytics = an; adminUsers = usersRows; financeDiagnostics = fin; databaseVerification = dbVerify; migrationStatus = dbStatus; paymentDiagnostics = payDiag; paymentIntents = payRows; withdrawals = withdrawalsRows; supportDiagnostics = supDiag; supportTickets = supTickets; auditLogs = logs; questions = qs; rewardTuning = rewards; rewardHoldDiagnostics = holdsDiag; rewardHolds = holds; flags = ff; themes = th; leaderboardDiagnostics = lb; monitoringDiagnostics = monDiag; errorReports = monReports; notificationDiagnostics = nd; integrityDiagnostics = integ; integritySignals = sigs; deviceDiagnostics = dd; riskUsers = risks;
  });
}

export async function setQuestionFilter(status: string): Promise<void> {
  questionFilter = status;
  const qs = await runTask('admin.questionsFilter', async () => api.admin.listQuestions(status));
  if (qs) questions = qs;
}

export async function saveConfigFromText(raw: string): Promise<boolean> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const result = await runTask('admin.saveConfig', async () => api.admin.updateConfig(parsed));
  if (result) config = result;
  return !!result;
}

export async function patchDuelTimer(seconds: number): Promise<boolean> {
  const result = await runTask('admin.patchMode', async () => api.admin.patchMode('duel', { timerSeconds: seconds }));
  if (result) config = result;
  return !!result;
}

export async function createAdminQuestion(input: { text: string; category: string; correct: string; wrong: string }): Promise<boolean> {
  const wrongs = input.wrong.split('/').map((x) => x.trim()).filter(Boolean).slice(0, 3);
  if (!input.text.trim() || !input.correct.trim() || wrongs.length < 3) return false;
  const q = await runTask('admin.createQuestion', async () => api.admin.createQuestion({ text: input.text.trim(), category: input.category.trim() || 'عمومی', difficulty: 'medium', options: [input.correct.trim(), ...wrongs], correctIndex: 0 }));
  if (q) questions = [q, ...questions];
  return !!q;
}

export async function importQuestionsFromText(raw: string): Promise<number> {
  const parsed = JSON.parse(raw) as Partial<QuestionDto>[];
  const result = await runTask('admin.importQuestions', async () => api.admin.importQuestions(parsed));
  if (result) await setQuestionFilter(questionFilter);
  return result?.imported ?? 0;
}

export async function exportQuestionsAsJson(): Promise<string> {
  const data = await runTask('admin.exportQuestions', async () => api.admin.exportQuestions('json', questionFilter));
  return JSON.stringify(data ?? [], null, 2);
}

export async function updateAdminQuestionStatus(id: string, status: string): Promise<void> {
  const q = await runTask('admin.questionStatus', async () => api.admin.updateQuestionStatus(id, status));
  if (q) questions = questions.map((item) => item.id === id ? q : item);
}

export async function patchRewardConfig(modeId: string, raw: string): Promise<boolean> {
  const patch = JSON.parse(raw) as Record<string, unknown>;
  const result = await runTask('admin.patchReward', async () => api.admin.patchReward(modeId, patch));
  if (result && rewardTuning) rewardTuning = { ...rewardTuning, [modeId]: result };
  return !!result;
}

export async function patchFlag(key: string, enabled: boolean): Promise<void> {
  const flag = await runTask('admin.patchFlag', async () => api.admin.patchFeatureFlag(key, enabled));
  if (flag) flags = flags.map((f) => f.key === key ? flag : f);
}

export async function upsertAdminTheme(input: Partial<AdminThemeDto>): Promise<boolean> {
  const theme = await runTask('admin.upsertTheme', async () => api.admin.upsertTheme(input));
  if (!theme) return false;
  themes = [theme, ...themes.filter((t) => t.id !== theme.id)];
  return true;
}


export async function broadcastAdminNotification(input: { type: NotificationType; title: string; body: string; push: boolean }): Promise<boolean> {
  const result = await runTask('admin.broadcastNotification', async () => api.admin.broadcastNotification(input));
  if (result) notificationDiagnostics = await api.admin.notificationDiagnostics();
  return !!result;
}


export async function updateIntegrityStatus(id: string, status: IntegrityStatus): Promise<void> {
  const updated = await runTask('admin.integrityStatus', async () => api.admin.updateIntegritySignalStatus(id, status));
  if (updated) {
    integritySignals = integritySignals.map((signal) => signal.id === id ? updated : signal);
    integrityDiagnostics = await api.admin.integrityDiagnostics();
  }
}


export async function loadUserDevices(userId: string): Promise<void> {
  const rows = await runTask('admin.userDevices', async () => api.admin.userDevices(userId));
  if (rows) selectedUserDevices = rows;
}

export async function updateDeviceStatus(id: string, status: DeviceTrustStatus): Promise<void> {
  const updated = await runTask('admin.deviceStatus', async () => api.admin.updateDeviceBindingStatus(id, status));
  if (updated) {
    selectedUserDevices = selectedUserDevices.map((item) => item.id === id ? updated : item);
    deviceDiagnostics = await api.admin.deviceDiagnostics();
    riskUsers = await api.admin.riskUsers(20);
  }
}


export async function updateRewardHoldStatus(id: string, status: 'approved' | 'rejected'): Promise<void> {
  const updated = await runTask('admin.rewardHoldStatus', async () => api.admin.updateRewardHoldStatus(id, status));
  if (updated) {
    rewardHolds = rewardHolds.map((hold) => hold.id === id ? updated : hold).filter((hold) => hold.status === 'pending');
    rewardHoldDiagnostics = await api.admin.rewardHoldDiagnostics();
  }
}


export async function updateWithdrawalStatus(id: string, action: 'approve' | 'reject'): Promise<void> {
  const updated = await runTask('admin.withdrawalStatus', async () => api.admin.updateWithdrawalStatus(id, action));
  if (updated) {
    withdrawals = withdrawals.map((w) => w.id === id ? updated : w).filter((w) => w.status === 'pending');
    financeDiagnostics = await api.admin.financeDiagnostics();
  }
}


export async function replySupportTicket(id: string, body: string): Promise<void> {
  const updated = await runTask('admin.supportReply', async () => api.admin.replySupportTicket(id, body));
  if (updated) {
    supportTickets = supportTickets.map((ticket) => ticket.id === id ? updated : ticket);
    supportDiagnostics = await api.admin.supportDiagnostics();
  }
}

export async function updateSupportStatus(id: string, status: string): Promise<void> {
  const updated = await runTask('admin.supportStatus', async () => api.admin.updateSupportTicketStatus(id, status));
  if (updated) {
    supportTickets = supportTickets.map((ticket) => ticket.id === id ? updated : ticket);
    supportDiagnostics = await api.admin.supportDiagnostics();
  }
}


export async function upsertCharacterCatalogItem(input: Partial<CharacterItemDto> & { id: string }): Promise<boolean> {
  const item = await runTask('admin.characterUpsert', async () => api.admin.upsertCharacterItem(input));
  if (!item) return false;
  characterItems = [item, ...characterItems.filter((x) => x.id !== item.id)];
  return true;
}

export async function updateCharacterCatalogStatus(id: string, status: CharacterItemStatus): Promise<void> {
  const item = await runTask('admin.characterStatus', async () => api.admin.updateCharacterItemStatus(id, status));
  if (item) characterItems = characterItems.map((x) => x.id === id ? item : x);
}


export async function loadAdminUserOverview(id: string): Promise<void> {
  const overview = await runTask('admin.userOverview', async () => api.admin.userOverview(id));
  if (overview) selectedUserOverview = overview;
}

export async function setAdminUserStatus(id: string, status: 'active' | 'limited' | 'banned', reason = ''): Promise<void> {
  const updated = await runTask('admin.userStatus', async () => api.admin.updateUserStatus(id, status, reason));
  if (updated) {
    adminUsers = adminUsers.map((user) => user.id === id ? updated : user);
    if (selectedUserOverview?.user.id === id) selectedUserOverview.user = updated;
  }
}

export async function setAdminUserRole(id: string, role: 'user' | 'admin'): Promise<void> {
  const updated = await runTask('admin.userRole', async () => api.admin.updateUserRole(id, role));
  if (updated) {
    adminUsers = adminUsers.map((user) => user.id === id ? updated : user);
    if (selectedUserOverview?.user.id === id) selectedUserOverview.user = updated;
  }
}


export async function updateMonitoringStatus(id: string, status: ErrorReportStatus): Promise<void> {
  const updated = await runTask('admin.monitoringStatus', async () => api.admin.updateMonitoringReportStatus(id, status));
  if (updated) {
    errorReports = errorReports.map((report) => report.id === id ? updated : report).filter((report) => report.status === 'open');
    monitoringDiagnostics = await api.admin.monitoringDiagnostics();
  }
}


export async function createAdminBetaInvite(input: { code?: string; maxUses?: number; note?: string; expiresAt?: string }): Promise<boolean> {
  const invite = await runTask('admin.betaInviteCreate', async () => api.admin.createBetaInvite(input));
  if (!invite) return false;
  betaInvites = [invite, ...betaInvites.filter((item) => item.code !== invite.code)];
  betaDiagnostics = await api.admin.betaDiagnostics();
  return true;
}

export async function updateAdminBetaInviteStatus(code: string, status: BetaInviteStatus): Promise<void> {
  const updated = await runTask('admin.betaInviteStatus', async () => api.admin.updateBetaInviteStatus(code, status));
  if (updated) {
    betaInvites = betaInvites.map((item) => item.code === code ? updated : item);
    betaDiagnostics = await api.admin.betaDiagnostics();
  }
}
