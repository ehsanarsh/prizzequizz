import type { AnswerSubmission, BetaAccess, BetaInvite, BetaInviteStatus, CharacterInventory, CharacterItem, CharacterItemStatus, CharacterUnlockEvent, DeviceRecord, DeviceTrustStatus, ErrorReport, ErrorReportStatus, IntegritySignal, IntegrityStatus, Match, MatchEvent, NotificationPreferences, NotificationRecord, PaymentIntent, PaymentIntentStatus, PushSubscriptionRecord, Question, Reward, RewardHold, RewardHoldStatus, SupportMessage, SupportTicket, SupportTicketStatus, Transaction, User, UserDeviceBinding, UserRiskProfile } from '../types/domain.js';



export interface BetaRepository {
  saveInvite(invite: BetaInvite): Promise<void>;
  findInvite(code: string): Promise<BetaInvite | null>;
  listInvites(limit?: number): Promise<BetaInvite[]>;
  updateInviteStatus(code: string, status: BetaInviteStatus): Promise<BetaInvite | null>;
  saveAccess(access: BetaAccess): Promise<void>;
  findAccess(userId: string): Promise<BetaAccess | null>;
  listAccess(limit?: number): Promise<BetaAccess[]>;
}

export interface CharacterRepository {
  listItems(status?: CharacterItemStatus): Promise<CharacterItem[]>;
  findItemById(id: string): Promise<CharacterItem | null>;
  saveItem(item: CharacterItem): Promise<void>;
  updateItemStatus(id: string, status: CharacterItemStatus): Promise<CharacterItem | null>;
  getInventory(userId: string): Promise<CharacterInventory | null>;
  saveInventory(inventory: CharacterInventory): Promise<void>;
  appendUnlockEvent(event: CharacterUnlockEvent): Promise<void>;
  listUnlockEvents(userId: string, limit?: number): Promise<CharacterUnlockEvent[]>;
}

export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByPhone(phone: string): Promise<User | null>;
  list(limit?: number): Promise<User[]>;
  save(user: User): Promise<void>;
  /** Persist ONLY the lifeline inventory (kept separate from save() so the main
   *  user write never clobbers it). */
  updateLifelines(userId: string, lifelines: Record<string, number>): Promise<void>;
  /** Remove an account for good. Callers are responsible for checking there is
   *  no money left on it first — see the admin delete route. */
  remove(id: string): Promise<void>;
}

