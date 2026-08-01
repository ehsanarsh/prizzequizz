/* SMS PANEL — provider-agnostic SMS/OTP subsystem, fully admin-managed.
 *
 * One config row picks the active provider + credentials + sender line and can
 * run in sandbox (no real send). Templates carry {name}/{code}/{amount}/{wallet}
 * /{date} variables. Every send is logged (status, provider ref, cost, error).
 * OTP has its own rate-limit/expiry policy and request log to stop abuse. A
 * blacklist blocks numbers, and pending messages form a queue that can be
 * cancelled or resent. Postgres-backed with an in-memory fallback. */
import { getPgPool } from '../database/postgres.js';
import { id } from '../utils/id.js';
import { logger } from './logger.js';

export type SmsProvider = 'sandbox' | 'niazpardaz' | 'kavenegar' | 'melipayamak' | 'farazsms' | 'generic';
export interface SmsConfig {
  enabled: boolean;
  sandbox: boolean;
  provider: SmsProvider;
  apiKey: string;
  secret: string;
  sender: string;              // sender line / number
  genericUrl?: string;         // for 'generic' provider: a GET/POST endpoint template
  /* When the panel is off or in sandbox nothing is really sent, so the login
   * code has to be something a tester can actually type. Kept in config rather
   * than in the code so it can be changed without a deploy — and so it is
   * obvious at a glance whether the site is live or in test mode. */
  otp: { maxPerHour: number; expirySeconds: number; minIntervalSeconds: number; testCode: string };
}
export const SMS_DEFAULT_CONFIG: SmsConfig = {
  enabled: false, sandbox: true, provider: 'sandbox', apiKey: '', secret: '', sender: '',
  otp: { maxPerHour: 5, expirySeconds: 120, minIntervalSeconds: 60, testCode: '1234' }
};

export interface SmsTemplate { key: string; title: string; text: string; }
export const SMS_DEFAULT_TEMPLATES: SmsTemplate[] = [
  { key: 'signup_code', title: 'کد تأیید ثبت‌نام', text: 'پرایز کوییز\nکد تأیید ثبت‌نام شما: {code}' },
  { key: 'login_code', title: 'کد ورود', text: 'پرایز کوییز\nکد ورود شما: {code}' },
  { key: 'password_change', title: 'تغییر رمز', text: 'پرایز کوییز\nرمز حساب شما تغییر کرد. اگر شما نبودید با پشتیبانی تماس بگیرید.' },
  { key: 'deposit_ok', title: 'واریز موفق', text: '{name} عزیز، مبلغ {amount} تومان به کیف پول شما واریز شد. موجودی: {wallet}' },
  { key: 'withdraw_ok', title: 'برداشت موفق', text: '{name} عزیز، برداشت {amount} تومان شما پرداخت شد. تاریخ: {date}' },
  { key: 'withdraw_rejected', title: 'برداشت رد شد', text: '{name} عزیز، درخواست برداشت {amount} تومان شما رد شد. مبلغ به کیف پول بازگشت.' },
  { key: 'match_win', title: 'برد در مسابقه', text: 'تبریک {name}! تو {amount} تومان جایزه بردی 🏆' },
  { key: 'invite', title: 'دعوت دوستان', text: 'با کد دعوت من در پرایز کوییز ثبت‌نام کن و هدیه بگیر: {code}' },
  { key: 'welcome', title: 'خوش‌آمدگویی', text: '{name} عزیز، به پرایز کوییز خوش آمدی! 🎉' },
  { key: 'promo', title: 'پیام تبلیغاتی', text: '{name} عزیز، {code}' }
];

export type SmsStatus = 'pending' | 'sent' | 'failed' | 'blocked' | 'disabled';
export interface SmsLogEntry { id: string; to: string; templateKey: string | null; body: string; status: SmsStatus; providerRef: string | null; cost: number; error: string | null; createdAt: string; }

