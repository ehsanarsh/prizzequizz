import type {
  BetaAccessDto,
  BetaDiagnosticsDto,
  BetaInviteDto,
  BetaInviteStatus,
  CharacterCatalogDto,
  CharacterInventoryDto,
  CharacterItemDto,
  CharacterItemStatus,
  CharacterUnlockEventDto,
  CharacterSlot,
  CharacterStateKey,
  ClaimRewardRequest,
  ClaimRewardResponse,
  RewardHoldDiagnosticsDto,
  RewardHoldDto,
  CreateMatchRequest,
  CreateMatchResponse,
  ErrorReportDiagnosticsDto,
  ErrorReportDto,
  ErrorReportSeverity,
  ErrorReportStatus,
  FinanceDiagnosticsDto,
  FriendDto,
  LeaderboardDiagnosticsDto,
  LeaderboardDto,
  LeaderboardKind,
  DeviceBindingDto,
  DeviceDiagnosticsDto,
  DeviceTrustStatus,
  IntegrityDiagnosticsDto,
  IntegritySignalDto,
  IntegrityStatus,
  MatchSnapshotDto,
  DatabaseVerificationDto,
  MigrationStatusDto,
  UserRiskProfileDto,
  NotificationDiagnosticsDto,
  NotificationDto,
  NotificationPreferencesDto,
  NotificationType,
  PaymentDiagnosticsDto,
  PaymentIntentDto,
  PaymentIntentStatus,
  PushSubscriptionDto,
  MatchmakingTicketDto,
  PublicProfileDto,
  QuestionDto,
  SubmitAnswerRequest,
  SubmitAnswerResponse,
  SupportDiagnosticsDto,
  SupportMessageDto,
  SupportTicketDto,
  AdminAnalyticsDto,
  AdminAuditLogDto,
  AdminFeatureFlagDto,
  AdminThemeDto,
  AdminUserDto,
  AdminUserOverviewDto,
  TransactionDto,
  UserDto,
  WalletDto
} from './contracts';

