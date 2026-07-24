/* SCHEDULED / ADMIN NOTIFICATIONS
 * Lets an admin queue one or many notifications to fire at chosen date+times.
 * A single scheduler loop wakes every 20s, delivers everything now due through
 * the real notification service (in-app + push), and marks it sent. Persisted in
 * Postgres (survives restarts) with a memory fallback for the dev driver. */
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';
import { notifications } from './notificationService.js';
import { logger } from './logger.js';
import { id } from '../utils/id.js';
import type { NotificationType } from '../types/domain.js';
import { resolveSegment, type SegmentSpec } from './notificationSegmentService.js';
import { recordCampaignResult } from './notificationCampaignService.js';

export interface ScheduledNotification {
  id: string;
  title: string;
  body: string;
  type: NotificationType;
  audience: 'all' | 'specific' | 'segment';
  userIds: string[];
  segment?: SegmentSpec;
  image?: string;
  action?: Record<string, unknown>;
  campaignId?: string;
  scheduledAt: string;          // ISO; when it should fire
  status: 'pending' | 'sent' | 'canceled' | 'failed';
  push: boolean;
  createdBy?: string;
  createdAt: string;
  sentAt?: string;
  deliveredCount?: number;
  error?: string;
}

const VALID_TYPES: NotificationType[] = ['match_update', 'leaderboard_update', 'wallet_update', 'system', 'promo'];
function normType(t: any): NotificationType { return VALID_TYPES.includes(t) ? t : 'system'; }

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS scheduled_notifications (
    id UUID PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    body TEXT NOT NULL,
    type VARCHAR(32) NOT NULL DEFAULT 'system',
    audience VARCHAR(16) NOT NULL DEFAULT 'all',
    user_ids JSONB NOT NULL DEFAULT '[]',
    scheduled_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    push BOOLEAN NOT NULL DEFAULT true,
    created_by VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ,
    delivered_count INT NOT NULL DEFAULT 0,
    error TEXT)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sched_notif_status_time ON scheduled_notifications(status, scheduled_at)`);
  // Rich-notification + segment columns (added over time; safe to re-run).
  await pool.query(`ALTER TABLE scheduled_notifications ADD COLUMN IF NOT EXISTS segment JSONB`);
  await pool.query(`ALTER TABLE scheduled_notifications ADD COLUMN IF NOT EXISTS image TEXT`);
  await pool.query(`ALTER TABLE scheduled_notifications ADD COLUMN IF NOT EXISTS action JSONB`);
  await pool.query(`ALTER TABLE scheduled_notifications ADD COLUMN IF NOT EXISTS campaign_id TEXT`);
  _schemaReady = true;
}

const mem: ScheduledNotification[] = [];

function rowToSched(r: any): ScheduledNotification {
  return {
    id: r.id, title: r.title, body: r.body, type: r.type, audience: r.audience,
    userIds: Array.isArray(r.user_ids) ? r.user_ids : (r.user_ids ? JSON.parse(r.user_ids) : []),
    segment: r.segment ?? undefined, image: r.image ?? undefined, action: r.action ?? undefined, campaignId: r.campaign_id ?? undefined,
    scheduledAt: r.scheduled_at?.toISOString?.() ?? String(r.scheduled_at),
    status: r.status, push: r.push !== false, createdBy: r.created_by ?? undefined,
    createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    sentAt: r.sent_at?.toISOString?.() ?? (r.sent_at ?? undefined),
    deliveredCount: Number(r.delivered_count ?? 0), error: r.error ?? undefined
  };
}

export async function createScheduled(input: {
  title: string; body: string; type?: any; audience?: 'all' | 'specific' | 'segment';
  userIds?: string[]; segment?: SegmentSpec; image?: string; action?: Record<string, unknown>;
  campaignId?: string; scheduledAt: string; push?: boolean; createdBy?: string;
}): Promise<ScheduledNotification> {
  const title = String(input.title ?? '').trim();
  const body = String(input.body ?? '').trim();
  if (!title) throw new Error('TITLE_REQUIRED');
  if (!body) throw new Error('BODY_REQUIRED');
  const ts = Date.parse(input.scheduledAt);
  if (!Number.isFinite(ts)) throw new Error('SCHEDULE_TIME_INVALID');
  const audience: 'all' | 'specific' | 'segment' = input.audience === 'specific' ? 'specific' : input.audience === 'segment' ? 'segment' : 'all';
  const userIds = audience === 'specific' ? (Array.isArray(input.userIds) ? input.userIds.map(String).filter(Boolean) : []) : [];
  if (audience === 'specific' && !userIds.length) throw new Error('NO_RECIPIENTS');
  const row: ScheduledNotification = {
    id: id(), title: title.slice(0, 200), body: body.slice(0, 800), type: normType(input.type),
    audience, userIds, segment: input.segment, image: input.image, action: input.action, campaignId: input.campaignId,
    scheduledAt: new Date(ts).toISOString(), status: 'pending',
    push: input.push !== false, createdBy: input.createdBy, createdAt: new Date().toISOString(), deliveredCount: 0
  };
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO scheduled_notifications(id,title,body,type,audience,user_ids,segment,image,action,campaign_id,scheduled_at,status,push,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13)`,
      [row.id, row.title, row.body, row.type, row.audience, JSON.stringify(row.userIds), row.segment ? JSON.stringify(row.segment) : null, row.image ?? null, row.action ? JSON.stringify(row.action) : null, row.campaignId ?? null, row.scheduledAt, row.push, row.createdBy ?? null]);
  } else {
    mem.push(row);
  }
  logger.info('scheduled_notification_created', { id: row.id, scheduledAt: row.scheduledAt, audience: row.audience });
  return row;
}

