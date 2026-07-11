import type { GameModeId, PlanType, Question } from '../types/app';

export type UUID = string;
export type Currency = 'coins' | 'cash' | 'xp' | 'heart' | 'ticket' | 'item';
export type MatchPhase = 'created' | 'matchmaking' | 'starting' | 'question' | 'revealing' | 'result' | 'finished';

export interface ApiEnvelope<T> {
  ok: true;
  data: T;
  requestId: string;
}

export interface ApiFailure {
  ok: false;
  error: ApiErrorPayload;
  requestId: string;
}

export type ApiResponse<T> = ApiEnvelope<T> | ApiFailure;

export interface ApiErrorPayload {
  code: string;
  message: string;
  status: number;
  details?: Record<string, unknown>;
}

export interface UserDto {
  id: UUID;
  username: string;
  displayName: string;
  plan: PlanType;
  level: number;
  xp: number;
  weeklyScore: number;
  balances: {
    wallet: number;
    coins: number;
    hearts: number;
    tickets: { bronze: number; silver: number; gold: number };
  };
}

export interface PublicProfileDto {
  id: UUID;
  username: string;
  displayName: string;
  avatar: string;
  level: number;
  league: string;
  winRate: number;
  totalPrize: number;
}


export interface MatchmakingTicketDto {
  id: string;
  userId: string;
  modeId: GameModeId;
  economyType: PlanType;
  coinStake?: number;
  skill: number;
  status: 'queued' | 'matched' | 'cancelled' | 'expired';
  matchId?: string;
  opponentUserId?: string;
  opponentIsBot?: boolean;
  matchQuality?: 'excellent' | 'good' | 'wide' | 'bot';
  waitMs?: number;
  createdAt: string;
  updatedAt: string;
}


export type LeaderboardKind = 'weekly' | 'overall' | 'winnings';

export interface LeaderboardEntryDto {
  rank: number;
  userId: UUID;
  username: string;
  displayName: string;
  avatar: string;
  level: number;
  score: number;
  metric: LeaderboardKind;
  highlighted?: boolean;
}

export interface LeaderboardDto {
  kind: LeaderboardKind;
  title: string;
  metricLabel: string;
  generatedAt: string;
  entries: LeaderboardEntryDto[];
}

export interface LeaderboardDiagnosticsDto {
  adapter: 'memory' | 'redis';
  redisUrl?: string;
  boardSizes: Record<LeaderboardKind, number>;
  lastUpdatedAt?: string;
  fallbackAvailable: boolean;
}


export type CharacterSlot = 'head' | 'body' | 'shoes';
export type CharacterStateKey = 'idle' | 'happy' | 'sad' | 'win' | 'lose';
export type CharacterRarity = 'common' | 'rare' | 'epic' | 'legendary';

export type CharacterItemStatus = 'active' | 'draft' | 'archived';

export interface CharacterItemDto {
  id: string;
  slot: CharacterSlot;
  title: string;
  src: string;
  rarity: CharacterRarity;
  priceCoins: number;
  unlockLevel?: number;
  tags: string[];
  status?: CharacterItemStatus;
  createdAt?: string;
  updatedAt?: string;
}

export interface CharacterStateConfigDto { id: CharacterStateKey; title: string; src: string }
export interface CharacterLoadoutDto { state: CharacterStateKey; outfit: Record<CharacterSlot, string> }
export interface CharacterInventoryDto { userId: string; unlockedItemIds: string[]; loadout: CharacterLoadoutDto; updatedAt: string }
export interface CharacterUnlockEventDto { id: string; userId: string; itemId: string; reason: 'default' | 'purchase' | 'admin' | 'reward' | 'level'; createdAt: string }
export interface CharacterCatalogDto { states: CharacterStateConfigDto[]; items: CharacterItemDto[]; slots: CharacterSlot[]; defaultLoadout: CharacterLoadoutDto }

