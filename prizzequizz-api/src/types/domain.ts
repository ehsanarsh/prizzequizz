export type UUID = string;
export type PlanType = 'free' | 'paid';
export type GameModeId = 'duel' | 'lastSurvivor' | 'allOrNothing' | 'weeklyLeague';
export type MatchPhase = 'created' | 'matchmaking' | 'starting' | 'question' | 'revealing' | 'result' | 'finished';
export type RewardType = 'coins' | 'cash' | 'xp' | 'heart' | 'ticket' | 'item';

export type UserStatus = 'active' | 'limited' | 'banned';

export interface User {
  id: UUID;
  phone: string;
  username: string;
  displayName: string;
  plan: PlanType;
  role?: 'user' | 'admin';
  status?: UserStatus;
  banReason?: string;
  bannedAt?: string;
  level: number;
  xp: number;
  /** Cup earned in `weeklyWeek`. Stale once the ISO week rolls over — always read
   *  it through effectiveWeeklyScore(), never raw. */
  weeklyScore: number;
  weeklyWeek?: string;
  wallet: number;
  coins: number;
  hearts: number;
  tickets: { bronze: number; silver: number; gold: number };
  /** Persistent lifeline (کمکی) inventory: 50:50 / Second-Chance / Audience-Poll. */
  lifelines?: { p5050: number; psecond: number; pstats: number };
}

export interface Question {
  id: UUID;
  category: string;
  difficulty: 'easy' | 'medium' | 'hard' | 'veryhard';
  text: string;
  options: string[];
  correctIndex: number;
  tags: string[];
  status: 'approved' | 'pending' | 'rejected' | 'archived';
  version: number;
}

export interface MatchPlayer {
  userId: UUID;
  username: string;
  avatar: string;
  score: number;
  correctAnswers: number;
  wrongAnswers: number;
  eliminated?: boolean;
}

export interface Match {
  id: UUID;
  modeId: GameModeId;
  economyType: PlanType;
  phase: MatchPhase;
  round: number;
  configVersion: string;
  players: MatchPlayer[];
  currentQuestionId?: UUID;
  winnerUserId?: UUID;
  rewardPreview?: Reward;
  /** Real duel answers keyed by `${userId}:${round}` — used for per-player,
   *  round-based scoring in synchronous 2-player duels (no bot/random scoring). */
  duelAnswers?: Record<string, { selectedIndex: number; correct: boolean }>;
  /** Set to true once the finish/reward side-effects have run, so they run once. */
  duelSettled?: boolean;
  /** Server-authoritative XP/🏆cup scoring accumulated during the match (keyed by
   *  userId), the current correct-streak per player, and which player answered a
   *  given round first (for the speed bonus). Applied to the users at finish. */
  duelPoints?: Record<string, { xp: number; cup: number }>;
  duelStreak?: Record<string, number>;
  duelFirstCorrect?: Record<string, string>;
  /** Final XP/cup awarded to each player at finish, exposed to the client so it
   *  can show the breakdown (+XP / +🏆) and the new level. */
  duelPointsFinal?: Record<string, { xp: number; cup: number; result: string; totalXp: number; totalCup: number; level: number }>;
  /** Category chosen by the toss winner. The server is the single source of
   *  truth: the winner POSTs it, the loser reads it, and both fetch questions
   *  filtered by it — no client-to-client rebroadcast. */
  duelTopic?: string;
  /** Per-half chosen topics for the two-half (نیمه اول/دوم) structure. Key is the
   *  half number as a string ("1" | "2"). duelTopic mirrors half 1 for back-compat.
   *  The half-2 picker (the toss loser) stores "2"; the waiting player polls it. */
  duelTopics?: Record<string, string>;
  /** Speed-round (toss) submissions keyed by userId (with the toss round they
   *  belong to), and the resolved winner. The server decides the winner. If BOTH
   *  players answer the toss wrong, nobody wins: duelTossRound is bumped and a
   *  fresh toss question is shown until at least one answers correctly. */
  duelToss?: Record<string, { correct: boolean; timeMs: number; round: number }>;
  duelTossWinner?: string;
  duelTossRound?: number;
  /** Per-player highest round reached — used as a start barrier so both players
   *  enter the first question at the same time (no 5–10s head start). */
  duelReady?: Record<string, number>;
  /** Rematch handshake between the same two players: one requests, the other
   *  accepts/rejects; on accept the server creates a fresh match and both sides
   *  read `newMatchId` here to enter it. */
  rematch?: { by: string; status: 'pending' | 'accepted' | 'rejected'; newMatchId?: string; at: string };
  createdAt: string;
  updatedAt: string;
}

export interface Reward {
  id?: UUID;
  type: RewardType;
  amount: number;
  status?: 'preview' | 'pending' | 'granted' | 'failed';
  animation?: string;
}


export interface AnswerSubmission {
  id: UUID;
  matchId: UUID;
  userId: UUID;
  questionId: UUID;
  selectedIndex: number;
  correct: boolean;
  answerTimeMs: number;
  idempotencyKey: string;
  createdAt: string;
}

