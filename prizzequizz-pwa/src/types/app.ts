export type PlanType = 'free' | 'paid';
export type ScreenId = 'splash' | 'login' | 'home' | 'mode-entry' | 'matchmaking' | 'duel' | 'result' | 'wallet' | 'missions' | 'friends' | 'support' | 'rankings' | 'settings' | 'character' | 'admin';
export type GameModeId = 'duel' | 'lastSurvivor' | 'allOrNothing' | 'weeklyLeague';

export interface UserState {
  id: string;
  username: string;
  displayName: string;
  level: number;
  xp: number;
  weeklyScore: number;
  plan: PlanType;
}

export interface EconomyState {
  wallet: number;
  coins: number;
  hearts: number;
  heartLastAt?: number;
  coinStake?: number;
  tickets: { bronze: number; silver: number; gold: number };
}

export interface Question {
  id: string;
  category: string;
  difficulty: 'easy' | 'medium' | 'hard';
  text: string;
  options: string[];
  correctIndex: number;
}

export interface DuelState {
  stage: number;
  round: number;
  myScore: number;
  opponentScore: number;
  myResults: Array<'ok' | 'no'>;
  opponentResults: Array<'ok' | 'no'>;
  opponent: { id: string; name: string; avatar: string };
  currentQuestion?: Question;
  selectedIndex?: number;
  correctIndex?: number;
  hiddenOptions: number[];
  statsVisible: boolean;
  timerLeft: number;
  powerups: {
    fifty: number;
    time: number;
    stats: number;
  };
}


export interface MatchmakingState {
  ticketId?: string;
  status?: 'queued' | 'matched' | 'cancelled' | 'expired';
  quality?: 'excellent' | 'good' | 'wide' | 'bot';
  opponentIsBot?: boolean;
  waitMs?: number;
}

export interface MatchState {
  mode?: GameModeId;
  phase: 'idle' | 'matchmaking' | 'question' | 'revealing' | 'result';
  duel: DuelState;
  matchmaking?: MatchmakingState;
}


export interface RealtimePresenceUser {
  userId: string;
  lastSeenAt: string;
}

export interface DuelChatMessage {
  id?: string;
  from: 'me' | 'opponent' | 'system';
  text: string;
  time: string;
  pending?: boolean;
}

export interface RealtimeUIState {
  connected: boolean;
  reconnecting: boolean;
  presence: RealtimePresenceUser[];
  duelChat: DuelChatMessage[];
  lastRecoveredAt?: string;
}

export interface UIState {
  currentScreen: ScreenId;
  previousScreen?: ScreenId;
  theme: PlanType;
  modal?: string;
  loading: Record<string, boolean>;
  errors: Record<string, string | null>;
  lastFailedAction?: string | null;
  online?: boolean;
  realtime: RealtimeUIState;
}

export interface AppState {
  user: UserState;
  economy: EconomyState;
  match: MatchState;
  ui: UIState;
}