function pg(): ReturnType<typeof getPgPool> | null { try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; } }

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS sms_config (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sms_templates (key TEXT PRIMARY KEY, title TEXT NOT NULL, text TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sms_log (id TEXT PRIMARY KEY, recipient TEXT NOT NULL, template_key TEXT, body TEXT NOT NULL, status TEXT NOT NULL, provider_ref TEXT, cost BIGINT NOT NULL DEFAULT 0, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sms_log_time ON sms_log(created_at DESC)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sms_blacklist (number TEXT PRIMARY KEY, reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sms_otp_log (id TEXT PRIMARY KEY, recipient TEXT NOT NULL, purpose TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sms_otp_recipient ON sms_otp_log(recipient, created_at DESC)`);
  _schemaReady = true;
}

// ---- memory fallback ----
let _memCfg: SmsConfig | null = null;
const _memTpl: SmsTemplate[] = [];
const _memLog: SmsLogEntry[] = [];
const _memBlack = new Map<string, { number: string; reason?: string; createdAt: string }>();
const _memOtp: Array<{ recipient: string; purpose?: string; createdAt: number }> = [];

function deepMerge<T>(base: T, patch: any): T {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) return (patch ?? base) as T;
  const out: any = { ...(base as any) };
  for (const k of Object.keys(patch)) { const bv = (base as any)?.[k]; const pv = patch[k]; out[k] = (bv && typeof bv === 'object' && pv && typeof pv === 'object' && !Array.isArray(bv)) ? deepMerge(bv, pv) : pv; }
  return out;
}
export function withSmsDefaults(p: any): SmsConfig { return deepMerge(SMS_DEFAULT_CONFIG, p || {}); }

// ---- config ----
export async function getSmsConfig(): Promise<SmsConfig> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); const { rows } = await pool.query(`SELECT data FROM sms_config WHERE id='default'`); if (!rows[0]) { await pool.query(`INSERT INTO sms_config(id,data) VALUES('default',$1) ON CONFLICT DO NOTHING`, [JSON.stringify(SMS_DEFAULT_CONFIG)]); return SMS_DEFAULT_CONFIG; } return withSmsDefaults(rows[0].data); }
  if (!_memCfg) _memCfg = withSmsDefaults({});
  return _memCfg;
}
export async function updateSmsConfig(patch: Partial<SmsConfig>): Promise<SmsConfig> {
  const next = deepMerge(await getSmsConfig(), patch);
  const pool = pg();
  if (pool) { await ensureSchema(pool); await pool.query(`INSERT INTO sms_config(id,data,updated_at) VALUES('default',$1,now()) ON CONFLICT (id) DO UPDATE SET data=$1, updated_at=now()`, [JSON.stringify(next)]); }
  else _memCfg = next;
  return next;
}
/** True only when a message would really leave the building. Everything else —
 *  panel off, sandbox on, provider still 'sandbox' — is test mode, and the OTP
 *  falls back to the fixed test code so nobody is locked out. */
export function smsIsLive(c: SmsConfig): boolean {
  return !!c.enabled && !c.sandbox && c.provider !== 'sandbox';
}

// Never leak secrets wholesale to the panel — mask them.
export function maskConfig(c: SmsConfig): SmsConfig & { apiKeySet: boolean; secretSet: boolean } {
  return { ...c, apiKey: c.apiKey ? '••••' + c.apiKey.slice(-4) : '', secret: c.secret ? '••••' : '', apiKeySet: !!c.apiKey, secretSet: !!c.secret };
}

// ---- templates ----
export async function listTemplates(): Promise<SmsTemplate[]> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); let { rows } = await pool.query(`SELECT key,title,text FROM sms_templates ORDER BY key`); if (!rows.length) { for (const t of SMS_DEFAULT_TEMPLATES) await pool.query(`INSERT INTO sms_templates(key,title,text) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [t.key, t.title, t.text]); rows = (await pool.query(`SELECT key,title,text FROM sms_templates ORDER BY key`)).rows; } return rows as SmsTemplate[]; }
  if (!_memTpl.length) _memTpl.push(...SMS_DEFAULT_TEMPLATES.map((t) => ({ ...t })));
  return _memTpl.slice();
}
export async function saveTemplate(t: SmsTemplate): Promise<void> {
  const key = String(t.key).trim(); if (!key) throw new Error('KEY_REQUIRED');
  const pool = pg();
  if (pool) { await ensureSchema(pool); await pool.query(`INSERT INTO sms_templates(key,title,text,updated_at) VALUES($1,$2,$3,now()) ON CONFLICT (key) DO UPDATE SET title=$2,text=$3,updated_at=now()`, [key, t.title || key, t.text || '']); }
  else { const i = _memTpl.findIndex((x) => x.key === key); if (i >= 0) _memTpl[i] = { key, title: t.title || key, text: t.text || '' }; else _memTpl.push({ key, title: t.title || key, text: t.text || '' }); }
}
export async function removeTemplate(key: string): Promise<void> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); await pool.query(`DELETE FROM sms_templates WHERE key=$1`, [key]); }
  else { const i = _memTpl.findIndex((x) => x.key === key); if (i >= 0) _memTpl.splice(i, 1); }
}
export function renderTemplate(text: string, vars: Record<string, string | number> = {}): string {
  return String(text).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}

