/* Persistent admin audit trail — EVERY admin mutation is recorded here forever,
 * with before/after/delta for value changes, the acting admin, the target user,
 * a reason and a stable id. Backed by a DB table (survives restart); memory
 * fallback for the dev driver. This is the "who did what, and what changed"
 * ledger the panel reads. */
import { getPgPool } from '../database/postgres.js';
import { id } from '../utils/id.js';
import { logger } from './logger.js';

export interface AdminAuditEntry {
  id: string; adminId: string; targetUserId?: string; action: string;
  before?: number | null; after?: number | null; delta?: number | null;
  reason?: string; meta?: Record<string, unknown>; createdAt: string;
}

let _ready = false;
function pg() { try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; } }
async function ensure(pool: ReturnType<typeof getPgPool>) {
  if (_ready) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS admin_audit_log (
    id UUID PRIMARY KEY,
    admin_id VARCHAR(64) NOT NULL,
    target_user_id VARCHAR(64),
    action VARCHAR(64) NOT NULL,
    before_value BIGINT,
    after_value BIGINT,
    delta BIGINT,
    reason TEXT,
    meta JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT now())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_audit_time ON admin_audit_log(created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_log(action, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_log(target_user_id, created_at DESC)`);
  _ready = true;
}

const mem: AdminAuditEntry[] = [];

/* Never throws — an audit failure must not break the operation, but is logged. */
export async function recordAdmin(input: { adminId?: string; targetUserId?: string; action: string; before?: number | null; after?: number | null; delta?: number | null; reason?: string; meta?: Record<string, unknown> }): Promise<void> {
  const e: AdminAuditEntry = {
    id: id(), adminId: input.adminId ?? 'system', targetUserId: input.targetUserId,
    action: input.action, before: input.before ?? null, after: input.after ?? null,
    delta: input.delta ?? (input.before != null && input.after != null ? input.after - input.before : null),
    reason: input.reason, meta: input.meta ?? {}, createdAt: new Date().toISOString()
  };
  try {
    const pool = pg();
    if (!pool) { mem.unshift(e); if (mem.length > 5000) mem.pop(); return; }
    await ensure(pool);
    await pool.query(
      `INSERT INTO admin_audit_log(id,admin_id,target_user_id,action,before_value,after_value,delta,reason,meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [e.id, e.adminId, e.targetUserId ?? null, e.action, e.before, e.after, e.delta, e.reason ?? null, JSON.stringify(e.meta)]);
  } catch (err) {
    logger.warn('admin_audit_failed', { action: e.action, message: err instanceof Error ? err.message : 'unknown' });
  }
}

export async function listAdminAudit(filter: { limit?: number; action?: string; adminId?: string; targetUserId?: string } = {}): Promise<AdminAuditEntry[]> {
  const limit = Math.min(500, Math.max(1, Number(filter.limit) || 100));
  const pool = pg();
  if (!pool) {
    let rows = [...mem];
    if (filter.action) rows = rows.filter((r) => r.action === filter.action);
    if (filter.adminId) rows = rows.filter((r) => r.adminId === filter.adminId);
    if (filter.targetUserId) rows = rows.filter((r) => r.targetUserId === filter.targetUserId);
    return rows.slice(0, limit);
  }
  await ensure(pool);
  const conds: string[] = []; const args: unknown[] = [];
  if (filter.action) { args.push(filter.action); conds.push(`action=$${args.length}`); }
  if (filter.adminId) { args.push(filter.adminId); conds.push(`admin_id=$${args.length}`); }
  if (filter.targetUserId) { args.push(filter.targetUserId); conds.push(`target_user_id=$${args.length}`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM admin_audit_log ${where} ORDER BY created_at DESC LIMIT ${limit}`, args);
  return rows.map((r) => ({ id: r.id, adminId: r.admin_id, targetUserId: r.target_user_id ?? undefined, action: r.action, before: r.before_value != null ? Number(r.before_value) : null, after: r.after_value != null ? Number(r.after_value) : null, delta: r.delta != null ? Number(r.delta) : null, reason: r.reason ?? undefined, meta: r.meta ?? {}, createdAt: r.created_at?.toISOString?.() ?? String(r.created_at) }));
}
