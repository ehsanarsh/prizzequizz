/* THE USERS SCREEN, SORTED BY ANYTHING THAT MATTERS.
 *
 * «باید تعداد بلیط‌های کاربر رو ببینم… بتونم sort کنم طبق کیف پول، طبق بلیط سبز
 *  و آبی و قرمز، طبق بیشترین خرید، طبق تعداد برد و باخت، و هر موضوع کیا خوب
 *  زدن — یعنی موضوع فوتبال رو انتخاب کنم، sort کنه نسبت به اون موضوع.»
 *
 * The old list read a page of users and then filled each row in. That cannot be
 * sorted by any of the above: «the hundred most recent accounts, ordered by
 * wallet» is not «the hundred richest accounts», and on a table of any size the
 * two have almost nobody in common. So the ordering has to happen in the
 * DATABASE, over every row, before the page is cut — which means the totals
 * have to be there too, in the same query.
 *
 * One statement, one pass. Asking per row is what turns a hundred-row page into
 * three hundred queries.
 */
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';
import { getTicketPrices } from './economyConfig.js';
import { searchAdminUsers, type AdminUserListItem } from './adminUserService.js';
import { avatarUrlsFor } from './avatarService.js';
import { looksLikePhone, phoneKey } from '../utils/phone.js';

function pg() { try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; } }

/** The ticket tiers this game actually has, whatever the operator named them. */
export function ticketTiers(): string[] {
  try { return Object.keys(getTicketPrices() ?? {}); } catch { return ['green', 'blue', 'red']; }
}

/* THE ONE RULE, so the SQL and the in-memory fallback cannot drift apart and
   report different people as unfinished on two different servers. */
export function unfinishedOf(displayName: unknown, username: unknown): boolean {
  const dn = String(displayName ?? '').trim();
  const un = String(username ?? '').trim();
  return dn === '' || dn === 'بازیکن جدید' || /^user_[0-9]+$/.test(un);
}

export interface AdminUserRow extends AdminUserListItem {
  /** When the account was opened — the list marks the ones that are new. */
  createdAt?: number;
  tickets: Record<string, number>;
  ticketTotal: number;
  /** Money actually spent — cash leaving the player, not coins. */
  spent: number;
  played: number;
  wins: number;
  losses: number;
  /** Percent, 0-100. Zero games is 0, not «undefined disguised as bad». */
  winRate: number;
  /* A SIGN-UP THAT NEVER FINISHED IS NOT A PLAYER.
     An account exists from the moment the SMS code is verified — BEFORE a name
     is ever asked for — so anyone who gets a code and closes the app leaves a
     row behind for ever. Ten of them were sitting in the live list among real
     players, indistinguishable, called «بازیکن جدید». They are not a mistake
     and they are not people: they are half-open doors, and the list should say
     so rather than making an operator work it out from the name. */
  unfinished: boolean;
  /** Only filled when a topic was asked for. */
  topicTotal?: number;
  topicCorrect?: number;
  topicRate?: number;
}

/* WHAT MAY BE SORTED BY, AND THE SQL FOR EACH.
 *
 * A whitelist rather than a column name from the request: everything here is
 * interpolated into the statement, so the list IS the safety. `tier` and
 * `topic` arrive as values and are checked or parameterised separately. */
const SORTS: Record<string, string> = {
  recent: 'u.updated_at',
  username: 'lower(u.username)',
  level: 'u.level',
  xp: 'u.xp',
  wallet: 'u.wallet_balance',
  coins: 'u.coins',
  spent: 'spent',
  played: 'played',
  wins: 'wins',
  losses: 'losses',
  winRate: 'win_rate',
  tickets: 'ticket_total',
  ticket: 'ticket_one',
  topic: 'topic_rate',
  invited: 'invited'
};
export const USER_SORT_KEYS = Object.keys(SORTS);

/* WHO THE SEARCH BOX FINDS — the same rule the plain list uses, so «who is
 * ۰۹۱۲…» finds the same person on both screens. The phone column is compared on
 * its DIGITS against the last ten of what was typed: +98912…, 0912… and ۰۹۱۲…
 * are one number, and an operator reading one off a support ticket should not
 * have to guess which spelling was stored. */
function searchSql(q: string, p: (v: unknown) => string): string {
  if (!q) return '';
  const like = p('%' + q.replace(/[%_\\]/g, (c) => '\\' + c) + '%');
  const key = p(looksLikePhone(q) ? phoneKey(q) : '');
  return `WHERE (u.id::text ILIKE ${like} OR u.username ILIKE ${like}
                 OR u.display_name ILIKE ${like} OR u.phone ILIKE ${like}
                 OR (${key} <> '' AND regexp_replace(coalesce(u.phone,''), '\\D', '', 'g') LIKE '%' || ${key}))`;
}

export interface UserTableQuery {
  query?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  /** Which ticket tier, when sorting by `ticket`. */
  tier?: string;
  /** Which category, when sorting by `topic` — also fills the topic columns. */
  topic?: string;
  limit?: number;
  offset?: number;
}

