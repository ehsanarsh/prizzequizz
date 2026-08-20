import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { assignSupportTicket, createSupportTicket, getSupportTicket, listSupportTickets, replyToSupportTicket, supportDiagnostics, updateSupportTicketStatus, userReplyToSupportTicket } from '../../services/supportService.js';
import type { SupportTicketPriority, SupportTicketStatus } from '../../types/domain.js';
import { listMacros, createMacro, updateMacro, deleteMacro, MacroError } from '../../services/supportMacroService.js';
import { bodyObject, optionalString, requiredString } from '../../utils/validation.js';

export function registerSupportRoutes(router: Router, base: string): void {
  router.add('GET', `${base}/support/tickets`, async (ctx) => {
    json(ctx.res, 200, await listSupportTickets({ userId: ctx.userId ?? 'u1', limit: Number(ctx.query.get('limit') ?? 50) }));
  });

  router.add('POST', `${base}/support/tickets`, async (ctx) => {
    const body = bodyObject(ctx.body);
    const ticket = await createSupportTicket({
      userId: ctx.userId ?? 'u1',
      title: requiredString(body, 'title'),
      category: optionalString(body, 'category', 'عمومی') ?? 'عمومی',
      body: requiredString(body, 'body'),
      priority: optionalString(body, 'priority') as SupportTicketPriority | undefined,
      linkedMatchId: optionalString(body, 'linkedMatchId'),
      linkedTransactionId: optionalString(body, 'linkedTransactionId'),
      linkedRewardHoldId: optionalString(body, 'linkedRewardHoldId')
    });
    json(ctx.res, 201, ticket);
  });

  router.add('GET', `${base}/support/tickets/:id`, async (ctx) => {
    const result = await getSupportTicket(ctx.params.id!);
    if (!result || result.ticket.userId !== (ctx.userId ?? 'u1')) return error(ctx.res, 404, 'TICKET_NOT_FOUND', 'Support ticket not found.');
    json(ctx.res, 200, result);
  });

  // A user sends a follow-up message (chat) on their own ticket.
  router.add('POST', `${base}/support/tickets/:id/reply`, async (ctx) => {
    const body = bodyObject(ctx.body);
    const r = await userReplyToSupportTicket(ctx.params.id!, ctx.userId ?? 'u1', requiredString(body, 'body'));
    if (!r) return error(ctx.res, 404, 'TICKET_NOT_FOUND', 'Support ticket not found.');
    json(ctx.res, 200, r);
  });

  router.add('GET', `${base}/admin/support/diagnostics`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await supportDiagnostics());
  });

  /* CANNED REPLIES — «جملات آماده و قابل اضافه و تغییر و حذف کردن از همان
     پنل». Kept on the server so every operator has the same set. */
  router.add('GET', `${base}/admin/support/macros`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, { rows: await listMacros() });
  });
  router.add('POST', `${base}/admin/support/macros`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    try { json(ctx.res, 201, await createMacro(ctx.body ?? {})); }
    catch (e) { if (e instanceof MacroError) return error(ctx.res, 422, e.code, e.message); throw e; }
  });
  router.add('PATCH', `${base}/admin/support/macros/:id`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    try { json(ctx.res, 200, await updateMacro(ctx.params.id!, ctx.body ?? {})); }
    catch (e) {
      if (e instanceof MacroError) return error(ctx.res, e.code === 'MACRO_NOT_FOUND' ? 404 : 422, e.code, e.message);
      throw e;
    }
  });
  router.add('DELETE', `${base}/admin/support/macros/:id`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const gone = await deleteMacro(ctx.params.id!);
    if (!gone) return error(ctx.res, 404, 'MACRO_NOT_FOUND', 'این جمله پیدا نشد.');
    json(ctx.res, 200, { deleted: true, id: ctx.params.id });
  });

  router.add('GET', `${base}/admin/support/tickets`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await listSupportTickets({
      userId: ctx.query.get('userId') || undefined,
      status: (ctx.query.get('status') || undefined) as SupportTicketStatus | undefined,
      priority: (ctx.query.get('priority') || undefined) as SupportTicketPriority | undefined,
      category: ctx.query.get('category') || undefined,
      assignedAdminId: ctx.query.get('assignedAdminId') || undefined,
      limit: Number(ctx.query.get('limit') ?? 100)
    }));
  });

  router.add('GET', `${base}/admin/support/tickets/:id`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const result = await getSupportTicket(ctx.params.id!);
    if (!result) return error(ctx.res, 404, 'TICKET_NOT_FOUND', 'Support ticket not found.');
    json(ctx.res, 200, result);
  });

  router.add('POST', `${base}/admin/support/tickets/:id/reply`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const body = bodyObject(ctx.body);
    const updated = await replyToSupportTicket(ctx.params.id!, ctx.userId ?? 'system', requiredString(body, 'body'));
    if (!updated) return error(ctx.res, 404, 'TICKET_NOT_FOUND', 'Support ticket not found.');
    json(ctx.res, 200, updated);
  });

  router.add('PATCH', `${base}/admin/support/tickets/:id/status`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const status = String((ctx.body as any)?.status ?? 'answered') as SupportTicketStatus;
    if (!['open','answered','closed','escalated'].includes(status)) return error(ctx.res, 422, 'SUPPORT_STATUS_INVALID', 'Invalid support ticket status.');
    const updated = await updateSupportTicketStatus(ctx.params.id!, status, ctx.userId ?? 'system');
    if (!updated) return error(ctx.res, 404, 'TICKET_NOT_FOUND', 'Support ticket not found.');
    json(ctx.res, 200, updated);
  });

  router.add('PATCH', `${base}/admin/support/tickets/:id/assign`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const updated = await assignSupportTicket(ctx.params.id!, ctx.userId ?? 'system');
    if (!updated) return error(ctx.res, 404, 'TICKET_NOT_FOUND', 'Support ticket not found.');
    json(ctx.res, 200, updated);
  });
}