// ---- blacklist ----
export async function listBlacklist(): Promise<Array<{ number: string; reason?: string; createdAt: string }>> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); const { rows } = await pool.query(`SELECT number,reason,created_at FROM sms_blacklist ORDER BY created_at DESC`); return rows.map((r: any) => ({ number: r.number, reason: r.reason ?? undefined, createdAt: r.created_at?.toISOString?.() ?? String(r.created_at) })); }
  return [..._memBlack.values()];
}
export async function addBlacklist(number: string, reason?: string): Promise<void> {
  const n = normalize(number); const pool = pg();
  if (pool) { await ensureSchema(pool); await pool.query(`INSERT INTO sms_blacklist(number,reason) VALUES($1,$2) ON CONFLICT (number) DO UPDATE SET reason=$2`, [n, reason ?? null]); }
  else _memBlack.set(n, { number: n, reason, createdAt: new Date().toISOString() });
}
export async function removeBlacklist(number: string): Promise<void> {
  const n = normalize(number); const pool = pg();
  if (pool) { await ensureSchema(pool); await pool.query(`DELETE FROM sms_blacklist WHERE number=$1`, [n]); }
  else _memBlack.delete(n);
}
async function isBlacklisted(number: string): Promise<boolean> {
  const n = normalize(number); const pool = pg();
  if (pool) { const { rows } = await pool.query(`SELECT 1 FROM sms_blacklist WHERE number=$1`, [n]); return !!rows[0]; }
  return _memBlack.has(n);
}
function normalize(n: string): string { return String(n).replace(/[^\d+]/g, ''); }

