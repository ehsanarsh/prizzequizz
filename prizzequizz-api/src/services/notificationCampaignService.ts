/* NOTIFICATION CAMPAIGNS + ANALYTICS.
 * Every admin send (immediate or scheduled) is recorded as a campaign so the
 * panel gets real history + analytics: how many were created, delivered (push
 * sent), how many were opened (read_at on the per-user notification) and clicked
 * (the user tapped the action/deep-link). Open/click are REAL, tracked events —
 * not invented numbers. Postgres-backed with a memory fallback. */
import { getPgPool } from '../database/postgres.js';
import { id } from '../utils/id.js';
import { logger } from './logger.js';

export interface Campaign {
  id: string;
  title: string;
  body: string;
  type: string;
  image?: string;
  action?: Record<string, unknown>;   // deep-link: { url, label }
  segment?: Record<string, unknown>;
  segmentDesc?: string;
  audienceCount: number;
  createdCount: number;    // notifications created (allowed by prefs)
  sentCount: number;       // push delivered
  failedCount: number;
  clickedCount: number;
  status: 'sent' | 'scheduled' | 'sending' | 'failed';
  scheduledAt?: string;
  createdBy?: string;
  createdAt: string;
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS notification_campaigns (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    type VARCHAR(32) NOT NULL DEFAULT 'system',
    image TEXT,
    action JSONB NOT NULL DEFAULT '{}',
    segment JSONB NOT NULL DEFAULT '{}',
    segment_desc TEXT,
    audience_count INT NOT NULL DEFAULT 0,
    created_count INT NOT NULL DEFAULT 0,
    sent_count INT NOT NULL DEFAULT 0,
    failed_count INT NOT NULL DEFAULT 0,
    clicked_count INT NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'sent',
    scheduled_at TIMESTAMPTZ,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notif_campaigns_time ON notification_campaigns(created_at DESC)`);
  _schemaReady = true;
}

const mem: Campaign[] = [];

function rowToCampaign(r: any): Campaign {
  return {
    id: r.id, title: r.title, body: r.body, type: r.type, image: r.image ?? undefined,
    action: r.action ?? {}, segment: r.segment ?? {}, segmentDesc: r.segment_desc ?? undefined,
    audienceCount: Number(r.audience_count ?? 0), createdCount: Number(r.created_count ?? 0),
    sentCount: Number(r.sent_count ?? 0), failedCount: Number(r.failed_count ?? 0),
    clickedCount: Number(r.clicked_count ?? 0), status: r.status,
    scheduledAt: r.scheduled_at?.toISOString?.() ?? (r.scheduled_at ?? undefined),
    createdBy: r.created_by ?? undefined, createdAt: r.created_at?.toISOString?.() ?? String(r.created_at)
  };
}

export async function createCampaign(input: {
  title: string; body: string; type?: string; image?: string; action?: Record<string, unknown>;
  segment?: Record<string, unknown>; segmentDesc?: string; audienceCount?: number;
  status?: Campaign['status']; scheduledAt?: string; createdBy?: string; campaignId?: string;
}): Promise<Campaign> {
  const row: Campaign = {
    id: input.campaignId || id(), title: String(input.title || '').slice(0, 200), body: String(input.body || '').slice(0, 800),
    type: input.type || 'system', image: input.image || undefined, action: input.action || {},
    segment: input.segment || {}, segmentDesc: input.segmentDesc, audienceCount: input.audienceCount ?? 0,
    createdCount: 0, sentCount: 0, failedCount: 0, clickedCount: 0,
    status: input.status || 'sent', scheduledAt: input.scheduledAt, createdBy: input.createdBy,
    createdAt: new Date().toISOString()
  };
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO notification_campaigns(id,title,body,type,image,action,segment,segment_desc,audience_count,status,scheduled_at,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
      [row.id, row.title, row.body, row.type, row.image ?? null, JSON.stringify(row.action), JSON.stringify(row.segment), row.segmentDesc ?? null, row.audienceCount, row.status, row.scheduledAt ?? null, row.createdBy ?? null]);
  } else {
    mem.unshift(row);
  }
  return row;
}

export async function recordCampaignResult(campaignId: string, r: { created: number; sent: number; failed?: number; status?: Campaign['status'] }): Promise<void> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(`UPDATE notification_campaigns SET created_count=$2, sent_count=$3, failed_count=$4, status=coalesce($5,status) WHERE id=$1`,
      [campaignId, r.created, r.sent, r.failed ?? 0, r.status ?? null]);
    return;
  }
  const c = mem.find((x) => x.id === campaignId);
  if (c) { c.createdCount = r.created; c.sentCount = r.sent; c.failedCount = r.failed ?? 0; if (r.status) c.status = r.status; }
}

export async function bumpCampaignClick(campaignId: string): Promise<void> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); await pool.query(`UPDATE notification_campaigns SET clicked_count = clicked_count + 1 WHERE id=$1`, [campaignId]); return; }
  const c = mem.find((x) => x.id === campaignId); if (c) c.clickedCount += 1;
}

export async function listCampaigns(limit = 100): Promise<Campaign[]> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT * FROM notification_campaigns ORDER BY created_at DESC LIMIT ${Math.min(500, Math.max(1, limit))}`);
    return rows.map(rowToCampaign);
  }
  return mem.slice(0, limit);
}

// Real open count from the per-user notifications carrying this campaign id.
export async function campaignOpens(campaignId: string): Promise<number> {
  const pool = pg();
  if (!pool) return 0;
  try {
    const { rows } = await pool.query(`SELECT count(*)::int n FROM notifications WHERE data->>'campaignId' = $1 AND read_at IS NOT NULL`, [campaignId]);
    return Number(rows[0]?.n ?? 0);
  } catch { return 0; }
}

export async function campaignAnalytics(campaignId: string): Promise<(Campaign & { opens: number; deliveryRate: number; openRate: number; ctr: number }) | null> {
  const list = await listCampaigns(500);
  const c = list.find((x) => x.id === campaignId);
  if (!c) return null;
  const opens = await campaignOpens(campaignId);
  const denom = c.createdCount || c.audienceCount || 0;
  return {
    ...c, opens,
    deliveryRate: denom ? Math.round((c.sentCount / denom) * 100) : 0,
    openRate: denom ? Math.round((opens / denom) * 100) : 0,
    ctr: denom ? Math.round((c.clickedCount / denom) * 100) : 0
  };
}

// Dashboard rollup across all campaigns (+ today).
export async function campaignDashboard(): Promise<{ totalCampaigns: number; sentToday: number; deliveredTotal: number; opensTotal: number; clicksTotal: number; scheduled: number; failedTotal: number }> {
  const list = await listCampaigns(500);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let opensTotal = 0;
  for (const c of list) opensTotal += await campaignOpens(c.id).catch(() => 0);
  return {
    totalCampaigns: list.length,
    sentToday: list.filter((c) => c.status === 'sent' && Date.parse(c.createdAt) >= today.getTime()).reduce((s, c) => s + c.sentCount, 0),
    deliveredTotal: list.reduce((s, c) => s + c.sentCount, 0),
    opensTotal,
    clicksTotal: list.reduce((s, c) => s + c.clickedCount, 0),
    scheduled: list.filter((c) => c.status === 'scheduled').length,
    failedTotal: list.reduce((s, c) => s + c.failedCount, 0)
  };
}

export { logger };
