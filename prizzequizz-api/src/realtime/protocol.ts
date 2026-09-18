export type ClientRealtimeType =
  | 'client:ping'
  | 'client:join_match'
  | 'client:leave_match'
  | 'client:submit_answer'
  | 'client:send_chat'
  | 'client:subscribe_leaderboard'
  | 'client:unsubscribe_leaderboard'
  | 'client:join_ls_room'
  | 'client:leave_ls_room';

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
  /* «کسی الان چیزی برایت فرستاد» — and nothing more. The payload says what
     KIND of thing arrived, never the thing itself: the client then reads it
     through the same endpoint it always used, so there is exactly one place
     that decides what an invite looks like. A push that carried the invite
     would be a second one. */
  | 'server:nudge'
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