export interface CreateMatchRequest {
  modeId: GameModeId;
  economyType: PlanType;
  entry?: {
    coinStake?: number;
    useStarterToken?: boolean;
  };
}

export interface CreateMatchResponse {
  matchId: UUID;
  status: MatchPhase;
  configVersion: string;
}

export interface MatchSnapshotDto {
  matchId: UUID;
  modeId: GameModeId;
  phase: MatchPhase;
  round: number;
  timerSeconds?: number;
  players: Array<{
    userId: UUID;
    username: string;
    avatar: string;
    score: number;
    correctAnswers: number;
    wrongAnswers: number;
    eliminated?: boolean;
  }>;
  rewardPreview?: RewardDto;
}

export interface QuestionDto extends Question {
  media?: {
    imageUrl?: string;
    audioUrl?: string;
    alt?: string;
  };
}

export interface SubmitAnswerRequest {
  matchId: UUID;
  questionId: UUID;
  selectedIndex: number;
  answerTimeMs: number;
  idempotencyKey: string;
}

export interface SubmitAnswerResponse {
  correct: boolean;
  selectedIndex: number;
  correctIndex: number;
  score: number;
  phase: MatchPhase;
  events: RealtimeEvent[];
}

export interface RewardDto {
  id?: UUID;
  type: Currency;
  amount: number;
  status?: 'preview' | 'pending' | 'granted' | 'failed';
  animation?: string;
}





export type BetaInviteStatus = 'active' | 'disabled' | 'expired';
export interface BetaInviteDto { code: string; maxUses: number; usedCount: number; status: BetaInviteStatus; note?: string; createdBy: string; createdAt: string; expiresAt?: string }
export interface BetaAccessDto { userId: string; inviteCode: string; grantedAt: string; grantedBy: string }
export interface BetaDiagnosticsDto { required: boolean; activeInvites: number; disabledInvites: number; expiredInvites: number; grantedUsers: number; remainingUses: number }

export type ErrorReportSource = 'frontend' | 'backend' | 'worker' | 'realtime';
export type ErrorReportSeverity = 'info' | 'warn' | 'error' | 'fatal';
export type ErrorReportStatus = 'open' | 'triaged' | 'resolved' | 'ignored';

