import { createClient } from 'redis';
import type { ServerRealtimeMessage } from './protocol.js';
import { logger } from '../services/logger.js';

export interface RealtimePubSub {
  publish(channel: string, message: ServerRealtimeMessage): Promise<void>;
  subscribe(channel: string, handler: (message: ServerRealtimeMessage) => void): Promise<() => void>;
}

export class MemoryRealtimePubSub implements RealtimePubSub {
  private handlers = new Map<string, Set<(message: ServerRealtimeMessage) => void>>();

  async publish(channel: string, message: ServerRealtimeMessage): Promise<void> {
    this.handlers.get(channel)?.forEach((handler) => handler(message));
  }

  async subscribe(channel: string, handler: (message: ServerRealtimeMessage) => void): Promise<() => void> {
    if (!this.handlers.has(channel)) this.handlers.set(channel, new Set());
    this.handlers.get(channel)!.add(handler);
    return () => this.handlers.get(channel)?.delete(handler);
  }
}

export class RedisRealtimePubSub implements RealtimePubSub {
  private pubClient: ReturnType<typeof createClient> | null = null;
  private subClient: ReturnType<typeof createClient> | null = null;
  private handlers = new Map<string, Set<(message: ServerRealtimeMessage) => void>>();
  private subscribedChannels = new Set<string>();

  constructor(private readonly url = process.env.REDIS_URL ?? 'redis://localhost:6379') {}

  async publish(channel: string, message: ServerRealtimeMessage): Promise<void> {
    const client = await this.getPubClient();
    await client.publish(channel, JSON.stringify(message));
  }

  async subscribe(channel: string, handler: (message: ServerRealtimeMessage) => void): Promise<() => void> {
    if (!this.handlers.has(channel)) this.handlers.set(channel, new Set());
    this.handlers.get(channel)!.add(handler);

    if (!this.subscribedChannels.has(channel)) {
      const client = await this.getSubClient();
      await client.subscribe(channel, (raw) => {
        const parsed = this.parse(raw, channel);
        if (!parsed) return;
        this.handlers.get(channel)?.forEach((fn) => fn(parsed));
      });
      this.subscribedChannels.add(channel);
      logger.info('redis_realtime_subscribed', { channel });
    }

    return () => {
      this.handlers.get(channel)?.delete(handler);
      if (this.handlers.get(channel)?.size === 0) {
        void this.unsubscribe(channel);
      }
    };
  }

  private async unsubscribe(channel: string): Promise<void> {
    if (!this.subClient || !this.subscribedChannels.has(channel)) return;
    await this.subClient.unsubscribe(channel);
    this.subscribedChannels.delete(channel);
    this.handlers.delete(channel);
    logger.info('redis_realtime_unsubscribed', { channel });
  }

  private async getPubClient(): Promise<ReturnType<typeof createClient>> {
    if (!this.pubClient) {
      this.pubClient = createClient({ url: this.url });
      this.pubClient.on('error', (error) => logger.error('redis_pubsub_publish_error', { message: error.message }));
      await this.pubClient.connect();
      logger.info('redis_realtime_publisher_connected', { url: this.redactedUrl() });
    }
    return this.pubClient;
  }

  private async getSubClient(): Promise<ReturnType<typeof createClient>> {
    if (!this.subClient) {
      this.subClient = createClient({ url: this.url });
      this.subClient.on('error', (error) => logger.error('redis_pubsub_subscribe_error', { message: error.message }));
      await this.subClient.connect();
      logger.info('redis_realtime_subscriber_connected', { url: this.redactedUrl() });
    }
    return this.subClient;
  }

  private parse(raw: string, channel: string): ServerRealtimeMessage | null {
    try {
      return JSON.parse(raw) as ServerRealtimeMessage;
    } catch (error) {
      logger.warn('redis_realtime_invalid_message', { channel, rawLength: raw.length });
      return null;
    }
  }

  private redactedUrl(): string {
    try {
      const u = new URL(this.url);
      if (u.password) u.password = '***';
      return u.toString();
    } catch {
      return 'redis-url';
    }
  }
}

export const realtimePubSub: RealtimePubSub = process.env.REDIS_URL && process.env.REALTIME_ADAPTER === 'redis'
  ? new RedisRealtimePubSub()
  : new MemoryRealtimePubSub();
