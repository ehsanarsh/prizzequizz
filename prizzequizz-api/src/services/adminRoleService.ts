/* WHAT A JOB IS, INSTEAD OF WHAT FORTY CHECKBOXES ARE.
 *
 * Access is per-tab, one tick per screen, and there are more than fifty
 * screens. Two things go wrong with that, and both go wrong quietly:
 *
 *   — Hiring somebody means fifty decisions, made once, by whoever happened to
 *     be creating the account. Nobody can look at a list of ticks afterwards
 *     and say whether it is right.
 *   — A screen added next month reaches NOBODY. Every existing account was
 *     saved with the tabs that existed on the day it was made, so the new
 *     screen is invisible to the person whose job it is, and nothing says so.
 *
 * So a role is STORED on the account and resolved at request time — not copied
 * into the account's ticks. Put a new screen in a role here and everyone who
 * holds that role has it on their next request.
 *
 * `perms` stays, and means EXTRAS: the one screen this one person also needs.
 * That is deliberately how «the growth person needs the phone export» is
 * answered — by one extra tick on one account, not by putting the whole users
 * screen (balances, bans, everything) into a role.
 */
import { ADMIN_TABS } from './adminTabs.js';

export type AdminRoleKey = 'owner' | 'support' | 'finance' | 'content' | 'dev' | 'ops' | 'growth';

export interface AdminRole {
  key: AdminRoleKey;
  label: string;          // what the panel shows
  about: string;          // one line: what this person is for
  tabs: string[];         // '*' means everything
}

/* The tabs each job actually needs. Kept deliberately tight: a tab that is not
   needed to do the work is a tab that can only cause an accident. */
export const ADMIN_ROLES: AdminRole[] = [
  {
    key: 'owner', label: 'مدیر کل', about: 'همه‌چیز، بدون استثنا',
    tabs: ['*']
  },
  {
    key: 'support', label: 'پشتیبانی', about: 'تیکت‌ها، گزارش سؤال، و پیدا کردن حساب بازیکن',
    /* `users` is in here because a ticket cannot be answered without looking
       the player up. It is also the screen that can change balances — the tab
       system is not finer than this, so support is a role given to people who
       are trusted with that, and the audit log is what makes it checkable. */
    tabs: ['dashboard', 'support', 'tickets', 'qreports', 'users', 'matches']
  },
  {
    key: 'finance', label: 'مالی', about: 'درخواست جایزه، درگاه، حسابداری',
    tabs: ['dashboard', 'finance', 'ledger', 'accounting', 'expenses', 'wallet', 'withdrawals',
           'withdrawotp', 'payoutpartners', 'rewardholds', 'payments', 'giftcodes', 'reports', 'users']
  },
  {
    key: 'content', label: 'محتوا', about: 'سؤال‌ها، موضوع‌ها، خوش‌آمدگویی',
    tabs: ['dashboard', 'questions', 'qreports', 'aistudio', 'pipeline', 'categories', 'onboarding']
  },
  {
    key: 'dev', label: 'برنامه‌نویس', about: 'خطاهای واقعیِ بازی و سرور',
    /* The queue this role exists for is `errors`. Everything else here is what
       you need open next to it while you read one. */
    tabs: ['dashboard', 'errors', 'logs', 'monitoring', 'matches']
  },
  {
    key: 'ops', label: 'فنی و زیرساخت', about: 'سرور، پشتیبان‌گیری، امنیت',
    /* `reset` and `rawcfg` are NOT here. They are the two screens that can
       destroy data in one click, and «technical» is not the same as «allowed to
       wipe the game». The owner keeps them. */
    tabs: ['dashboard', 'monitoring', 'errors', 'backup', 'security', 'anticheat', 'suspicious', 'logs', 'general']
  },
  {
    key: 'growth', label: 'رشد', about: 'لیدربرد، کمپین، اعلان، پیامک',
    /* `users` is deliberately absent. The phone export lives behind it, and so
       does every player's balance — somebody who needs the list gets `users`
       as an EXTRA on their own account, which is one visible decision about
       one person instead of a rule about a job. */
    tabs: ['dashboard', 'leaderboard', 'campaign', 'events', 'banners', 'notifications', 'sms', 'smsgroups', 'reports']
  }
];

const BY_KEY = new Map<string, AdminRole>(ADMIN_ROLES.map((r) => [r.key, r]));

export function isRoleKey(v: unknown): v is AdminRoleKey { return BY_KEY.has(String(v ?? '')); }

/** The role's own tabs. An unknown role grants NOTHING — never everything. */
export function roleTabs(role: unknown): string[] {
  const r = BY_KEY.get(String(role ?? ''));
  return r ? r.tabs.slice() : [];
}

/* WHAT THIS ACCOUNT MAY ACTUALLY OPEN.
   Role tabs plus the account's own extras. Fails CLOSED: a role name this build
   does not know — an older account, a role renamed in a later version — grants
   only the extras, never a blanket '*'. The person sees too little and says so;
   the other way round nobody ever finds out. */
export function effectivePerms(role: unknown, extras: unknown): string[] {
  const own = Array.isArray(extras) ? extras.map(String).filter(Boolean) : [];
  if (own.includes('*')) return ['*'];
  const tabs = roleTabs(role);
  if (tabs.includes('*')) return ['*'];
  return [...new Set([...tabs, ...own])];
}

/* Tabs a role does NOT cover — what the panel offers as extras. Sorted the way
   ADMIN_TABS is, so the checklist keeps the order people are used to. */
export function extraTabsFor(role: unknown): string[] {
  const have = new Set(roleTabs(role));
  if (have.has('*')) return [];
  return (ADMIN_TABS as readonly string[]).filter((t) => !have.has(t));
}
