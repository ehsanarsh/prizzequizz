/* SERVER MONITORING — multi-server metrics with per-server API keys.
 *
 * The API host reports its OWN metrics (CPU/RAM/disk/load/uptime) via a built-in
 * collector using node:os + fs.statfs — real numbers, no mocks. Any OTHER server
 * reports by POSTing to /monitor/ingest with its `x-monitor-key`. Metrics are a
 * short time-series (pruned) so the panel can draw live gauges + history.
 * Postgres-backed with an in-memory fallback. */
import { getPgPool } from '../database/postgres.js';
import { id } from '../utils/id.js';
import { randomBytes } from 'node:crypto';

export interface MonitorServer { id: string; name: string; host: string; apiKey: string; tags: string; enabled: boolean; lastSeenAt: number | null; createdAt: string; }
export interface Metric {
  serverId: string; cpuPercent: number; memUsed: number; memTotal: number; diskUsed: number; diskTotal: number;
  load1: number; load5: number; load15: number; uptimeSec: number; netRx: number; netTx: number;
  extra?: Record<string, unknown>; createdAt: number;
}
export const MONITOR_STALE_MS = 60_000; // no report within this window ⇒ offline

function pg(): ReturnType<typeof getPgPool> | null { try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; } }
function newKey(): string { return 'mon_' + randomBytes(20).toString('hex'); }

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS monitor_servers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT DEFAULT '', api_key TEXT UNIQUE NOT NULL,
    tags TEXT DEFAULT '', enabled BOOLEAN NOT NULL DEFAULT true, last_seen_at BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS monitor_metrics (
    id TEXT PRIMARY KEY, server_id TEXT NOT NULL, cpu_percent REAL, mem_used BIGINT, mem_total BIGINT,
    disk_used BIGINT, disk_total BIGINT, load1 REAL, load5 REAL, load15 REAL, uptime_sec BIGINT,
    net_rx BIGINT DEFAULT 0, net_tx BIGINT DEFAULT 0, extra JSONB, created_at BIGINT NOT NULL)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_monitor_metrics_srv ON monitor_metrics(server_id, created_at DESC)`);
  _schemaReady = true;
}

// ---- memory fallback ----
const memServers = new Map<string, MonitorServer>();
const memMetrics: Metric[] = [];

function srvRow(r: any): MonitorServer { return { id: r.id, name: r.name, host: r.host ?? '', apiKey: r.api_key, tags: r.tags ?? '', enabled: r.enabled !== false, lastSeenAt: r.last_seen_at != null ? Number(r.last_seen_at) : null, createdAt: r.created_at?.toISOString?.() ?? String(r.created_at) }; }
function metricRow(r: any): Metric { return { serverId: r.server_id, cpuPercent: Number(r.cpu_percent || 0), memUsed: Number(r.mem_used || 0), memTotal: Number(r.mem_total || 0), diskUsed: Number(r.disk_used || 0), diskTotal: Number(r.disk_total || 0), load1: Number(r.load1 || 0), load5: Number(r.load5 || 0), load15: Number(r.load15 || 0), uptimeSec: Number(r.uptime_sec || 0), netRx: Number(r.net_rx || 0), netTx: Number(r.net_tx || 0), extra: r.extra ?? undefined, createdAt: Number(r.created_at) }; }

export async function listServers(): Promise<MonitorServer[]> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); const { rows } = await pool.query(`SELECT * FROM monitor_servers ORDER BY created_at`); return rows.map(srvRow); }
  return [...memServers.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}
export async function getServer(sid: string): Promise<MonitorServer | null> { return (await listServers()).find((s) => s.id === sid) ?? null; }
async function findByKey(key: string): Promise<MonitorServer | null> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); const { rows } = await pool.query(`SELECT * FROM monitor_servers WHERE api_key=$1`, [key]); return rows[0] ? srvRow(rows[0]) : null; }
  return [...memServers.values()].find((s) => s.apiKey === key) ?? null;
}

export async function createServer(input: { name: string; host?: string; tags?: string; id?: string; apiKey?: string }): Promise<MonitorServer> {
  const s: MonitorServer = { id: input.id || id(), name: String(input.name).slice(0, 80), host: input.host || '', apiKey: input.apiKey || newKey(), tags: input.tags || '', enabled: true, lastSeenAt: null, createdAt: new Date().toISOString() };
  const pool = pg();
  if (pool) { await ensureSchema(pool); await pool.query(`INSERT INTO monitor_servers(id,name,host,api_key,tags,enabled,created_at) VALUES($1,$2,$3,$4,$5,true,now()) ON CONFLICT (id) DO NOTHING`, [s.id, s.name, s.host, s.apiKey, s.tags]); }
  else memServers.set(s.id, s);
  return s;
}
export async function updateServer(sid: string, patch: { name?: string; host?: string; tags?: string; enabled?: boolean }): Promise<MonitorServer | null> {
  const s = await getServer(sid); if (!s) return null;
  const next = { ...s, ...patch };
  const pool = pg();
  if (pool) { await ensureSchema(pool); await pool.query(`UPDATE monitor_servers SET name=$2,host=$3,tags=$4,enabled=$5 WHERE id=$1`, [sid, next.name, next.host, next.tags, next.enabled]); }
  else memServers.set(sid, next);
  return next;
}
export async function rotateKey(sid: string): Promise<string | null> {
  const s = await getServer(sid); if (!s) return null;
  const key = newKey();
  const pool = pg();
  if (pool) { await ensureSchema(pool); await pool.query(`UPDATE monitor_servers SET api_key=$2 WHERE id=$1`, [sid, key]); }
  else { s.apiKey = key; memServers.set(sid, s); }
  return key;
}
export async function removeServer(sid: string): Promise<boolean> {
  if (sid === 'self') return false; // the built-in server can't be deleted
  const pool = pg();
  if (pool) { await ensureSchema(pool); const { rowCount } = await pool.query(`DELETE FROM monitor_servers WHERE id=$1`, [sid]); await pool.query(`DELETE FROM monitor_metrics WHERE server_id=$1`, [sid]); return (rowCount ?? 0) > 0; }
  memMetrics.splice(0, memMetrics.length, ...memMetrics.filter((m) => m.serverId !== sid));
  return memServers.delete(sid);
}

async function touchSeen(sid: string, when: number): Promise<void> {
  const pool = pg();
  if (pool) { await pool.query(`UPDATE monitor_servers SET last_seen_at=$2 WHERE id=$1`, [sid, when]); }
  else { const s = memServers.get(sid); if (s) s.lastSeenAt = when; }
}

/** Store a metric for a server (identified internally by id). */
export async function recordMetric(serverId: string, m: Partial<Metric>): Promise<void> {
  const now = Date.now();
  const metric: Metric = {
    serverId, cpuPercent: num(m.cpuPercent), memUsed: num(m.memUsed), memTotal: num(m.memTotal),
    diskUsed: num(m.diskUsed), diskTotal: num(m.diskTotal), load1: num(m.load1), load5: num(m.load5), load15: num(m.load15),
    uptimeSec: num(m.uptimeSec), netRx: num(m.netRx), netTx: num(m.netTx), extra: m.extra, createdAt: now
  };
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(`INSERT INTO monitor_metrics(id,server_id,cpu_percent,mem_used,mem_total,disk_used,disk_total,load1,load5,load15,uptime_sec,net_rx,net_tx,extra,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id(), serverId, metric.cpuPercent, metric.memUsed, metric.memTotal, metric.diskUsed, metric.diskTotal, metric.load1, metric.load5, metric.load15, metric.uptimeSec, metric.netRx, metric.netTx, JSON.stringify(metric.extra ?? {}), now]);
    // prune: keep last 24h
    if (Math.random() < 0.1) await pool.query(`DELETE FROM monitor_metrics WHERE server_id=$1 AND created_at < $2`, [serverId, now - 86400_000]);
  } else {
    memMetrics.push(metric);
    if (memMetrics.length > 5000) memMetrics.splice(0, memMetrics.length - 5000);
  }
  await touchSeen(serverId, now);
}

