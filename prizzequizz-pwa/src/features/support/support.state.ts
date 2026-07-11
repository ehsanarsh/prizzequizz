import { api } from '../../api';
import { runTask } from '../../core/asyncTask';

export type SupportTab = 'home' | 'chat' | 'tickets' | 'faq' | 'status';

export interface SupportTicket {
  id: string;
  title: string;
  category: string;
  body: string;
  status: 'open' | 'answered' | 'closed' | 'escalated';
  reply: string;
}

let tab: SupportTab = 'home';
let hydrated = false;
const messages: Array<{ from: 'me' | 'agent'; text: string }> = [{ from: 'agent', text: 'سلام! چطور می‌تونم کمک کنم؟' }];
let tickets: SupportTicket[] = [{ id: '1024', title: 'افزایش زمان انتظار روم‌ها', category: 'پیشنهاد', body: 'لطفاً زمان انتظار روم‌ها بیشتر شود.', status: 'answered', reply: 'پیشنهاد ثبت شد.' }];

export function getSupportTab(): SupportTab { return tab; }
export function setSupportTab(next: SupportTab): void { tab = next; }
export function getSupportMessages() { return messages; }
export function getSupportTickets() { return tickets; }
export function isSupportHydrated(): boolean { return hydrated; }

export async function hydrateSupport(): Promise<void> {
  if (hydrated) return;
  await runTask('support.hydrate', async () => {
    const list = await api.support.listTickets();
    tickets = list.map((ticket) => ({ id: String(ticket.id), title: ticket.title, category: ticket.category, body: ticket.body, status: ticket.status, reply: ticket.reply ?? 'در انتظار پاسخ' }));
    hydrated = true;
  });
}

export function sendSupportMessage(text: string): void {
  if (!text.trim()) return;
  messages.push({ from: 'me', text: text.trim() });
  window.setTimeout(() => messages.push({ from: 'agent', text: 'پیامت ثبت شد. اگر نیاز به پیگیری داری تیکت بساز.' }), 600);
}

export async function createTicket(title: string, category: string, body: string): Promise<boolean> {
  if (!title.trim() || !body.trim()) return false;
  const ticket = await runTask('support.createTicket', async () => api.support.createTicket({ title, category, body }));
  if (!ticket) return false;
  tickets.unshift({ id: String(ticket.id), title: ticket.title, category: ticket.category, body: ticket.body, status: ticket.status, reply: ticket.reply ?? 'تیکت شما در صف بررسی است.' });
  return true;
}