export interface QuestionRepository {
  findById(id: string): Promise<Question | null>;
  listApproved(): Promise<Question[]>;
  listAll(status?: string): Promise<Question[]>;
  save(question: Question): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface MatchRepository {
  findById(id: string): Promise<Match | null>;
  save(match: Match): Promise<void>;
}

export interface AnswerRepository {
  findByIdempotencyKey(key: string): Promise<AnswerSubmission | null>;
  listByMatch(matchId: string): Promise<AnswerSubmission[]>;
  listByUser(userId: string, limit?: number): Promise<AnswerSubmission[]>;
  save(answer: AnswerSubmission): Promise<void>;
}

export interface RewardRecord extends Reward {
  userId: string;
  matchId: string;
  idempotencyKey: string;
}

export interface RewardRepository {
  findByIdempotencyKey(key: string): Promise<RewardRecord | null>;
  save(reward: RewardRecord): Promise<void>;
}



export interface SupportTicketFilter {
  userId?: string;
  status?: SupportTicketStatus;
  category?: string;
  priority?: SupportTicket['priority'];
  assignedAdminId?: string;
  limit?: number;
}

export interface SupportRepository {
  saveTicket(ticket: SupportTicket): Promise<void>;
  findTicketById(id: string): Promise<SupportTicket | null>;
  listTickets(filter?: SupportTicketFilter): Promise<SupportTicket[]>;
  updateTicket(id: string, patch: Partial<SupportTicket>): Promise<SupportTicket | null>;
  appendMessage(message: SupportMessage): Promise<void>;
  listMessages(ticketId: string): Promise<SupportMessage[]>;
}

export interface RewardHoldFilter {
  userId?: string;
  matchId?: string;
  status?: RewardHoldStatus;
  limit?: number;
}

export interface RewardHoldRepository {
  save(hold: RewardHold): Promise<void>;
  findById(id: string): Promise<RewardHold | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<RewardHold | null>;
  list(filter?: RewardHoldFilter): Promise<RewardHold[]>;
  updateStatus(id: string, status: RewardHoldStatus, reviewedBy: string, extra?: Partial<RewardHold>): Promise<RewardHold | null>;
}

export interface LeaderboardScoreRow {
  userId: string;
  score: number;
}

export interface TransactionFilter {
  userId?: string;
  type?: string;
  direction?: Transaction['direction'];
  status?: Transaction['status'];
  currency?: Transaction['currency'];
  limit?: number;
}

export interface TransactionRepository {
  findById(id: string): Promise<Transaction | null>;
  list(filter?: TransactionFilter): Promise<Transaction[]>;
  listByUser(userId: string): Promise<Transaction[]>;
  listWinnings(limit?: number): Promise<LeaderboardScoreRow[]>;
  /** Cash/coins won since the start of the current ISO week — resets with the cup. */
  listWeeklyWinnings(limit?: number): Promise<LeaderboardScoreRow[]>;
  save(transaction: Transaction): Promise<void>;
  updateStatus(id: string, status: Transaction['status'], reference?: string): Promise<Transaction | null>;
}

export interface MatchEventRepository {
  append(event: MatchEvent): Promise<void>;
  listByMatch(matchId: string): Promise<MatchEvent[]>;
}




export interface DeviceRepository {
  findById(id: string): Promise<DeviceRecord | null>;
  findByFingerprintHash(fingerprintHash: string): Promise<DeviceRecord | null>;
  saveDevice(device: DeviceRecord): Promise<void>;
  listDevices(limit?: number): Promise<DeviceRecord[]>;
  findBinding(userId: string, deviceId: string): Promise<UserDeviceBinding | null>;
  saveBinding(binding: UserDeviceBinding): Promise<void>;
  listBindingsByUser(userId: string): Promise<UserDeviceBinding[]>;
  listBindingsByDevice(deviceId: string): Promise<UserDeviceBinding[]>;
  updateBindingStatus(bindingId: string, status: DeviceTrustStatus): Promise<UserDeviceBinding | null>;
  getRiskProfile(userId: string): Promise<UserRiskProfile | null>;
  saveRiskProfile(profile: UserRiskProfile): Promise<void>;
  listRiskProfiles(limit?: number): Promise<UserRiskProfile[]>;
}

export interface IntegritySignalFilter {
  userId?: string;
  matchId?: string;
  status?: IntegrityStatus;
  severity?: IntegritySignal['severity'];
  limit?: number;
}

export interface IntegrityRepository {
  save(signal: IntegritySignal): Promise<void>;
  list(filter?: IntegritySignalFilter): Promise<IntegritySignal[]>;
  findById(id: string): Promise<IntegritySignal | null>;
  updateStatus(id: string, status: IntegrityStatus, reviewedBy: string): Promise<IntegritySignal | null>;
}



export interface ErrorReportFilter {
  source?: ErrorReport['source'];
  severity?: ErrorReport['severity'];
  status?: ErrorReportStatus;
  userId?: string;
  limit?: number;
}

export interface ErrorReportRepository {
  save(report: ErrorReport): Promise<void>;
  findById(id: string): Promise<ErrorReport | null>;
  list(filter?: ErrorReportFilter): Promise<ErrorReport[]>;
  updateStatus(id: string, status: ErrorReportStatus, resolvedBy: string): Promise<ErrorReport | null>;
}

export interface PaymentIntentFilter {
  userId?: string;
  status?: PaymentIntentStatus;
  provider?: PaymentIntent['provider'];
  limit?: number;
}

export interface PaymentRepository {
  save(intent: PaymentIntent): Promise<void>;
  findById(id: string): Promise<PaymentIntent | null>;
  findByIdempotencyKey(key: string): Promise<PaymentIntent | null>;
  list(filter?: PaymentIntentFilter): Promise<PaymentIntent[]>;
  updateStatus(id: string, status: PaymentIntentStatus, patch?: Partial<PaymentIntent>): Promise<PaymentIntent | null>;
}

export interface NotificationRepository {
  listSubscriptions(userId: string): Promise<PushSubscriptionRecord[]>;
  saveSubscription(subscription: PushSubscriptionRecord): Promise<void>;
  revokeSubscription(subscriptionId: string, userId: string): Promise<boolean>;
  getPreferences(userId: string): Promise<NotificationPreferences | null>;
  savePreferences(preferences: NotificationPreferences): Promise<void>;
  listNotifications(userId: string, limit?: number): Promise<NotificationRecord[]>;
  saveNotification(notification: NotificationRecord): Promise<void>;
  markRead(notificationId: string, userId: string): Promise<boolean>;
  markAllRead(userId: string): Promise<number>;
}

export interface RepositoryBundle {
  beta: BetaRepository;
  characters: CharacterRepository;
  users: UserRepository;
  questions: QuestionRepository;
  matches: MatchRepository;
  answers: AnswerRepository;
  rewards: RewardRepository;
  rewardHolds: RewardHoldRepository;
  support: SupportRepository;
  transactions: TransactionRepository;
  matchEvents: MatchEventRepository;
  devices: DeviceRepository;
  integrity: IntegrityRepository;
  errorReports: ErrorReportRepository;
  payments: PaymentRepository;
  notifications: NotificationRepository;
}