// ---- log ----
async function writeLog(e: SmsLogEntry): Promise<void> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); await pool.query(`INSERT INTO sms_log(id,recipient,template_key,body,status,provider_ref,cost,error,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [e.id, e.to, e.templateKey, e.body, e.status, e.providerRef, e.cost, e.error, e.createdAt]); }
  else _memLog.unshift(e);
}
export async function updateLogStatus(logId: string, status: SmsStatus, providerRef?: string | null, error?: string | null): Promise<void> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); await pool.query(`UPDATE sms_log SET status=$2, provider_ref=coalesce($3,provider_ref), error=$4 WHERE id=$1`, [logId, status, providerRef ?? null, error ?? null]); }
  else { const e = _memLog.find((x) => x.id === logId); if (e) { e.status = status; if (providerRef) e.providerRef = providerRef; e.error = error ?? null; } }
}
export async function listLog(filter: { status?: string; recipient?: string; limit?: number } = {}): Promise<SmsLogEntry[]> {
  const pool = pg();
  const limit = Math.min(500, Math.max(1, Number(filter.limit ?? 100)));
  if (pool) {
    await ensureSchema(pool);
    const cl: string[] = []; const args: any[] = [];
    if (filter.status) { args.push(filter.status); cl.push(`status=$${args.length}`); }
    if (filter.recipient) { args.push('%' + normalize(filter.recipient) + '%'); cl.push(`recipient LIKE $${args.length}`); }
    args.push(limit);
    const where = cl.length ? 'WHERE ' + cl.join(' AND ') : '';
    const { rows } = await pool.query(`SELECT * FROM sms_log ${where} ORDER BY created_at DESC LIMIT $${args.length}`, args);
    return rows.map(logRow);
  }
  let rows = _memLog.slice();
  if (filter.status) rows = rows.filter((r) => r.status === filter.status);
  if (filter.recipient) rows = rows.filter((r) => r.to.includes(normalize(filter.recipient!)));
  return rows.slice(0, limit);
}
function logRow(r: any): SmsLogEntry { return { id: r.id, to: r.recipient, templateKey: r.template_key ?? null, body: r.body, status: r.status, providerRef: r.provider_ref ?? null, cost: Number(r.cost || 0), error: r.error ?? null, createdAt: r.created_at?.toISOString?.() ?? String(r.created_at) }; }

export async function smsStats(): Promise<{ today: number; week: number; month: number; totalCost: number; successRate: number; byStatus: Record<string, number> }> {
  const rows = await listLog({ limit: 500 });
  const now = Date.now(); const day = 86400000;
  const inRange = (r: SmsLogEntry, ms: number) => now - new Date(r.createdAt).getTime() <= ms;
  const sent = rows.filter((r) => r.status === 'sent').length;
  const attempted = rows.filter((r) => r.status === 'sent' || r.status === 'failed').length;
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  return {
    today: rows.filter((r) => inRange(r, day)).length,
    week: rows.filter((r) => inRange(r, 7 * day)).length,
    month: rows.filter((r) => inRange(r, 30 * day)).length,
    totalCost: rows.reduce((s, r) => s + r.cost, 0),
    successRate: attempted ? Math.round((sent / attempted) * 100) : 0,
    byStatus
  };
}

/* ---- Niazpardaz -----------------------------------------------------------
 * REST panel at login.niazpardaz.ir. Authentication is a single X-API-Key
 * header; every call is a POST with a JSON body and answers
 *   { success, errorMessage, result: { resultCode, ... } }
 * where a resultCode of 0 is the only success. The codes are worth translating
 * rather than logging as numbers: "اعتبار کافی نیست" and "خط فرستنده غیرفعال
 * است" are two very different problems, and the SMS log is where whoever is on
 * support will look first. */
export const NIAZPARDAZ_BASE = 'https://login.niazpardaz.ir/api/v2/RestWebApi';
const NIAZ_SEND_ERRORS: Record<number, string> = {
  1: 'نام کاربری یا کلمه عبور نامعتبر است.',
  2: 'کاربر مسدود شده است.',
  3: 'شماره فرستنده نامعتبر است.',
  4: 'محدودیت در ارسال روزانه.',
  5: 'تعداد گیرندگان حداکثر ۱۰۰۰ شماره است.',
  6: 'خط فرستنده غیرفعال است.',
  7: 'متن پیامک شامل کلمات فیلترشده است.',
  8: 'اعتبار پنل کافی نیست.',
  9: 'سامانه در حال بروزرسانی است.',
  10: 'وب‌سرویس غیرفعال است.',
  11: 'این قابلیت پیاده‌سازی نشده است.',
  12: 'تعداد پیام‌ها و شماره‌ها باید یکسان باشد.',
  13: 'تعداد پیام‌ها حداکثر ۱۰۰ پیام است.',
  14: 'تعرفه‌ای برای این کاربر تعریف نشده است.',
  15: 'ارسال تکراری همین متن به همین شماره در بازه کوتاه.',
  16: 'شماره گیرنده نامعتبر یا در لیست سیاه است.',
  17: 'متن پیامک وارد نشده است.',
  18: 'متن مطابق الگوی تعریف‌شده نیست.',
  19: 'حساب کاربری منقضی شده است.',
  20: 'وضعیت کاربر فعال نیست.',
  21: 'یکی از پارامترهای ورودی معتبر نیست.',
  22: 'آی‌پی سرور موقتاً بلاک شده است.',
  23: 'عملیات با خطا مواجه شد؛ دقایقی بعد دوباره تلاش کنید.',
  24: 'درخواست کاملاً تکراری در چند ثانیه گذشته.',
  25: 'کلید API نامعتبر است.',
  26: 'خطا در ساخت فایل صوتی.'
};
const NIAZ_ACCOUNT_ERRORS: Record<number, string> = {
  [-1]: 'نام کاربری یا رمز عبور صحیح نیست.',
  [-2]: 'کاربر غیرفعال است.',
  [-6]: 'آی‌پی سرور موقتاً بلاک شده است.',
  [-7]: 'کلید API نامعتبر است.'
};

async function niazpardazPost(cfg: SmsConfig, endpoint: string, payload: unknown, timeoutMs = 20_000): Promise<any> {
  const base = (cfg.genericUrl || NIAZPARDAZ_BASE).replace(/\/+$/, '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(base + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': cfg.apiKey },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    const text = await r.text();
    if (!r.ok) throw new Error('پاسخ سرور نیازپرداز: HTTP ' + r.status);
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { throw new Error('پاسخ نامعتبر از سرور نیازپرداز.'); }
    if (!parsed?.success) throw new Error(parsed?.errorMessage || 'خطای نامشخص از سرور نیازپرداز.');
    return parsed.result;
  } finally { clearTimeout(t); }
}

/** Panel credit and the sender lines this key may send from — what the admin
 *  needs to see to know whether the key is really wired up.
 *
 *  The two calls are judged separately on purpose. GetCredit answering is what
 *  proves the key and the route to the provider are good; GetSenderNumbers is a
 *  convenience that some accounts simply cannot answer — a real key returns
 *  "Sequence contains no elements" from it while sending perfectly well. Letting
 *  that failure mark the whole check as broken would send someone hunting a
 *  problem they do not have. */
export async function niazpardazAccount(cfgIn?: SmsConfig): Promise<{ credit: number | null; senders: string[]; error?: string; sendersError?: string }> {
  const cfg = cfgIn ?? await getSmsConfig();
  if (!cfg.apiKey) return { credit: null, senders: [], error: 'کلید API وارد نشده است.' };
  try {
    const [credit, senders] = await Promise.all([
      niazpardazPost(cfg, '/GetCredit', {}).catch((e) => ({ _err: (e as Error).message })),
      niazpardazPost(cfg, '/GetSenderNumbers', {}).catch((e) => ({ _err: (e as Error).message }))
    ]);
    const cErr = credit?._err || NIAZ_ACCOUNT_ERRORS[Number(credit?.resultCode)];
    const sErr = senders?._err || NIAZ_ACCOUNT_ERRORS[Number(senders?.resultCode)];
    return {
      credit: cErr ? null : Number(credit?.credit ?? 0),
      senders: sErr ? [] : (Array.isArray(senders?.senders) ? senders.senders.map(String) : []),
      error: cErr || undefined,
      sendersError: sErr || undefined
    };
  } catch (e) { return { credit: null, senders: [], error: (e as Error).message }; }
}

// ---- provider dispatch ----
async function dispatch(cfg: SmsConfig, to: string, body: string): Promise<{ ok: boolean; ref?: string; cost?: number; error?: string }> {
  if (cfg.sandbox || cfg.provider === 'sandbox') return { ok: true, ref: 'sandbox-' + id().slice(0, 8), cost: 0 };
  try {
    if (cfg.provider === 'niazpardaz') {
      if (!cfg.apiKey) return { ok: false, error: 'کلید API نیازپرداز تنظیم نشده است.' };
      if (!cfg.sender) return { ok: false, error: 'شماره فرستنده تنظیم نشده است.' };
      const res = await niazpardazPost(cfg, '/SendBatchSms', {
        fromNumber: cfg.sender,
        messageContent: body,
        toNumbers: to,
        isFlash: false
      });
      const code = Number(res?.resultCode);
      if (code === 0) return { ok: true, ref: String(res?.batchSmsId ?? '') };
      return { ok: false, error: NIAZ_SEND_ERRORS[code] || ('کد خطای نیازپرداز: ' + code) };
    }
    if (cfg.provider === 'kavenegar') {
      const url = `https://api.kavenegar.com/v1/${encodeURIComponent(cfg.apiKey)}/sms/send.json?receptor=${encodeURIComponent(to)}&sender=${encodeURIComponent(cfg.sender)}&message=${encodeURIComponent(body)}`;
      const r = await fetch(url); const j: any = await r.json().catch(() => ({}));
      if (r.ok && j?.return?.status === 200) return { ok: true, ref: String(j?.entries?.[0]?.messageid ?? ''), cost: Number(j?.entries?.[0]?.cost ?? 0) };
      return { ok: false, error: j?.return?.message || ('HTTP ' + r.status) };
    }
    if (cfg.provider === 'melipayamak') {
      const r = await fetch('https://rest.payamak-panel.com/api/SendSMS/SendSMS', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: cfg.apiKey, password: cfg.secret, to, from: cfg.sender, text: body }) });
      const j: any = await r.json().catch(() => ({}));
      if (r.ok && (j?.RetStatus === 1 || j?.Value)) return { ok: true, ref: String(j?.Value ?? '') };
      return { ok: false, error: j?.StrRetStatus || ('HTTP ' + r.status) };
    }
    if (cfg.provider === 'farazsms' || cfg.provider === 'generic') {
      const base = cfg.genericUrl || 'https://ippanel.com/api/select';
      const r = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'send', uname: cfg.apiKey, pass: cfg.secret, from: cfg.sender, to: [to], message: body }) });
      const j: any = await r.json().catch(() => ({}));
      if (r.ok) return { ok: true, ref: String(Array.isArray(j) ? j[0] : (j?.value ?? '')) };
      return { ok: false, error: 'HTTP ' + r.status };
    }
    return { ok: false, error: 'UNKNOWN_PROVIDER' };
  } catch (e) { return { ok: false, error: (e as Error).message || 'send_failed' }; }
}