export interface PrizzeQuizzApi {
  auth: {
    login(phone: string): Promise<{ otpRequired: boolean; requestId: string }>;
    verifyOtp(requestId: string, code: string, inviteCode?: string): Promise<{ accessToken: string; refreshToken: string; user: UserDto }>;
    refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; sessionId?: string }>;
    logout(refreshToken: string): Promise<{ revoked: boolean }>;
  };
  users: {
    me(): Promise<UserDto>;
    profile(userId: string): Promise<PublicProfileDto>;
  };
  beta: {
    status(): Promise<{ required: boolean; access?: BetaAccessDto | null }>;
    redeem(code: string): Promise<BetaAccessDto>;
  };
  characters: {
    catalog(): Promise<CharacterCatalogDto>;
    me(): Promise<CharacterInventoryDto>;
    equip(input: { slot?: CharacterSlot; itemId?: string; state?: CharacterStateKey }): Promise<CharacterInventoryDto>;
    unlock(itemId: string): Promise<CharacterInventoryDto>;
    purchase(itemId: string): Promise<CharacterInventoryDto>;
    randomize(): Promise<CharacterInventoryDto>;
  };
  leaderboards: {
    get(kind: LeaderboardKind, limit?: number): Promise<LeaderboardDto>;
    weekly(limit?: number): Promise<LeaderboardDto>;
    overall(limit?: number): Promise<LeaderboardDto>;
    winnings(limit?: number): Promise<LeaderboardDto>;
  };
  matchmaking: {
    enqueue(input: CreateMatchRequest & { skill?: number }): Promise<MatchmakingTicketDto>;
    get(ticketId: string): Promise<MatchmakingTicketDto>;
    cancel(ticketId: string): Promise<MatchmakingTicketDto>;
    bot(ticketId: string): Promise<MatchmakingTicketDto>;
    stats(): Promise<{ queued: number; matched: number }>;
  };
  matches: {
    create(input: CreateMatchRequest): Promise<CreateMatchResponse>;
    get(matchId: string): Promise<MatchSnapshotDto>;
    start(matchId: string): Promise<MatchSnapshotDto>;
    continue(matchId: string): Promise<MatchSnapshotDto>;
    exit(matchId: string): Promise<MatchSnapshotDto>;
  };
  questions: {
    next(matchId?: string): Promise<QuestionDto>;
    submitAnswer(input: SubmitAnswerRequest): Promise<SubmitAnswerResponse>;
  };
  monitoring: {
    report(input: { source?: string; severity?: ErrorReportSeverity; message: string; stack?: string; route?: string; userAgent?: string; appVersion?: string; buildId?: string; deviceId?: string; metadata?: Record<string, unknown> }): Promise<ErrorReportDto>;
  };
  notifications: {
    list(limit?: number): Promise<NotificationDto[]>;
    preferences(): Promise<NotificationPreferencesDto>;
    updatePreferences(patch: Partial<NotificationPreferencesDto>): Promise<NotificationPreferencesDto>;
    subscribe(input: { endpoint: string; keys: { p256dh: string; auth: string }; deviceLabel?: string }): Promise<PushSubscriptionDto>;
    revoke(subscriptionId: string): Promise<{ revoked: boolean }>;
    markRead(id: string): Promise<{ updated: boolean }>;
    markAllRead(): Promise<{ updated: number }>;
  };
  payments: {
    createIntent(input: { amount: number; callbackUrl?: string; idempotencyKey?: string }): Promise<PaymentIntentDto>;
    getIntent(id: string): Promise<PaymentIntentDto>;
    verifyIntent(id: string, status?: 'paid' | 'failed'): Promise<PaymentIntentDto>;
  };
  rewards: {
    claim(input: ClaimRewardRequest): Promise<ClaimRewardResponse>;
  };
  wallet: {
    get(): Promise<WalletDto>;
    topup(amount: number): Promise<WalletDto>;
    withdraw(amount: number): Promise<WalletDto>;
  };
  friends: {
    list(): Promise<FriendDto[]>;
    sendRequest(username: string): Promise<{ sent: boolean }>;
    invite(userId: string, mode: string, entry: string): Promise<{ sent: boolean }>;
  };
  support: {
    listTickets(): Promise<SupportTicketDto[]>;
    createTicket(input: { title: string; category: string; body: string; linkedMatchId?: string; linkedTransactionId?: string; linkedRewardHoldId?: string }): Promise<SupportTicketDto>;
  };
  admin: {
    characterCatalog(status?: CharacterItemStatus): Promise<CharacterItemDto[]>;
    upsertCharacterItem(input: Partial<CharacterItemDto> & { id: string }): Promise<CharacterItemDto>;
    updateCharacterItemStatus(id: string, status: CharacterItemStatus): Promise<CharacterItemDto>;
    unlockCharacterForUser(userId: string, itemId: string): Promise<CharacterInventoryDto>;
    characterUnlockEvents(userId: string, limit?: number): Promise<CharacterUnlockEventDto[]>;
    getConfig(): Promise<Record<string, unknown>>;
    updateConfig(config: Record<string, unknown>): Promise<Record<string, unknown>>;
    patchMode(modeId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
    analytics(): Promise<AdminAnalyticsDto>;
    financeDiagnostics(): Promise<FinanceDiagnosticsDto>;
    betaDiagnostics(): Promise<BetaDiagnosticsDto>;
    betaInvites(limit?: number): Promise<BetaInviteDto[]>;
    createBetaInvite(input: { code?: string; maxUses?: number; expiresAt?: string; note?: string }): Promise<BetaInviteDto>;
    updateBetaInviteStatus(code: string, status: BetaInviteStatus): Promise<BetaInviteDto>;
    betaUsers(limit?: number): Promise<BetaAccessDto[]>;
    databaseStatus(): Promise<MigrationStatusDto[]>;
    databaseVerify(): Promise<DatabaseVerificationDto>;
    paymentDiagnostics(): Promise<PaymentDiagnosticsDto>;
    paymentIntents(filter?: { status?: PaymentIntentStatus; userId?: string; limit?: number }): Promise<PaymentIntentDto[]>;
    supportDiagnostics(): Promise<SupportDiagnosticsDto>;
    supportTickets(filter?: { status?: string; priority?: string; userId?: string; limit?: number }): Promise<SupportTicketDto[]>;
    supportTicket(id: string): Promise<{ ticket: SupportTicketDto; messages: SupportMessageDto[] }>;
    replySupportTicket(id: string, body: string): Promise<SupportTicketDto>;
    updateSupportTicketStatus(id: string, status: string): Promise<SupportTicketDto>;
    withdrawals(filter?: { status?: string; limit?: number; format?: 'json' | 'csv' }): Promise<TransactionDto[] | string>;
    updateWithdrawalStatus(id: string, action: 'approve' | 'reject'): Promise<TransactionDto>;
    auditLogs(): Promise<AdminAuditLogDto[]>;
    users(query?: string, limit?: number): Promise<AdminUserDto[]>;
    userOverview(id: string): Promise<AdminUserOverviewDto>;
    updateUserStatus(id: string, status: 'active' | 'limited' | 'banned', reason?: string): Promise<AdminUserDto>;
    updateUserRole(id: string, role: 'user' | 'admin'): Promise<AdminUserDto>;
    listQuestions(status?: string): Promise<QuestionDto[]>;
    createQuestion(input: Partial<QuestionDto>): Promise<QuestionDto>;
    updateQuestionStatus(id: string, status: string): Promise<QuestionDto>;
    exportQuestions(format?: 'json' | 'csv', status?: string): Promise<QuestionDto[] | string>;
    importQuestions(questions: Partial<QuestionDto>[]): Promise<{ imported: number }>;
    rewardTuning(): Promise<Record<string, unknown>>;
    rewardHoldDiagnostics(): Promise<RewardHoldDiagnosticsDto>;
    rewardHolds(filter?: { status?: string; userId?: string; matchId?: string; limit?: number }): Promise<RewardHoldDto[]>;
    updateRewardHoldStatus(id: string, status: 'approved' | 'rejected'): Promise<RewardHoldDto>;
    patchReward(modeId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
    featureFlags(): Promise<AdminFeatureFlagDto[]>;
    patchFeatureFlag(key: string, enabled: boolean): Promise<AdminFeatureFlagDto>;
    themes(): Promise<AdminThemeDto[]>;
    upsertTheme(input: Partial<AdminThemeDto>): Promise<AdminThemeDto>;
    leaderboardDiagnostics(): Promise<LeaderboardDiagnosticsDto>;
    monitoringDiagnostics(): Promise<ErrorReportDiagnosticsDto>;
    monitoringReports(filter?: { status?: ErrorReportStatus; severity?: ErrorReportSeverity; source?: string; limit?: number }): Promise<ErrorReportDto[]>;
    updateMonitoringReportStatus(id: string, status: ErrorReportStatus): Promise<ErrorReportDto>;
    notificationDiagnostics(): Promise<NotificationDiagnosticsDto>;
    deviceDiagnostics(): Promise<DeviceDiagnosticsDto>;
    riskUsers(limit?: number): Promise<UserRiskProfileDto[]>;
    userDevices(userId: string): Promise<DeviceBindingDto[]>;
    updateDeviceBindingStatus(id: string, status: DeviceTrustStatus): Promise<DeviceBindingDto>;
    integrityDiagnostics(): Promise<IntegrityDiagnosticsDto>;
    integritySignals(filter?: { status?: string; severity?: string; userId?: string; matchId?: string; limit?: number }): Promise<IntegritySignalDto[]>;
    updateIntegritySignalStatus(id: string, status: IntegrityStatus): Promise<IntegritySignalDto>;
    broadcastNotification(input: { userIds?: string[]; type: NotificationType; title: string; body: string; push?: boolean; data?: Record<string, unknown> }): Promise<{ created: number; sent: number; skipped: number }>;
  };

}