/** Ingest from an external agent, authenticated by its API key. */
export async function ingestByKey(apiKey: string, payload: Partial<Metric>): Promise<{ ok: boolean; serverId?: string }> {
  const s = await findByKey(apiKey);
  if (!s || !s.enabled) return { ok: false };
  await recordMetric(s.id, payload);
  return { ok: true, serverId: s.id };
}

export async function historyFor(serverId: string, limit = 60): Promise<Metric[]> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); const { rows } = await pool.query(`SELECT * FROM monitor_metrics WHERE server_id=$1 ORDER BY created_at DESC LIMIT $2`, [serverId, limit]); return rows.map(metricRow).reverse(); }
  return memMetrics.filter((m) => m.serverId === serverId).slice(-limit);
}
async function latestFor(serverId: string): Promise<Metric | null> {
  const h = await historyFor(serverId, 1); return h[h.length - 1] ?? null;
}

/** Overview: every server with its latest metric + online status. */
export async function overview(): Promise<Array<{ server: Omit<MonitorServer, 'apiKey'> & { apiKeyMask: string }; online: boolean; latest: Metric | null }>> {
  const servers = await listServers();
  const now = Date.now();
  const out = [];
  for (const s of servers) {
    const latest = await latestFor(s.id);
    const seen = s.lastSeenAt ?? (latest?.createdAt ?? null);
    out.push({ server: { id: s.id, name: s.name, host: s.host, tags: s.tags, enabled: s.enabled, lastSeenAt: seen, createdAt: s.createdAt, apiKeyMask: s.apiKey ? '••••' + s.apiKey.slice(-6) : '' }, online: seen != null && (now - seen) < MONITOR_STALE_MS, latest });
  }
  return out;
}

function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// Ensure the built-in "self" server row exists (the API host).
export async function ensureSelfServer(): Promise<MonitorServer> {
  const existing = await getServer('self');
  if (existing) return existing;
  return createServer({ id: 'self', name: 'سرور اصلی (API)', host: process.env.MONITOR_SELF_HOST || 'api', tags: 'primary', apiKey: 'self-' + randomBytes(8).toString('hex') });
}