/** Send an arbitrary SMS (logged). Returns the log entry. */
export async function sendSms(to: string, body: string, templateKey: string | null = null): Promise<SmsLogEntry> {
  const cfg = await getSmsConfig();
  const recipient = normalize(to);
  const entry: SmsLogEntry = { id: id(), to: recipient, templateKey, body, status: 'pending', providerRef: null, cost: 0, error: null, createdAt: new Date().toISOString() };
  if (await isBlacklisted(recipient)) { entry.status = 'blocked'; entry.error = 'blacklisted'; await writeLog(entry); return entry; }
  if (!cfg.enabled) { entry.status = 'disabled'; entry.error = 'sms_disabled'; await writeLog(entry); return entry; }
  await writeLog(entry);
  const res = await dispatch(cfg, recipient, body);
  entry.status = res.ok ? 'sent' : 'failed'; entry.providerRef = res.ref ?? null; entry.cost = res.cost ?? 0; entry.error = res.error ?? null;
  await updateLogStatus(entry.id, entry.status, entry.providerRef, entry.error);
  if (!res.ok) logger.warn('sms_send_failed', { to: recipient, provider: cfg.provider, error: res.error });
  return entry;
}

export async function sendTemplate(to: string, key: string, vars: Record<string, string | number> = {}): Promise<SmsLogEntry> {
  const tpls = await listTemplates();
  const t = tpls.find((x) => x.key === key);
  if (!t) throw new Error('TEMPLATE_NOT_FOUND');
  return sendSms(to, renderTemplate(t.text, vars), key);
}

