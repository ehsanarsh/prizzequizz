/* MULTI-GATEWAY PAYMENTS — admin-managed gateway registry + money policy.
 *
 * Sits ON TOP of the existing signed payment-intent flow. The admin registers
 * any number of gateways (Zibal, ZarinPal, NextPay, IDPay, BitPay, Sandbox…),
 * orders them by priority, and toggles them on/off. Deposits pick the highest
 * priority ENABLED gateway; if one is down the next takes over (auto-switch).
 * Deposit/withdraw policy (min/max/daily cap/fee/hours) and the fee model are
 * editable here too. Every intent is tagged with the gateway that served it, so
 * per-gateway reports (volume, success rate, totals, errors) are exact.
 * Postgres-backed with an in-memory fallback. Secrets are masked on read. */
import { getPgPool } from '../database/postgres.js';
import { id } from '../utils/id.js';
import { getWalletLimits } from './economyConfig.js';

export interface PaymentGateway {
  id: string;
  name: string;
  type: string;            // zibal | zarinpal | nextpay | idpay | bitpay | sandbox | custom
  apiKey: string;
  merchantId: string;
  secret: string;
  callbackUrl: string;
  availability: GatewayAvailability;
  sandbox: boolean;
  priority: number;        // lower = tried first
  createdAt: string;
  updatedAt: string;
}
export interface PaymentSettings {
  deposit: { enabled: boolean; min: number; max: number; dailyCap: number; txPerDay: number };
  withdraw: { enabled: boolean; min: number; max: number; dailyCap: number; fee: number; feePayer: 'user' | 'system'; autoApprove: boolean; hoursFrom: number; hoursTo: number };
  feePercent: number;      // platform deposit fee (0 = none)
  defaultGatewayId: string | null;
  /* Card-to-card policy. On the existing settings blob rather than in a table
   * of its own: five numbers an operator tunes, not an entity. */
  c2c: {
    /** 'rial' hides the uniqueness suffix inside the Rial figure (≤ 9.9 Toman
     *  of difference); 'toman' keeps the payable amount a whole Toman, for
     *  banking apps that will not accept anything else. */
    suffixMode: 'rial' | 'toman';
    /** How long the player has to pay. */
    ttlMinutes: number;
    /** How long AFTER that the amount stays reserved, so a late transfer is
     *  still recognisable instead of landing on the next person given it. */
    reserveHours: number;
    /** A cancelled session keeps its amount this long. */
    cancelCooldownMinutes: number;
    /** Sessions one player may hold open — the amount space is finite, and
     *  without this one account can reserve all of it and pay for none. */
    maxActivePerUser: number;
  };
}

export const GATEWAY_TYPES = ['zibal', 'zarinpal', 'nextpay', 'idpay', 'bitpay', 'sandbox', 'custom', 'card_to_card'] as const;

/* «SOON» IS NOT «OFF».
 *
 * `enabled: boolean` had to mean two different things at once: whether a
 * gateway may take money, and whether a player is told it exists. Those come
 * apart the moment a second way to pay is announced before it is ready — the
 * operator wants the bank gateway VISIBLE and unselectable, which a boolean
 * cannot say.
 *
 *   live         picked by pickActiveGateway, shown, selectable
 *   coming_soon  NEVER picked, shown greyed out with its own note
 *   hidden       never picked, never shown
 *
 * The state lives on the server rather than as a label in the client, so the
 * day the bank gateway is ready is one click in the panel — not a deploy that
 * still leaves every cached client saying «به‌زودی». */
export const GATEWAY_AVAILABILITY = ['live', 'coming_soon', 'hidden'] as const;
export type GatewayAvailability = (typeof GATEWAY_AVAILABILITY)[number];

export function isAvailability(v: unknown): v is GatewayAvailability {
  return (GATEWAY_AVAILABILITY as readonly string[]).includes(String(v));
}

