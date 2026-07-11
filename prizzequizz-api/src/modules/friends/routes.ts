import type { Router } from '../../http/router.js';
import { json } from '../../http/response.js';

export function registerFriendRoutes(router: Router, base: string): void {
  router.add('GET', `${base}/friends`, (ctx) => json(ctx.res, 200, [{ id: 'f1', username: 'reza_fast', displayName: 'رضا', avatar: '🦊', online: true, status: 'آنلاین', unread: 1 }]));
  router.add('POST', `${base}/friends/requests`, (ctx) => json(ctx.res, 201, { sent: true }));
  router.add('POST', `${base}/friends/invites`, (ctx) => json(ctx.res, 201, { sent: true }));
}
