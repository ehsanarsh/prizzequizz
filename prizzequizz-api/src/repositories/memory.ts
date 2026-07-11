import type { AdminLog, SecurityEvent, AnswerSubmission, BetaAccess, BetaInvite, CharacterInventory, CharacterItem, CharacterUnlockEvent, DeviceRecord, ErrorReport, IntegritySignal, Match, MatchEvent, NotificationPreferences, NotificationRecord, PaymentIntent, PushSubscriptionRecord, Question, Reward, RewardHold, SupportMessage, SupportTicket, Transaction, User, UserDeviceBinding, UserRiskProfile } from '../types/domain.js';
import { id } from '../utils/id.js';

export const db = {
  betaInvites: new Map<string, BetaInvite>(),
  betaAccess: new Map<string, BetaAccess>(),
  characterItems: new Map<string, CharacterItem>(),
  characterInventories: new Map<string, CharacterInventory>(),
  characterUnlockEvents: new Map<string, CharacterUnlockEvent>(),
  users: new Map<string, User>(),
  matches: new Map<string, Match>(),
  questions: new Map<string, Question>(),
  transactions: new Map<string, Transaction>(),
  answers: new Map<string, AnswerSubmission>(),
  rewards: new Map<string, Reward & { userId: string; matchId: string; idempotencyKey: string }>(),
  rewardHolds: new Map<string, RewardHold>(),
  supportTickets: new Map<string, SupportTicket>(),
  supportMessages: new Map<string, SupportMessage>(),
  matchEvents: new Map<string, MatchEvent>(),
  adminLogs: new Map<string, AdminLog>(),
  securityEvents: new Map<string, SecurityEvent>(),
  integritySignals: new Map<string, IntegritySignal>(),
  errorReports: new Map<string, ErrorReport>(),
  devices: new Map<string, DeviceRecord>(),
  userDeviceBindings: new Map<string, UserDeviceBinding>(),
  userRiskProfiles: new Map<string, UserRiskProfile>(),
  paymentIntents: new Map<string, PaymentIntent>(),
  pushSubscriptions: new Map<string, PushSubscriptionRecord>(),
  notificationPreferences: new Map<string, NotificationPreferences>(),
  notifications: new Map<string, NotificationRecord>()
};

export function seedMemory(): void {
  if (db.users.size) return;
  const user: User = { id: 'u1', phone: '+989120000000', username: 'Shahab_9865', displayName: 'شهاب', plan: 'free', level: 3, xp: 3400, weeklyScore: 820, wallet: 900000, coins: 350, hearts: 3, tickets: { bronze: 1, silver: 0, gold: 0 } };
  db.users.set(user.id, user);
  const user2: User = { id: 'u2', phone: '+989130000000', username: 'RezaFast', displayName: 'رضا', plan: 'free', level: 4, xp: 4100, weeklyScore: 760, wallet: 500000, coins: 420, hearts: 4, tickets: { bronze: 1, silver: 0, gold: 0 } };
  db.users.set(user2.id, user2);
  const questions: Question[] = [
    { id: 'q1', category: 'عمومی', difficulty: 'easy', text: 'یک هفته چند روز است؟', options: ['۵ روز', '۶ روز', '۷ روز', '۸ روز'], correctIndex: 2, tags: ['easy'], status: 'approved', version: 1 },
    { id: 'q2', category: 'جغرافیا', difficulty: 'easy', text: 'پایتخت فرانسه کدام است؟', options: ['رم', 'مادرید', 'پاریس', 'لندن'], correctIndex: 2, tags: ['geo'], status: 'approved', version: 1 },
    { id: 'q3', category: 'علوم', difficulty: 'easy', text: 'فرمول شیمیایی آب چیست؟', options: ['CO2', 'H2O', 'O2', 'NaCl'], correctIndex: 1, tags: ['science'], status: 'approved', version: 1 }
  ];
  questions.forEach((q) => db.questions.set(q.id, q));
  db.transactions.set('t1', { id: 't1', userId: user.id, type: 'seed', currency: 'coins', amount: 350, direction: 'in', status: 'ok', reference: id(), createdAt: new Date().toISOString() });
}