export interface ErrorReportDto {
  id: UUID;
  userId?: UUID;
  source: ErrorReportSource;
  severity: ErrorReportSeverity;
  status: ErrorReportStatus;
  message: string;
  stack?: string;
  route?: string;
  userAgent?: string;
  appVersion?: string;
  buildId?: string;
  deviceId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface ErrorReportDiagnosticsDto {
  open: number;
  triaged: number;
  resolved: number;
  ignored: number;
  fatal: number;
  frontend: number;
  backend: number;
  last24h: number;
  topMessages: Array<{ message: string; count: number }>;
}

export type PaymentProvider = 'sandbox' | 'zarinpal' | 'stripe' | 'manual';
export type PaymentIntentStatus = 'created' | 'pending' | 'paid' | 'failed' | 'expired';

export interface PaymentIntentDto {
  id: UUID;
  userId: UUID;
  provider: PaymentProvider;
  amount: number;
  currency: 'cash';
  status: PaymentIntentStatus;
  transactionId: UUID;
  paymentUrl: string;
  callbackUrl?: string;
  providerReference?: string;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  paidAt?: string;
  failedAt?: string;
}

export interface PaymentDiagnosticsDto {
  provider: PaymentProvider;
  created: number;
  pending: number;
  paid: number;
  failed: number;
  totalPaidAmount: number;
  pendingAmount: number;
}

export type RewardHoldStatus = 'pending' | 'approved' | 'rejected' | 'released';

export interface RewardHoldDto {
  id: UUID;
  rewardId: UUID;
  userId: UUID;
  matchId: UUID;
  rewardType: Currency;
  amount: number;
  status: RewardHoldStatus;
  riskScore: number;
  riskLevel: RiskLevel;
  reason: string;
  evidence: Record<string, unknown>;
  idempotencyKey: string;
  createdAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  releasedAt?: string;
}

export interface RewardHoldDiagnosticsDto {
  pending: number;
  approved: number;
  rejected: number;
  released: number;
  totalHeldAmount: number;
  pendingAmount: number;
}

export interface ClaimRewardRequest {
  rewardId: UUID;
}

export interface ClaimRewardResponse {
  claimed: boolean;
  reward: RewardDto;
  balances: UserDto['balances'];
}

export interface WalletDto {
  wallet: number;
  coins: number;
  hearts: number;
  tickets: UserDto['balances']['tickets'];
  transactions: TransactionDto[];
}

export interface TransactionDto {
  id: UUID;
  type: string;
  currency: Currency;
  amount: number;
  direction: 'in' | 'out';
  status: 'ok' | 'pending' | 'paid' | 'failed';
  createdAt: string;
  reference?: string;
}

export interface FriendDto {
  id: UUID;
  username: string;
  displayName: string;
  avatar: string;
  online: boolean;
  status: string;
  unread: number;
}

export type SupportTicketStatus = 'open' | 'answered' | 'closed' | 'escalated';
export type SupportTicketPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface SupportTicketDto {
  id: string;
  userId?: string;
  title: string;
  category: string;
  body: string;
  status: SupportTicketStatus;
  priority?: SupportTicketPriority;
  reply?: string;
  linkedMatchId?: string;
  linkedTransactionId?: string;
  linkedRewardHoldId?: string;
  assignedAdminId?: string;
  createdAt: string;
  updatedAt?: string;
  closedAt?: string;
}

export interface SupportMessageDto {
  id: string;
  ticketId: string;
  senderId: string;
  senderRole: 'user' | 'admin' | 'system';
  body: string;
  createdAt: string;
}

export interface SupportDiagnosticsDto {
  open: number;
  answered: number;
  escalated: number;
  closed: number;
  urgent: number;
  unassigned: number;
}





export type DeviceTrustStatus = 'new' | 'trusted' | 'limited' | 'revoked';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface DeviceRecordDto {
  id: UUID;
  fingerprintHash: string;
  clientDeviceId?: string;
  userAgent?: string;
  platform?: string;
  firstIpAddress?: string;
  lastIpAddress?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  trustStatus: DeviceTrustStatus;
  revokedAt?: string;
}

export interface DeviceBindingDto {
  id: UUID;
  userId: UUID;
  deviceId: UUID;
  firstSeenAt: string;
  lastSeenAt: string;
  lastIpAddress?: string;
  trustStatus: DeviceTrustStatus;
  riskScore: number;
  device?: DeviceRecordDto;
  sharedUsers?: number;
}

export interface UserRiskProfileDto {
  userId: UUID;
  riskScore: number;
  riskLevel: RiskLevel;
  reasons: string[];
  deviceCount: number;
  sharedDeviceCount: number;
  integritySignalCount: number;
  updatedAt: string;
}

export interface DeviceDiagnosticsDto {
  devices: number;
  bindings: number;
  sharedDevices: number;
  highRiskUsers: number;
  criticalRiskUsers: number;
  topRiskUsers: UserRiskProfileDto[];
}

export type IntegritySignalType = 'IMPOSSIBLE_ANSWER_TIME' | 'FAST_CORRECT_ANSWER' | 'ANSWER_BURST' | 'IDEMPOTENCY_REPLAY' | 'REPEATED_QUESTION_ANSWER' | 'PERFECT_FAST_MATCH' | 'SCORE_ANOMALY';
export type IntegritySeverity = 'info' | 'warn' | 'critical';
export type IntegrityStatus = 'open' | 'reviewing' | 'dismissed' | 'confirmed';

export interface IntegritySignalDto {
  id: UUID;
  matchId: UUID;
  userId: UUID;
  questionId?: UUID;
  type: IntegritySignalType;
  severity: IntegritySeverity;
  riskScore: number;
  status: IntegrityStatus;
  evidence: Record<string, unknown>;
  createdAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
}

export interface IntegrityDiagnosticsDto {
  totalSignals: number;
  openSignals: number;
  criticalSignals: number;
  reviewingSignals: number;
  confirmedSignals: number;
  dismissedSignals: number;
  avgRiskScore: number;
  topSignalTypes: Array<{ type: IntegritySignalType; count: number }>;
  topRiskUsers: Array<{ userId: string; riskScore: number; signals: number }>;
}

export type NotificationType = 'match_update' | 'leaderboard_update' | 'wallet_update' | 'system' | 'promo';

export interface PushSubscriptionDto {
  id: UUID;
  userId: UUID;
  endpoint: string;
  deviceLabel?: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface NotificationPreferencesDto {
  userId: UUID;
  matchUpdates: boolean;
  leaderboardUpdates: boolean;
  walletUpdates: boolean;
  promos: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  updatedAt: string;
}

export interface NotificationDto {
  id: UUID;
  userId: UUID;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown>;
  channel: 'in_app' | 'push';
  status: 'queued' | 'sent' | 'failed' | 'read';
  createdAt: string;
  sentAt?: string;
  readAt?: string;
  error?: string;
}

export interface NotificationDiagnosticsDto {
  provider: 'log' | 'webpush';
  vapidConfigured: boolean;
  subscriptions: number;
  queued: number;
  sent: number;
  failed: number;
  unread: number;
}



export interface MigrationStatusDto {
  version: string;
  applied: boolean;
  appliedAt?: string;
}

export interface DatabaseVerificationDto {
  ok: boolean;
  checkedAt: string;
  migrations: {
    configured: boolean;
    pending: number;
    applied: number;
    total: number;
    rows: MigrationStatusDto[];
  };
  tables: Array<{ table: string; ok: boolean; detail?: string }>;
  indexes: Array<{ index: string; ok: boolean; detail?: string }>;
}

export interface FinanceDiagnosticsDto {
  totalTopups: number;
  totalWithdrawRequests: number;
  pendingWithdrawAmount: number;
  paidWithdrawAmount: number;
  failedWithdrawAmount: number;
  totalRewardsPaid: number;
  pendingRewardHoldAmount: number;
  netCashFlow: number;
  pendingWithdrawCount: number;
}


export interface AdminUserDto {
  id: UUID;
  phone: string;
  username: string;
  displayName: string;
  plan: PlanType | string;
  role: 'user' | 'admin';
  status: 'active' | 'limited' | 'banned';
  level: number;
  xp: number;
  weeklyScore: number;
  wallet: number;
  coins: number;
  hearts: number;
  riskScore?: number;
  riskLevel?: string;
}

export interface AdminUserOverviewDto {
  user: AdminUserDto;
  balances: UserDto['balances'];
  transactions: TransactionDto[];
  devices: DeviceBindingDto[];
  riskProfile?: UserRiskProfileDto;
  tickets: SupportTicketDto[];
  integritySignals: IntegritySignalDto[];
  rewardHolds: RewardHoldDto[];
}

export interface AdminAnalyticsDto {
  matches: number;
  questions: number;
  transactions: number;
  rewards: number;
  activeUsersEstimate: number;
}


export interface AdminFeatureFlagDto {
  key: string;
  enabled: boolean;
  description: string;
}

export interface AdminThemeDto {
  id: string;
  name: string;
  primary: string;
  accent: string;
  enabled: boolean;
}

export interface AdminAuditLogDto {
  id: string;
  adminId: string;
  action: string;
  targetType: string;
  targetId?: string;
  diff: Record<string, unknown>;
  createdAt: string;
}

export interface RealtimeEvent<TPayload = Record<string, unknown>> {
  id: string;
  type: string;
  matchId?: UUID;
  requestId?: string;
  payload: TPayload;
  createdAt: string;
}
