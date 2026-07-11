import { api } from '../../api';
import { runTask } from '../../core/asyncTask';
import { eventBus } from '../../core/eventBus';

export type FriendsTab = 'friends' | 'chats' | 'requests' | 'add';

export interface FriendProfile {
  id: string;
  avatar: string;
  name: string;
  username: string;
  status: string;
  online: boolean;
  level: number;
  league: string;
  unread: number;
  messages: Array<{ from: 'me' | 'them'; text: string; time: string }>;
}

export interface FriendRequest { id: string; avatar: string; name: string; username: string; level: number; message: string; }

let tab: FriendsTab = 'friends';
let activeChatId: string | null = null;
let hydrated = false;

let friends: FriendProfile[] = [
  { id: 'f1', avatar: '🦊', name: 'رضا', username: 'reza_fast', status: 'در حال بازی Duel', online: true, level: 5, league: '🥈 نقره‌ای', unread: 2, messages: [{ from: 'them', text: 'سلام شهاب! پایه دوئل هستی؟', time: '۱۴:۲۰' }] },
  { id: 'f2', avatar: '🐼', name: 'نگار', username: 'negar_panda', status: 'آنلاین', online: true, level: 4, league: '🥉 برنزی', unread: 0, messages: [{ from: 'them', text: 'تبریک بابت بردت 🎉', time: '۱۳:۱۰' }] },
  { id: 'f3', avatar: '🐯', name: 'امیر', username: 'amir_tiger', status: '۲ ساعت پیش', online: false, level: 7, league: '🥇 طلایی', unread: 0, messages: [{ from: 'me', text: 'فردا هستی؟', time: 'دیروز' }] }
];

let requests: FriendRequest[] = [{ id: 'r1', avatar: '🦊', name: 'تینا XP', username: 'TinaXP2025', level: 6, message: 'از رنکینگ پیدات کردم؛ بازی کنیم؟' }];

export function getFriendsTab(): FriendsTab { return tab; }
export function setFriendsTab(next: FriendsTab): void { tab = next; activeChatId = null; }
export function getFriends(): FriendProfile[] { return friends; }
export function getRequests(): FriendRequest[] { return requests; }
export function getActiveChat(): FriendProfile | null { return friends.find((friend) => friend.id === activeChatId) ?? null; }
export function isFriendsHydrated(): boolean { return hydrated; }

export async function hydrateFriends(): Promise<void> {
  if (hydrated) return;
  await runTask('friends.hydrate', async () => {
    const list = await api.friends.list();
    if (list.length) {
      friends = list.map((friend) => ({ id: friend.id, avatar: friend.avatar, name: friend.displayName, username: friend.username, status: friend.status, online: friend.online, level: 3, league: '🥉 برنزی', unread: friend.unread, messages: [] }));
    }
    hydrated = true;
  });
}

export function openChat(id: string): void { activeChatId = id; tab = 'chats'; const f = friends.find((x) => x.id === id); if (f) f.unread = 0; }
export function closeChat(): void { activeChatId = null; }

export function sendMessage(text: string): void {
  const friend = getActiveChat();
  if (!friend || !text.trim()) return;
  friend.messages.push({ from: 'me', text: text.trim(), time: 'الان' });
  window.setTimeout(() => { friend.messages.push({ from: 'them', text: ['باشه 🔥', 'بعد بازی میام', 'دمت گرم!'][Math.floor(Math.random() * 3)], time: 'الان' }); eventBus.emit('FRIEND_MESSAGE_RECEIVED', friend); }, 800);
}

export function acceptRequest(id: string): void {
  const req = requests.find((r) => r.id === id);
  if (!req) return;
  requests = requests.filter((r) => r.id !== id);
  friends.push({ id: req.id, avatar: req.avatar, name: req.name, username: req.username, status: 'همین حالا دوست شدید', online: true, level: req.level, league: '🥉 برنزی', unread: 0, messages: [{ from: 'them', text: req.message, time: 'الان' }] });
}

export function declineRequest(id: string): void { requests = requests.filter((r) => r.id !== id); }

export async function sendFriendRequest(username: string): Promise<boolean> {
  if (!username.trim()) return false;
  const result = await runTask('friends.request', async () => api.friends.sendRequest(username));
  if (result?.sent) eventBus.emit('FRIEND_REQUEST_SENT', { username });
  return !!result?.sent;
}

export async function inviteFriend(id: string, mode: string, entry: string): Promise<void> {
  const friend = friends.find((f) => f.id === id);
  if (!friend) return;
  const result = await runTask('friends.invite', async () => api.friends.invite(id, mode, entry));
  if (result?.sent) eventBus.emit('FRIEND_INVITE_SENT', { friend, mode, entry });
}