export async function listScheduled(limit = 200): Promise<ScheduledNotification[]> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT * FROM scheduled_notifications ORDER BY scheduled_at DESC LIMIT ${Math.min(500, Math.max(1, limit))}`);
    return rows.map(rowToSched);
  }
  return mem.slice().sort((a, b) => (a.scheduledAt < b.scheduledAt ? 1 : -1)).slice(0, limit);
}

export async function cancelScheduled(schedId: string): Promise<boolean> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rowCount } = await pool.query(`UPDATE scheduled_notifications SET status='canceled' WHERE id=$1 AND status='pending'`, [schedId]);
    return (rowCount ?? 0) > 0;
  }
  const s = mem.find((x) => x.id === schedId && x.status === 'pending');
  if (!s) return false;
  s.status = 'canceled';
  return true;
}

/* Deliver everything now due. Serialized by the scheduler so a slow run can't
 * overlap and double-send. Each item is marked sent BEFORE delivery via a guarded
 * UPDATE (Postgres) so two server instances never both fire the same one. */
let _dispatching = false;
export async function dispatchDue(now = Date.now()): Promise<number> {
  if (_dispatching) return 0;
  _dispatching = true;
  let fired = 0;
  try {
    const pool = pg();
    const nowIso = new Date(now).toISOString();
    let due: ScheduledNotification[] = [];
    if (pool) {
      await ensureSchema(pool);
      // Claim due rows atomically (pending → sending) so only one worker delivers each.
      const { rows } = await pool.query(
        `UPDATE scheduled_notifications SET status='sending'
         WHERE id IN (SELECT id FROM scheduled_notifications WHERE status='pending' AND scheduled_at <= $1 ORDER BY scheduled_at ASC LIMIT 50)
         RETURNING *`, [nowIso]);
      due = rows.map(rowToSched);
    } else {
      due = mem.filter((s) => s.status === 'pending' && Date.parse(s.scheduledAt) <= now);
      for (const s of due) s.status = 'sending' as any;
    }
    for (const s of due) {
      try {
        let userIds: string[];
        if (s.audience === 'specific') userIds = s.userIds;
        else if (s.audience === 'segment' && s.segment) userIds = (await resolveSegment(s.segment)).userIds;
        else userIds = (await repositories.users.list(5000)).map((u) => u.id);
        const data: Record<string, unknown> = { scheduled: true, scheduledId: s.id };
        if (s.campaignId) data.campaignId = s.campaignId;
        if (s.action && (s.action as any).url) data.url = (s.action as any).url;
        if (s.image) data.image = s.image;
        const res = await notifications.broadcast({ userIds, type: s.type, title: s.title, body: s.body, data, push: s.push });
        await markSent(s.id, res.created);
        if (s.campaignId) { try { await recordCampaignResult(s.campaignId, { created: res.created, sent: res.sent, failed: 0, status: 'sent' }); } catch { /* analytics optional */ } }
        fired += 1;
        logger.info('scheduled_notification_sent', { id: s.id, delivered: res.created });
      } catch (e) {
        await markFailed(s.id, e instanceof Error ? e.message : 'unknown');
        logger.warn('scheduled_notification_failed', { id: s.id, message: e instanceof Error ? e.message : 'unknown' });
      }
    }
  } finally {
    _dispatching = false;
  }
  return fired;
}

async function markSent(schedId: string, delivered: number): Promise<void> {
  const pool = pg();
  if (pool) { await pool.query(`UPDATE scheduled_notifications SET status='sent', sent_at=now(), delivered_count=$2 WHERE id=$1`, [schedId, delivered]); return; }
  const s = mem.find((x) => x.id === schedId); if (s) { s.status = 'sent'; s.sentAt = new Date().toISOString(); s.deliveredCount = delivered; }
}
async function markFailed(schedId: string, error: string): Promise<void> {
  const pool = pg();
  if (pool) { await pool.query(`UPDATE scheduled_notifications SET status='failed', error=$2 WHERE id=$1`, [schedId, error.slice(0, 400)]); return; }
  const s = mem.find((x) => x.id === schedId); if (s) { s.status = 'failed'; s.error = error; }
}

let _timer: ReturnType<typeof setInterval> | null = null;
export function startScheduler(): void {
  if (_timer) return;
  // First sweep shortly after boot, then every 20s.
  setTimeout(() => { void dispatchDue(); }, 4000);
  _timer = setInterval(() => { void dispatchDue(); }, 20_000);
  if (typeof (_timer as any).unref === 'function') (_timer as any).unref();
  logger.info('scheduled_notification_scheduler_started', {});
}
