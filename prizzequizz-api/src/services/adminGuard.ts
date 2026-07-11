import type { RequestContext } from '../http/router.js';
import { error } from '../http/response.js';

export function requireAdmin(ctx: RequestContext): boolean {
  const configuredKey = process.env.ADMIN_KEY || (process.env.NODE_ENV === 'production' ? '' : 'dev-admin');
  const providedKey = ctx.req.headers['x-admin-key'];
  if (ctx.role === 'admin') return true;
  if (configuredKey && providedKey === configuredKey) return true;
  error(ctx.res, 403, 'ADMIN_REQUIRED', 'Admin privileges are required for this endpoint.');
  return false;
}
