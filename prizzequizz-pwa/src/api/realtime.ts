import type { RealtimeEvent } from './contracts';

type RealtimeHandler = (event: RealtimeEvent) => void;

export interface RealtimeClient {
  connect(): void;
  disconnect(): void;
  send(type: string, payload: Record<string, unknown>, requestId?: string): void;
  on(handler: RealtimeHandler): () => void;
  isConnected(): boolean;
}

export class MockRealtimeClient implements RealtimeClient {
  private handlers = new Set<RealtimeHandler>();
  private connected = false;

  connect(): void {
    if (this.connected) return;
    this.connected = true;
    this.emit('server:connected', { mock: true });
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.emit('server:disconnected', { mock: true });
  }

  isConnected(): boolean {
    return this.connected;
  }

  send(type: string, payload: Record<string, unknown>, requestId?: string): void {
    if (!this.connected) return;
    if (type === 'client:ping') this.emit('server:pong', { t: Date.now() }, requestId);
    else if (type === 'client:join_match') this.emit('server:match_snapshot', { matchId: payload.matchId, players: [] }, requestId);
    else if (type === 'client:send_chat') this.emit('server:chat', payload, requestId);
    else this.emit(type.replace('client:', 'server:ack_'), payload, requestId);
  }

  on(handler: RealtimeHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(type: string, payload: Record<string, unknown>, requestId?: string): void {
    const event: RealtimeEvent = { id: `${Date.now()}_${Math.random()}`, type, payload, requestId, createdAt: new Date().toISOString() } as RealtimeEvent;
    this.handlers.forEach((handler) => handler(event));
  }
}

export class WebSocketRealtimeClient implements RealtimeClient {
  private socket: WebSocket | null = null;
  private handlers = new Set<RealtimeHandler>();
  private queue: Array<{ type: string; payload: Record<string, unknown>; requestId?: string }> = [];
  private connected = false;
  private manuallyClosed = false;

  constructor(private readonly urlFactory: () => string) {}

  connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    this.manuallyClosed = false;
    const socket = new WebSocket(this.urlFactory());
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.connected = true;
      this.flush();
    });

    socket.addEventListener('message', (message) => {
      try {
        const parsed = JSON.parse(String(message.data)) as RealtimeEvent;
        this.handlers.forEach((handler) => handler(parsed));
      } catch {
        this.handlers.forEach((handler) => handler({ id: `${Date.now()}`, type: 'server:error', payload: { code: 'INVALID_REALTIME_MESSAGE' }, createdAt: new Date().toISOString() }));
      }
    });

    socket.addEventListener('close', () => {
      this.connected = false;
      this.handlers.forEach((handler) => handler({ id: `${Date.now()}`, type: 'server:disconnected', payload: { manual: this.manuallyClosed }, createdAt: new Date().toISOString() }));
    });

    socket.addEventListener('error', () => {
      this.handlers.forEach((handler) => handler({ id: `${Date.now()}`, type: 'server:error', payload: { code: 'WEBSOCKET_ERROR' }, createdAt: new Date().toISOString() }));
    });
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.socket?.close();
    this.socket = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  send(type: string, payload: Record<string, unknown>, requestId?: string): void {
    const msg = { type, payload, requestId };
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.queue.push(msg);
      return;
    }
    this.socket.send(JSON.stringify(msg));
  }

  on(handler: RealtimeHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private flush(): void {
    const pending = [...this.queue];
    this.queue.length = 0;
    pending.forEach((msg) => this.send(msg.type, msg.payload, msg.requestId));
  }
}
