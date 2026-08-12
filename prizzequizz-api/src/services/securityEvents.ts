import type { IncomingMessage } from 'node:http';
import { clientIp } from '../http/clientIp.js';
import { db } from '../repositories/memory.js';
import { id } from '../utils/id.js';
import { logger } from './logger.js';

export function recordSecurityEvent(input: {
  req?: IncomingMessage;
  userId?: string;
  eventType: string;
  severity?: 'info' | 'warn' | 'critical';
  metadata?: Record<string, unknown>;
}): void {
  const event = {
    id: id(),
    userId: input.userId,
    eventType: input.eventType,
    severity: input.severity ?? 'info',
    ipAddress: input.req ? clientIp(input.req) : undefined,
    userAgent: input.req?.headers['user-agent'],
    metadata: input.metadata ?? {},
    createdAt: new Date().toISOString()
  };
  db.securityEvents.set(event.id, event);
  logger.warn('security_event', event);
}