export interface MatchEvent {
  id: string;
  matchId: UUID;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface Transaction {
  id: UUID;
  userId: UUID;
  type: string;
  currency: RewardType;
  amount: number;
  direction: 'in' | 'out';
  status: 'ok' | 'pending' | 'paid' | 'failed';
  reference?: string;
  createdAt: string;
}





export type DeviceTrustStatus = 'new' | 'trusted' | 'limited' | 'revoked';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface DeviceRecord {
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

export interface UserDeviceBinding {
  id: UUID;
  userId: UUID;
  deviceId: UUID;
  firstSeenAt: string;
  lastSeenAt: string;
  lastIpAddress?: string;
  trustStatus: DeviceTrustStatus;
  riskScore: number;
}

export interface UserRiskProfile {
  userId: UUID;
  riskScore: number;
  riskLevel: RiskLevel;
  reasons: string[];
  deviceCount: number;
  sharedDeviceCount: number;
  integritySignalCount: number;
  updatedAt: string;
}

export type IntegritySignalType =
  | 'IMPOSSIBLE_ANSWER_TIME'
  | 'FAST_CORRECT_ANSWER'
  | 'ANSWER_BURST'
  | 'IDEMPOTENCY_REPLAY'
  | 'REPEATED_QUESTION_ANSWER'
  | 'PERFECT_FAST_MATCH'
  | 'SCORE_ANOMALY';
export type IntegritySeverity = 'info' | 'warn' | 'critical';
export type IntegrityStatus = 'open' | 'reviewing' | 'dismissed' | 'confirmed';

export interface IntegritySignal {
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
  reviewedBy?: UUID | 'system';
}

export type NotificationType = 'match_update' | 'leaderboard_update' | 'wallet_update' | 'system' | 'promo';
export type NotificationChannel = 'in_app' | 'push';
export type NotificationStatus = 'queued' | 'sent' | 'failed' | 'read';

export interface PushSubscriptionRecord {
  id: UUID;
  userId: UUID;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
  deviceLabel?: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  revokedAt?: string;
}

export interface NotificationPreferences {
  userId: UUID;
  matchUpdates: boolean;
  leaderboardUpdates: boolean;
  walletUpdates: boolean;
  promos: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  updatedAt: string;
}

export interface NotificationRecord {
  id: UUID;
  userId: UUID;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown>;
  channel: NotificationChannel;
  status: NotificationStatus;
  createdAt: string;
  sentAt?: string;
  readAt?: string;
  error?: string;
}







export type BetaInviteStatus = 'active' | 'disabled' | 'expired';

export interface BetaInvite {
  code: string;
  maxUses: number;
  usedCount: number;
  status: BetaInviteStatus;
  note?: string;
  createdBy: UUID | 'system';
  createdAt: string;
  expiresAt?: string;
}

export interface BetaAccess {
  userId: UUID;
  inviteCode: string;
  grantedAt: string;
  grantedBy: UUID | 'system';
}

export type ErrorReportSource = 'frontend' | 'backend' | 'worker' | 'realtime';
export type ErrorReportSeverity = 'info' | 'warn' | 'error' | 'fatal';
export type ErrorReportStatus = 'open' | 'triaged' | 'resolved' | 'ignored';

export interface ErrorReport {
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
  resolvedBy?: UUID | 'system';
}

export type PaymentProvider = 'sandbox' | 'zarinpal' | 'stripe' | 'manual';
export type PaymentIntentStatus = 'created' | 'pending' | 'paid' | 'failed' | 'expired';

export interface PaymentIntent {
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

export type CharacterSlot = 'head' | 'body' | 'shoes';
export type CharacterStateKey = 'idle' | 'happy' | 'sad' | 'win' | 'lose';
export type CharacterRarity = 'common' | 'rare' | 'epic' | 'legendary';
export type CharacterItemStatus = 'active' | 'draft' | 'archived';

export interface CharacterItem {
  id: string;
  slot: CharacterSlot;
  title: string;
  src: string;
  rarity: CharacterRarity;
  priceCoins: number;
  unlockLevel?: number;
  tags: string[];
  status: CharacterItemStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterLoadout {
  state: CharacterStateKey;
  outfit: Record<CharacterSlot, string>;
}

export interface CharacterInventory {
  userId: UUID;
  unlockedItemIds: string[];
  loadout: CharacterLoadout;
  updatedAt: string;
}

export interface CharacterUnlockEvent {
  id: UUID;
  userId: UUID;
  itemId: string;
  reason: 'default' | 'purchase' | 'admin' | 'reward' | 'level';
  createdAt: string;
}

export type SupportTicketStatus = 'open' | 'answered' | 'closed' | 'escalated';
export type SupportTicketPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface SupportTicket {
  id: UUID;
  userId: UUID;
  title: string;
  category: string;
  body: string;
  status: SupportTicketStatus;
  priority: SupportTicketPriority;
  reply?: string;
  linkedMatchId?: UUID;
  linkedTransactionId?: UUID;
  linkedRewardHoldId?: UUID;
  assignedAdminId?: UUID | 'system';
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface SupportMessage {
  id: UUID;
  ticketId: UUID;
  senderId: UUID | 'system';
  senderRole: 'user' | 'admin' | 'system';
  body: string;
  createdAt: string;
}

export type RewardHoldStatus = 'pending' | 'approved' | 'rejected' | 'released';

export interface RewardHold {
  id: UUID;
  rewardId: UUID;
  userId: UUID;
  matchId: UUID;
  rewardType: RewardType;
  amount: number;
  status: RewardHoldStatus;
  riskScore: number;
  riskLevel: RiskLevel;
  reason: string;
  evidence: Record<string, unknown>;
  idempotencyKey: string;
  createdAt: string;
  reviewedAt?: string;
  reviewedBy?: UUID | 'system';
  releasedAt?: string;
}

export interface AdminLog {
  id: UUID;
  adminId: UUID | 'system';
  action: string;
  targetType: string;
  targetId?: string;
  diff: Record<string, unknown>;
  createdAt: string;
}


export interface SecurityEvent {
  id: UUID;
  userId?: UUID;
  eventType: string;
  severity: 'info' | 'warn' | 'critical';
  ipAddress?: string;
  userAgent?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}