function pg(): ReturnType<typeof getPgPool> | null { try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; } }

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS payment_gateways (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
    api_key TEXT DEFAULT '', merchant_id TEXT DEFAULT '', secret TEXT DEFAULT '', callback_url TEXT DEFAULT '',
    enabled BOOLEAN NOT NULL DEFAULT true, sandbox BOOLEAN NOT NULL DEFAULT true, priority INT NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS payment_settings (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  /* Mirrors database/migrations/027_gateway_availability.sql, so a plain
   * build+restart deploy works exactly as the wallet ledger's does. The old
   * boolean is carried across and then dropped: leaving both would mean two
   * fields that can disagree about whether a gateway takes money. */
  await pool.query(`ALTER TABLE payment_gateways ADD COLUMN IF NOT EXISTS availability TEXT NOT NULL DEFAULT 'live'`);
  await pool.query(`DO $do$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='payment_gateways' AND column_name='enabled') THEN
        UPDATE payment_gateways SET availability = CASE WHEN enabled THEN 'live' ELSE 'hidden' END;
        ALTER TABLE payment_gateways DROP COLUMN enabled;
      END IF;
    END
  $do$;`);
  _schemaReady = true;
}

function defaultSettings(): PaymentSettings {
  const w = getWalletLimits();
  return {
    deposit: { enabled: true, min: w.minDeposit, max: w.maxDeposit, dailyCap: w.maxDeposit, txPerDay: 20 },
    withdraw: { enabled: true, min: w.minWithdraw, max: w.maxWithdraw, dailyCap: w.dailyWithdrawCap, fee: w.withdrawFee, feePayer: 'user', autoApprove: false, hoursFrom: 0, hoursTo: 24 },
    feePercent: 0, defaultGatewayId: null,
    c2c: { suffixMode: 'rial', ttlMinutes: 20, reserveHours: 24, cancelCooldownMinutes: 15, maxActivePerUser: 2 }
  };
}

// ---- memory fallback ----
const memGw = new Map<string, PaymentGateway>();
let memSettings: PaymentSettings | null = null;
let _seeded = false;

function gwRow(r: any): PaymentGateway {
  return { id: r.id, name: r.name, type: r.type, apiKey: r.api_key ?? '', merchantId: r.merchant_id ?? '', secret: r.secret ?? '', callbackUrl: r.callback_url ?? '', availability: isAvailability(r.availability) ? r.availability : 'live', sandbox: r.sandbox !== false, priority: Number(r.priority ?? 100), createdAt: r.created_at?.toISOString?.() ?? String(r.created_at), updatedAt: r.updated_at?.toISOString?.() ?? String(r.updated_at) };
}

async function seedIfEmpty(): Promise<void> {
  if (_seeded) return;
  const all = await listGatewaysRaw();
  if (all.length === 0) {
    await saveGateway({ name: 'درگاه تست (Sandbox)', type: 'sandbox', availability: 'live', sandbox: true, priority: 1, callbackUrl: '/v1/payments/callback' });
  }
  _seeded = true;
}

async function listGatewaysRaw(): Promise<PaymentGateway[]> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); const { rows } = await pool.query(`SELECT * FROM payment_gateways ORDER BY priority, created_at`); return rows.map(gwRow); }
  return [...memGw.values()].sort((a, b) => a.priority - b.priority || (a.createdAt < b.createdAt ? -1 : 1));
}
export async function listGateways(): Promise<PaymentGateway[]> { await seedIfEmpty(); return listGatewaysRaw(); }
export async function getGateway(gid: string): Promise<PaymentGateway | null> { return (await listGatewaysRaw()).find((g) => g.id === gid) ?? null; }

function mask(g: PaymentGateway): PaymentGateway & { apiKeySet: boolean; secretSet: boolean } {
  return { ...g, apiKey: g.apiKey ? '••••' + g.apiKey.slice(-4) : '', secret: g.secret ? '••••' : '', apiKeySet: !!g.apiKey, secretSet: !!g.secret };
}
export async function listGatewaysMasked() { return (await listGateways()).map(mask); }

export async function saveGateway(input: Partial<PaymentGateway> & { name: string; type: string }): Promise<PaymentGateway> {
  const now = new Date().toISOString();
  const existing = input.id ? await getGateway(input.id) : null;
  const g: PaymentGateway = {
    id: input.id || id(), name: String(input.name).slice(0, 80), type: String(input.type),
    apiKey: input.apiKey != null ? String(input.apiKey) : (existing?.apiKey ?? ''),
    merchantId: input.merchantId != null ? String(input.merchantId) : (existing?.merchantId ?? ''),
    secret: input.secret != null ? String(input.secret) : (existing?.secret ?? ''),
    callbackUrl: input.callbackUrl != null ? String(input.callbackUrl) : (existing?.callbackUrl ?? '/v1/payments/callback'),
    availability: isAvailability(input.availability) ? input.availability : (existing?.availability ?? 'live'),
    sandbox: input.sandbox != null ? !!input.sandbox : (existing?.sandbox ?? true),
    priority: input.priority != null ? Number(input.priority) : (existing?.priority ?? 100),
    createdAt: existing?.createdAt || now, updatedAt: now
  };
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(`INSERT INTO payment_gateways(id,name,type,api_key,merchant_id,secret,callback_url,availability,sandbox,priority,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (id) DO UPDATE SET name=$2,type=$3,api_key=$4,merchant_id=$5,secret=$6,callback_url=$7,availability=$8,sandbox=$9,priority=$10,updated_at=$12`,
      [g.id, g.name, g.type, g.apiKey, g.merchantId, g.secret, g.callbackUrl, g.availability, g.sandbox, g.priority, g.createdAt, g.updatedAt]);
  } else memGw.set(g.id, g);
  return g;
}
export async function removeGateway(gid: string): Promise<boolean> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); const { rowCount } = await pool.query(`DELETE FROM payment_gateways WHERE id=$1`, [gid]); return (rowCount ?? 0) > 0; }
  return memGw.delete(gid);
}

