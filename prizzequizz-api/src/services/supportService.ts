import { repositories } from '../repositories/index.js';
import type { SupportMessage, SupportTicket, SupportTicketPriority, SupportTicketStatus } from '../types/domain.js';
import { id } from '../utils/id.js';
import { notifications } from './notificationService.js';

export interface SupportDiagnostics {
  open: number;
  answered: number;
  escalated: number;
  closed: number;
  urgent: number;
  unassigned: number;
}

export async function createSupportTicket(input: {
  userId: string;
  title: string;
  category: string;
  body: string;
  priority?: SupportTicketPriority;
  linkedMatchId?: string;
  linkedTransactionId?: string;
  linkedRewardHoldId?: string;
}): Promise<SupportTicket> {
  const now = new Date().toISOString();
  const ticket: SupportTicket = {
    id: id(),
    userId: input.userId,
    title: input.title.slice(0, 180),
    category: input.category || 'عمومی',
    body: input.body.slice(0, 4000),
    priority: input.priority ?? inferPriority(input.category, input.body),
    status: 'open',
    reply: 'تیکت شما در صف بررسی است.',
    linkedMatchId: input.linkedMatchId,
    linkedTransactionId: input.linkedTransactionId,
    linkedRewardHoldId: input.linkedRewardHoldId,
    createdAt: now,
    updatedAt: now
  };
  await repositories.support.saveTicket(ticket);
  await repositories.support.appendMessage({ id: id(), ticketId: ticket.id, senderId: input.userId, senderRole: 'user', body: ticket.body, createdAt: now });
  return ticket;
}

export async function listSupportTickets(filter: { userId?: string; status?: SupportTicketStatus; priority?: SupportTicketPriority; category?: string; assignedAdminId?: string; limit?: number } = {}): Promise<SupportTicket[]> {
  return repositories.support.listTickets(filter);
}

export async function getSupportTicket(id: string): Promise<{ ticket: SupportTicket; messages: SupportMessage[] } | null> {
  const ticket = await repositories.support.findTicketById(id);
  if (!ticket) return null;
  return { ticket, messages: await repositories.support.listMessages(id) };
}

export async function replyToSupportTicket(ticketId: string, adminId: string, body: string): Promise<SupportTicket | null> {
  const ticket = await repositories.support.findTicketById(ticketId);
  if (!ticket) return null;
  const now = new Date().toISOString();
  await repositories.support.appendMessage({ id: id(), ticketId, senderId: adminId, senderRole: 'admin', body: body.slice(0, 4000), createdAt: now });
  const updated = await repositories.support.updateTicket(ticketId, { reply: body.slice(0, 800), status: 'answered', assignedAdminId: adminId, updatedAt: now });
  if (updated) await notifications.create({ userId: updated.userId, type: 'system', title: 'پاسخ پشتیبانی آماده است', body: updated.reply ?? 'تیکت شما پاسخ داده شد.', data: { ticketId: updated.id, url: '/support' }, push: true });
  return updated;
}

/* A user replies on their OWN ticket → appends a user message and reopens it so
 * the admin sees it needs attention. Ownership is enforced. */
export async function userReplyToSupportTicket(ticketId: string, userId: string, body: string): Promise<{ ticket: SupportTicket; messages: SupportMessage[] } | null> {
  const ticket = await repositories.support.findTicketById(ticketId);
  if (!ticket || ticket.userId !== userId) return null;
  const now = new Date().toISOString();
  await repositories.support.appendMessage({ id: id(), ticketId, senderId: userId, senderRole: 'user', body: body.slice(0, 4000), createdAt: now });
  await repositories.support.updateTicket(ticketId, { status: ticket.status === 'closed' ? 'closed' : 'open', updatedAt: now });
  return getSupportTicket(ticketId);
}

export async function updateSupportTicketStatus(ticketId: string, status: SupportTicketStatus, adminId: string): Promise<SupportTicket | null> {
  const patch: Partial<SupportTicket> = { status, assignedAdminId: adminId };
  if (status === 'closed') patch.closedAt = new Date().toISOString();
  return repositories.support.updateTicket(ticketId, patch);
}

export async function assignSupportTicket(ticketId: string, adminId: string): Promise<SupportTicket | null> {
  return repositories.support.updateTicket(ticketId, { assignedAdminId: adminId, status: 'open' });
}

export async function supportDiagnostics(): Promise<SupportDiagnostics> {
  const tickets = await repositories.support.listTickets({ limit: 1000 });
  return {
    open: tickets.filter((t) => t.status === 'open').length,
    answered: tickets.filter((t) => t.status === 'answered').length,
    escalated: tickets.filter((t) => t.status === 'escalated').length,
    closed: tickets.filter((t) => t.status === 'closed').length,
    urgent: tickets.filter((t) => t.priority === 'urgent').length,
    unassigned: tickets.filter((t) => !t.assignedAdminId && t.status !== 'closed').length
  };
}

function inferPriority(category: string, body: string): SupportTicketPriority {
  const text = `${category} ${body}`.toLowerCase();
  if (text.includes('برداشت') || text.includes('جایزه') || text.includes('تقلب') || text.includes('withdraw') || text.includes('reward')) return 'high';
  if (text.includes('پرداخت') || text.includes('کیف پول') || text.includes('wallet')) return 'high';
  return 'normal';
}
