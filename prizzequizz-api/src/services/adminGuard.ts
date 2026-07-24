import type { RequestContext } from '../http/router.js';
import { error } from '../http/response.js';
import { resolveTokenSync, tabForPath, hasTab, type CachedAccount } from './adminAccountService.js';

function masterKey(): string {
  return process.env.ADMIN_KEY || (process.env.NODE_ENV === 'production' ? '' : 'dev-admin');
}

/** The admin behind this request, if any (master, JWT-admin, or an account). */
export function currentAdmin(ctx: RequestContext): { master: boolean; account: CachedAccount | null; perms: string[] } {
  const key = ctx.req.headers['x-admin-key'];
  const mk = masterKey();
  if ((mk && key === mk) || ctx.role === 'admin') return { master: true, account: null, perms: ['*'] };
  const acc = typeof key === 'string' ? resolveTokenSync(key) : null;
  return { master: false, account: acc, perms: acc?.perms ?? [] };
}

/**
 * Gate an admin endpoint. Master key (env ADMIN_KEY) and JWT admins have full
 * access. Otherwise the request must carry a valid account token AND the account
 * must have permission for this request's tab (derived from the path, or an
 * explicit `opts.tab`). `opts.ownerOnly` restricts to the owner/master.
 */
export function requireAdmin(ctx: RequestContext, opts?: { tab?: string; ownerOnly?: boolean }): boolean {
  const key = ctx.req.headers['x-admin-key'];
  const mk = masterKey();
  if ((mk && key === mk) || ctx.role === 'admin') { (ctx as any).adminPerms = ['*']; (ctx as any).adminIsOwner = true; return true; }

  const acc = typeof key === 'string' ? resolveTokenSync(key) : null;
  if (!acc) { error(ctx.res, 403, 'ADMIN_REQUIRED', 'Admin privileges are required for this endpoint.'); return false; }
  (ctx as any).adminAccount = acc; (ctx as any).adminPerms = acc.perms; (ctx as any).adminIsOwner = acc.isOwner;

  if (opts?.ownerOnly && !acc.isOwner && !acc.perms.includes('*')) {
    error(ctx.res, 403, 'OWNER_ONLY', 'فقط مدیر کل به این بخش دسترسی دارد.');
    return false;
  }
  const tab = opts?.tab ?? tabForPath(String(ctx.req.url || ''));
  if (!hasTab(acc.perms, tab)) {
    error(ctx.res, 403, 'TAB_FORBIDDEN', 'به این بخش دسترسی نداری.');
    return false;
  }
  return true;
}