// ---- settings ----
export async function getPaymentSettings(): Promise<PaymentSettings> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); const { rows } = await pool.query(`SELECT data FROM payment_settings WHERE id='default'`); if (!rows[0]) { const d = defaultSettings(); await pool.query(`INSERT INTO payment_settings(id,data) VALUES('default',$1) ON CONFLICT DO NOTHING`, [JSON.stringify(d)]); return d; } return { ...defaultSettings(), ...(rows[0].data as any) }; }
  if (!memSettings) memSettings = defaultSettings();
  return memSettings;
}
export async function updatePaymentSettings(patch: Partial<PaymentSettings>): Promise<PaymentSettings> {
  const cur = await getPaymentSettings();
  const next: PaymentSettings = { ...cur, ...patch, deposit: { ...cur.deposit, ...(patch.deposit || {}) }, withdraw: { ...cur.withdraw, ...(patch.withdraw || {}) }, c2c: { ...cur.c2c, ...(patch.c2c || {}) } };
  const pool = pg();
  if (pool) { await ensureSchema(pool); await pool.query(`INSERT INTO payment_settings(id,data,updated_at) VALUES('default',$1,now()) ON CONFLICT (id) DO UPDATE SET data=$1, updated_at=now()`, [JSON.stringify(next)]); }
  else memSettings = next;
  return next;
}

// ---- gateway selection + failover ----
/** Highest-priority enabled gateway, skipping any excluded ids (auto-switch). */
export async function pickActiveGateway(excludeIds: string[] = []): Promise<PaymentGateway | null> {
  const settings = await getPaymentSettings();
  /* `coming_soon` is announced, not open. A gateway that cannot take money must
   * never be picked to take money, whatever its priority says. */
  const gws = (await listGateways()).filter((g) => g.availability === 'live' && !excludeIds.includes(g.id));
  if (!gws.length) return null;
  if (settings.defaultGatewayId) { const def = gws.find((g) => g.id === settings.defaultGatewayId); if (def) return def; }
  return gws[0]!; // already sorted by priority
}

/** Best-effort connection test. Real providers need live keys; here we validate
 *  that the gateway is configured enough to attempt a call. */
export async function testConnection(gid: string): Promise<{ ok: boolean; message: string }> {
  const g = await getGateway(gid);
  if (!g) return { ok: false, message: 'درگاه یافت نشد.' };
  /* Card-to-card has no key to check and no endpoint to reach: what makes it
   * ready is a destination card. Answered BEFORE the sandbox branch, or a
   * gateway left on the default «test» flag would report itself fine while
   * there is nowhere for a player to send money. */
  if (g.type === 'card_to_card') {
    const { listCards } = await import('./c2c/cardService.js');
    const active = (await listCards()).filter((c) => c.status === 'ACTIVE');
    if (!active.length) {
      return { ok: false, message: 'هیچ کارت مقصد فعالی تعریف نشده است؛ از تب «کارت‌های مقصد» یکی اضافه کن.' };
    }
    const floor = Math.min(...active.map((c) => c.minAmountToman));
    return { ok: true, message: `${active.length.toLocaleString('fa-IR')} کارت مقصد فعال است؛ خرید باید بیشتر از ${floor.toLocaleString('fa-IR')} تومان باشد.` };
  }
  if (g.sandbox || g.type === 'sandbox') return { ok: true, message: 'درگاه تست آماده است (بدون تراکنش واقعی).' };
  if (!g.apiKey && !g.merchantId) return { ok: false, message: 'کلید/مرچنت درگاه تنظیم نشده است.' };
  return { ok: true, message: 'اطلاعات اتصال کامل است؛ تراکنش واقعی هنگام پرداخت انجام می‌شود.' };
}

// ---- per-gateway reports (from payment_intents metadata) ----
export async function gatewayReports(): Promise<Array<{ gatewayId: string; name: string; type: string; total: number; paid: number; failed: number; pending: number; successRate: number; paidAmount: number }>> {
  const { repositories } = await import('../repositories/index.js');
  const intents = await repositories.payments.list({ limit: 2000 });
  const gws = await listGateways();
  const byId = new Map(gws.map((g) => [g.id, g] as const));
  const agg = new Map<string, { total: number; paid: number; failed: number; pending: number; paidAmount: number }>();
  for (const it of intents) {
    const gid = String((it.metadata as any)?.gatewayId || it.provider || 'unknown');
    const a = agg.get(gid) || { total: 0, paid: 0, failed: 0, pending: 0, paidAmount: 0 };
    a.total++;
    if (it.status === 'paid') { a.paid++; a.paidAmount += it.amount; }
    else if (it.status === 'failed' || it.status === 'expired') a.failed++;
    else a.pending++;
    agg.set(gid, a);
  }
  // Ensure every configured gateway shows, even with zero traffic.
  for (const g of gws) if (!agg.has(g.id)) agg.set(g.id, { total: 0, paid: 0, failed: 0, pending: 0, paidAmount: 0 });
  return [...agg.entries()].map(([gid, a]) => {
    const g = byId.get(gid);
    const attempted = a.paid + a.failed;
    return { gatewayId: gid, name: g?.name || gid, type: g?.type || '—', total: a.total, paid: a.paid, failed: a.failed, pending: a.pending, successRate: attempted ? Math.round((a.paid / attempted) * 100) : 0, paidAmount: a.paidAmount };
  }).sort((x, y) => y.paidAmount - x.paidAmount);
}