export interface UserTablePage { rows: AdminUserRow[]; total: number; sort: string; dir: string; tiers: string[] }

export async function adminUserTable(input: UserTableQuery = {}): Promise<UserTablePage> {
  const tiers = ticketTiers();
  const sort = SORTS[input.sort ?? ''] ? (input.sort as string) : 'recent';
  const dir = input.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(500, Math.max(1, Number(input.limit) || 100));
  const offset = Math.max(0, Number(input.offset) || 0);
  const topic = String(input.topic ?? '').trim();
  /* Checked against the tiers this game has — never taken as a column name. */
  const tier = tiers.includes(String(input.tier ?? '')) ? String(input.tier) : (tiers[0] ?? 'green');
  const q = String(input.query ?? '').trim();

  const pool = pg();
  if (!pool) return memoryTable({ ...input, sort, dir, limit, offset, tier, topic, tiers });

  const args: unknown[] = [];
  const p = (v: unknown) => { args.push(v); return '$' + args.length; };

  const ticketSum = tiers.length
    ? tiers.map((t) => `COALESCE((u.tickets->>${p(t)})::int, 0)`).join(' + ')
    : '0';
  const ticketOne = `COALESCE((u.tickets->>${p(tier)})::int, 0)`;

  /* The topic join only exists when a topic was named — an unfiltered join over
     every answer in the game is not something to do on every page load. */
  const topicJoin = topic
    ? `LEFT JOIN (SELECT a.user_id, count(*)::int AS total, count(*) FILTER (WHERE a.correct)::int AS correct
                    FROM answers a JOIN questions q ON q.id = a.question_id
                   WHERE q.category = ${p(topic)}
                   GROUP BY a.user_id) tq ON tq.user_id = u.id`
    : '';
  const topicCols = topic
    ? `COALESCE(tq.total,0) AS topic_total, COALESCE(tq.correct,0) AS topic_correct,
       CASE WHEN COALESCE(tq.total,0) > 0 THEN round(100.0 * tq.correct / tq.total)::int ELSE 0 END AS topic_rate`
    : `0 AS topic_total, 0 AS topic_correct, 0 AS topic_rate`;

  const where = searchSql(q, p);

  const sql = `
    SELECT u.id, u.phone, u.username, u.display_name, u.plan, u.role, u.status, u.level, u.xp,
           u.weekly_score, u.wallet_balance, u.coins, u.hearts, u.tickets, u.created_at,
           ${ticketSum} AS ticket_total,
           ${ticketOne} AS ticket_one,
           COALESCE(mp.played,0) AS played,
           COALESCE(w.wins,0) AS wins,
           GREATEST(COALESCE(mp.played,0) - COALESCE(w.wins,0), 0) AS losses,
           CASE WHEN COALESCE(mp.played,0) > 0
                THEN round(100.0 * COALESCE(w.wins,0) / mp.played)::int ELSE 0 END AS win_rate,
           COALESCE(sp.spent,0) AS spent,
           COALESCE(rf.invited,0) AS invited,
           COALESCE(rf.rewarded,0) AS invites_rewarded,
           (coalesce(u.display_name,'') = '' OR u.display_name = 'بازیکن جدید'
            OR u.username ~ '^user_[0-9]+$') AS unfinished,
           ${topicCols}
      FROM users u
      LEFT JOIN (SELECT user_id, count(*)::int AS played FROM match_players GROUP BY user_id) mp ON mp.user_id = u.id
      LEFT JOIN (SELECT winner_user_id AS uid, count(*)::int AS wins FROM matches
                  WHERE winner_user_id IS NOT NULL GROUP BY winner_user_id) w ON w.uid = u.id
      LEFT JOIN (SELECT user_id, SUM(amount)::bigint AS spent FROM transactions
                  WHERE direction = 'debit' AND currency = 'cash' GROUP BY user_id) sp ON sp.user_id = u.id
      LEFT JOIN (SELECT owner.user_id AS uid, count(*)::int AS invited,
                        count(*) FILTER (WHERE ref.rewarded_at > 0)::int AS rewarded
                   FROM referrals ref JOIN referrals owner ON owner.code = ref.referred_by
                  WHERE ref.referred_by <> '' GROUP BY owner.user_id) rf ON rf.uid = u.id::text
      ${topicJoin}
      ${where}
     ORDER BY ${SORTS[sort]} ${dir} NULLS LAST, u.id
     LIMIT ${p(limit)} OFFSET ${p(offset)}`;

  let rows: any[] = [];
  try {
    rows = (await pool.query(sql, args)).rows;
  } catch {
    /* A server missing one of these tables — an old migration, a fresh install —
       must still get a users list. The simple list is a worse answer than the
       full one and a much better answer than an error page. */
    return memoryTable({ ...input, sort, dir, limit, offset, tier, topic, tiers });
  }

  /* How many there are in total, for the pager. Built with its OWN parameters:
     the statement above numbers its placeholders in the order it needs them,
     and reaching into that list to reuse a few would be a bug waiting for
     somebody to add a column in the middle. */
  let total = rows.length;
  try {
    const cargs: unknown[] = [];
    const cp = (v: unknown) => { cargs.push(v); return '$' + cargs.length; };
    const t = await pool.query(`SELECT count(*)::int n FROM users u ${searchSql(q, cp)}`, cargs);
    total = Number(t.rows[0]?.n ?? rows.length);
  } catch { /* the page length will do */ }

  const shaped = rows.map((r) => shape(r, tiers, topic));
  /* The picture, for the hundred rows on THIS page — one query, after the cut.
     It is the one column an operator reads faces from, and fetching it per row
     is what this file exists not to do. */
  try {
    const art = await avatarUrlsFor(shaped.map((r) => r.id));
    for (const r of shaped) r.avatarUrl = art.get(r.id) ?? null;
  } catch { /* initials will do */ }

  return { rows: shaped, total, sort, dir: dir.toLowerCase(), tiers };
}