export async function resend(logId: string): Promise<SmsLogEntry | null> {
  const rows = await listLog({ limit: 500 });
  const e = rows.find((r) => r.id === logId);
  if (!e) return null;
  return sendSms(e.to, e.body, e.templateKey);
}
export async function cancelPending(logId: string): Promise<boolean> {
  await updateLogStatus(logId, 'failed', null, 'cancelled_by_admin');
  return true;
}

// ---- OTP with rate-limit + expiry policy ----
export async function otpAllowed(recipient: string): Promise<{ allowed: boolean; reason?: string }> {
  const cfg = await getSmsConfig(); const r = normalize(recipient); const now = Date.now();
  const times = await otpTimes(r);
  const withinHour = times.filter((t) => now - t <= 3600_000);
  if (withinHour.length >= cfg.otp.maxPerHour) return { allowed: false, reason: 'RATE_LIMIT_HOUR' };
  const last = times[0];
  if (last != null && now - last < cfg.otp.minIntervalSeconds * 1000) return { allowed: false, reason: 'TOO_SOON' };
  return { allowed: true };
}
async function otpTimes(recipient: string): Promise<number[]> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); const { rows } = await pool.query(`SELECT created_at FROM sms_otp_log WHERE recipient=$1 ORDER BY created_at DESC LIMIT 20`, [recipient]); return rows.map((x: any) => new Date(x.created_at).getTime()); }
  return _memOtp.filter((x) => x.recipient === recipient).map((x) => x.createdAt).sort((a, b) => b - a);
}
async function recordOtp(recipient: string, purpose: string): Promise<void> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); await pool.query(`INSERT INTO sms_otp_log(id,recipient,purpose) VALUES($1,$2,$3)`, [id(), recipient, purpose]); }
  else _memOtp.unshift({ recipient, purpose, createdAt: Date.now() });
}
/** Send an OTP code respecting the admin's rate-limit/expiry policy. */
export async function sendOtp(recipient: string, code: string, purpose = 'login', templateKey = 'login_code'): Promise<{ sent: boolean; reason?: string; log?: SmsLogEntry }> {
  const gate = await otpAllowed(recipient);
  if (!gate.allowed) return { sent: false, reason: gate.reason };
  const log = await sendTemplate(recipient, templateKey, { code });
  const sent = log.status === 'sent' || log.status === 'disabled';
  /* Counted only once a message really went out. Recording first meant a run of
   * provider failures — a wrong sender line, an empty account — locked the
   * player out for an hour over messages they never received, which is exactly
   * when they are most likely to keep trying. */
  if (sent) await recordOtp(normalize(recipient), purpose);
  return { sent, log };
}
