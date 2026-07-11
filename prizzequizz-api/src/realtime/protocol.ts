export type ClientRealtimeType =
  | 'client:ping'
  | 'client:join_match'
  | 'client:leave_match'
  | 'client:submit_answer'
  | 'client:send_chat'
  | 'client:subscribe_leaderboard'
  | 'client:unsubscribe_leaderboard';

export type ServerRealtimeType =
  | 'server:connected'
  | 'server:pong'
  | 'server:match_snapshot'
  | 'server:answer_result'
  | 'server:match_finished'
  | 'server:opponent_left'
  | 'server:chat'
  | 'server:presence'
  | 'server:leaderboard_update'
  | 'server:error';

export interface ClientRealtimeMessage<T = Record<string, unknown>> {
  type: ClientRealtimeType;
  payload?: T;
  requestId?: string;
}

export interface ServerRealtimeMessage<T = Record<string, unknown>> {
  id: string;
  type: ServerRealtimeType;
  payload: T;
  matchId?: string;
  requestId?: string;
  createdAt: string;
}

export interface RealtimeClientMeta {
  id: string;
  userId: string;
  matchId?: string;
  connectedAt: string;
  lastSeenAt: string;
}