function shape(r: any, tiers: string[], topic: string): AdminUserRow {
  const tickets: Record<string, number> = {};
  for (const t of tiers) tickets[t] = Number(r.tickets?.[t] ?? 0) || 0;
  /* Tiers the operator has since renamed away still hold real tickets. */
  if (r.tickets && typeof r.tickets === 'object') {
    for (const k of Object.keys(r.tickets)) if (!(k in tickets)) tickets[k] = Number(r.tickets[k] ?? 0) || 0;
  }
  const row: AdminUserRow = {
    id: String(r.id), phone: r.phone ?? '', username: r.username ?? '', displayName: r.display_name ?? '',
    plan: r.plan ?? 'free', role: (r.role ?? 'user'), status: (r.status ?? 'active'),
    level: Number(r.level ?? 1), xp: Number(r.xp ?? 0), weeklyScore: Number(r.weekly_score ?? 0),
    wallet: Number(r.wallet_balance ?? 0), coins: Number(r.coins ?? 0), hearts: Number(r.hearts ?? 0),
    invited: Number(r.invited ?? 0), invitesRewarded: Number(r.invites_rewarded ?? 0),
    createdAt: r.created_at ? new Date(r.created_at).getTime() : 0,
    unfinished: r.unfinished === undefined ? unfinishedOf(r.display_name, r.username) : !!r.unfinished,
    tickets, ticketTotal: Number(r.ticket_total ?? 0),
    spent: Number(r.spent ?? 0),
    played: Number(r.played ?? 0), wins: Number(r.wins ?? 0), losses: Number(r.losses ?? 0),
    winRate: Number(r.win_rate ?? 0)
  } as AdminUserRow;
  if (topic) {
    row.topicTotal = Number(r.topic_total ?? 0);
    row.topicCorrect = Number(r.topic_correct ?? 0);
    row.topicRate = Number(r.topic_rate ?? 0);
  }
  return row;
}

/* The memory driver, and the fallback for a database missing a table. Sorted
 * here rather than not at all — the columns it cannot know (spend, wins, the
 * topic) come back as zero, which is honest and still orders the rest. */
async function memoryTable(o: any): Promise<UserTablePage> {
  const base = await searchAdminUsers(o.query ?? '', 500).catch(() => [] as AdminUserListItem[]);
  const rows: AdminUserRow[] = [];
  for (const u of base) {
    const tickets = await repositories.users.findById(u.id).then((x) => (x?.tickets ?? {}) as any).catch(() => ({}));
    const t: Record<string, number> = {};
    for (const k of o.tiers) t[k] = Number((tickets as any)[k] ?? 0) || 0;
    rows.push({ ...u, tickets: t, ticketTotal: Object.values(t).reduce((a, b) => a + b, 0),
      spent: 0, played: 0, wins: 0, losses: 0, winRate: 0,
      unfinished: unfinishedOf(u.displayName, u.username) } as AdminUserRow);
  }
  const key = o.sort as string;
  const pick = (r: AdminUserRow): number | string => {
    switch (key) {
      case 'username': return String(r.username || '').toLowerCase();
      case 'wallet': return r.wallet;
      case 'coins': return r.coins;
      case 'level': return r.level;
      case 'xp': return r.xp;
      case 'tickets': return r.ticketTotal;
      case 'ticket': return r.tickets[o.tier] ?? 0;
      case 'invited': return r.invited ?? 0;
      default: return 0;
    }
  };
  rows.sort((a, b) => {
    const x = pick(a), y = pick(b);
    const c = typeof x === 'string' ? String(x).localeCompare(String(y)) : Number(x) - Number(y);
    return o.dir === 'ASC' ? c : -c;
  });
  return { rows: rows.slice(o.offset, o.offset + o.limit), total: rows.length,
           sort: o.sort, dir: String(o.dir).toLowerCase(), tiers: o.tiers };
}
