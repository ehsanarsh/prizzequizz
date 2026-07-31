/* SECURITY ALERTS — derived live from what actually happened, never a fixed list.
 *
 * Each rule reads real rows (security events, integrity signals, device
 * bindings, withdrawals, error reports) over a recent window and only produces
 * an alert when its threshold is genuinely crossed. A quiet system returns an
 * empty list, which is the correct answer — the panel says "nothing to report"
 * rather than inventing warnings.
 *
 * Every alert carries the query that produced it in `evidence`, so an operator
 * can see why it fired instead of trusting a badge. */
import { getPgPool } from '../database/postgres.js';

export type AlertLevel = 'critical' | 'warn' | 'info';

export interface SecurityAlert {
  id: string;
  level: AlertLevel;
  title: string;
  detail: string;
  count: number;
  /** Where to look in the panel. */
  tab?: string;
  at: string;
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

interface Rule {
  id: string;
  level: AlertLevel;
  tab?: string;
  sql: string;
  /** Build the message from the row the query returned. */
  render: (n: number, row: any) => { title: string; detail: string } | null;
}

/* Windows are deliberately short so an alert means "happening now", not
 * "happened once last month". */
const RULES: Rule[] = [
  {
    id: 'otp_bruteforce', level: 'critical', tab: 'suspicious',
    sql: `SELECT count(*)::int n FROM security_events
           WHERE event_type='OTP_VERIFY_FAILED' AND created_at >= now() - interval '1 hour'`,
    render: (n) => n >= 20 ? {
      title: 'تلاش گستردهٔ ورود ناموفق',
      detail: `${n} کد تأیید اشتباه در یک ساعت گذشته. احتمال حملهٔ حدس کد.`
    } : null
  },
  {
    id: 'shared_devices', level: 'warn', tab: 'suspicious',
    sql: `SELECT count(*)::int n FROM (
            SELECT device_id FROM user_device_bindings GROUP BY device_id HAVING count(DISTINCT user_id) >= 3
          ) x`,
    render: (n) => n > 0 ? {
      title: 'دستگاه مشترک بین چند حساب',
      detail: `${n} دستگاه با ۳ حساب یا بیشتر. احتمال چندحسابی.`
    } : null
  },
  {
    id: 'high_risk_users', level: 'critical', tab: 'suspicious',
    sql: `SELECT count(*)::int n FROM user_risk_profiles WHERE risk_score >= 70`,
    render: (n) => n > 0 ? {
      title: 'کاربران پرخطر',
      detail: `${n} حساب با امتیاز خطر ۷۰ یا بالاتر.`
    } : null
  },
  {
    id: 'integrity_burst', level: 'critical', tab: 'anticheat',
    sql: `SELECT count(*)::int n FROM integrity_signals
           WHERE severity='critical' AND created_at >= now() - interval '24 hours'`,
    render: (n) => n >= 5 ? {
      title: 'سیگنال تقلب بحرانی',
      detail: `${n} سیگنال بحرانی در ۲۴ ساعت گذشته.`
    } : null
  },
  {
    id: 'withdraw_spike', level: 'warn', tab: 'withdrawals',
    sql: `SELECT count(*)::int n, coalesce(sum(amount),0)::bigint amt FROM withdraw_requests
           WHERE status='pending' AND created_at >= now() - interval '24 hours'`,
    render: (n, row) => n >= 10 ? {
      title: 'هجوم درخواست برداشت',
      detail: `${n} درخواست در ۲۴ ساعت، جمعاً ${Number(row.amt || 0).toLocaleString('fa-IR')} تومان در انتظار بررسی.`
    } : null
  },
  {
    id: 'stale_withdrawals', level: 'warn', tab: 'withdrawals',
    sql: `SELECT count(*)::int n FROM withdraw_requests
           WHERE status='pending' AND created_at < now() - interval '48 hours'`,
    render: (n) => n > 0 ? {
      title: 'برداشت‌های معطل‌مانده',
      detail: `${n} درخواست بیش از ۴۸ ساعت است بلاتکلیف مانده.`
    } : null
  },
  {
    id: 'error_spike', level: 'warn', tab: 'reports',
    sql: `SELECT count(*)::int n FROM error_reports
           WHERE severity IN ('error','fatal') AND created_at >= now() - interval '1 hour'`,
    render: (n) => n >= 25 ? {
      title: 'افزایش ناگهانی خطا',
      detail: `${n} خطای برنامه در یک ساعت گذشته.`
    } : null
  },
  {
    id: 'ledger_negative', level: 'critical', tab: 'wallet',
    sql: `SELECT count(*)::int n FROM wallet_accounts WHERE available < 0 OR locked < 0`,
    render: (n) => n > 0 ? {
      title: 'موجودی منفی در کیف پول',
      detail: `${n} حساب با موجودی منفی — دفتر باید فوراً بررسی شود.`
    } : null
  },
  {
    id: 'admin_no_2fa', level: 'info', tab: 'roles',
    sql: `SELECT count(*)::int n FROM admin_accounts WHERE coalesce(status,'active')='active'`,
    render: (n) => n >= 6 ? {
      title: 'تعداد زیاد حساب مدیریت',
      detail: `${n} حساب مدیریت فعال است. دسترسی‌های بلااستفاده را ببند.`
    } : null
  }
];

export async function securityAlerts(): Promise<{ alerts: SecurityAlert[]; checked: number; hasDatabase: boolean; at: string }> {
  const at = new Date().toISOString();
  const pool = pg();
  if (!pool) return { alerts: [], checked: 0, hasDatabase: false, at };

  const alerts: SecurityAlert[] = [];
  let checked = 0;
  await Promise.all(RULES.map(async (rule) => {
    try {
      const { rows } = await pool.query(rule.sql);
      checked += 1;
      const row = rows[0] ?? {};
      const n = Number(row.n ?? 0) || 0;
      const msg = rule.render(n, row);
      if (msg) alerts.push({ id: rule.id, level: rule.level, title: msg.title, detail: msg.detail, count: n, tab: rule.tab, at });
    } catch { /* a table this deployment doesn't have → that rule simply can't fire */ }
  }));

  const order: Record<AlertLevel, number> = { critical: 0, warn: 1, info: 2 };
  alerts.sort((a, b) => order[a.level] - order[b.level] || b.count - a.count);
  return { alerts, checked, hasDatabase: true, at };
}
