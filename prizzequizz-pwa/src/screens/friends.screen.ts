import type { AppState } from '../types/app';
import { bottomNav, topbar } from '../components/layout';
import { emptyState, errorState, skeletonList } from '../components/statusViews';
import { getActiveChat, getFriends, getFriendsTab, getRequests } from '../features/friends/friends.state';

export function renderFriends(state: AppState): string {
  const active = getActiveChat();
  const loading = state.ui.loading['friends.hydrate'];
  const error = state.ui.errors['friends.hydrate'];

  if (active) {
    return `<section class="screen friends chat-mode pad">
      ${topbar('چت با ' + active.name, '<button class="iconbtn" data-action="close-chat">→</button>')}
      <div class="chat-view">
        <div class="chat-head"><div class="avatar">${active.avatar}</div><div><b>${active.name}</b><span>@${active.username}</span></div></div>
        <div class="chat-body">${active.messages.length ? active.messages.map((m) => `<div class="msg ${m.from}">${m.text}</div>`).join('') : emptyState('💬', 'شروع گفتگو', 'اولین پیام را ارسال کن.')}</div>
        <div class="chat-send"><input id="friendMessageInput" class="input" placeholder="پیام بنویس..."/><button class="primary" data-action="send-message">➤</button></div>
      </div>
    </section>`;
  }

  const tab = getFriendsTab();
  return `<section class="screen friends pad">
    ${topbar('دوستان', '<button class="iconbtn" data-go="home">→</button>')}
    <div class="tabs small-tabs">
      ${tabButton('friends', 'دوستان', tab)}${tabButton('chats', 'چت', tab)}${tabButton('requests', 'درخواست‌ها', tab)}${tabButton('add', 'افزودن', tab)}
    </div>
    <div class="friends-content">${loading ? skeletonList(4) : error ? errorState(error, 'retry-friends') : renderTab(tab)}</div>
    ${bottomNav()}
  </section>`;
}

function renderTab(tab: string): string {
  if (tab === 'requests') {
    const reqs = getRequests();
    return reqs.length ? reqs.map((r) => `<div class="friend-row"><span>${r.avatar}</span><b>${r.name}</b><small>@${r.username}</small><button class="primary" data-accept-request="${r.id}">قبول</button><button class="ghost" data-decline-request="${r.id}">رد</button></div>`).join('') : emptyState('📭', 'درخواستی نداری', 'درخواست‌های جدید اینجا نمایش داده می‌شوند.');
  }
  if (tab === 'add') {
    return `<div class="list-card"><b>افزودن دوست</b><p>یوزرنیم یا کد دعوت را وارد کن.</p><input id="friendRequestInput" class="input" placeholder="مثلاً NimaX77"/><button class="primary" data-action="send-friend-request">ارسال درخواست</button></div>`;
  }
  const list = getFriends();
  if (!list.length) return emptyState('👥', 'دوستی نداری', 'از تب افزودن، دوست جدید اضافه کن.');
  return list.map((f) => `<div class="friend-row ${f.online ? 'online' : ''}" ${tab === 'chats' ? `data-open-chat="${f.id}"` : ''}><span>${f.avatar}</span><b>${f.name}</b><small>${f.status}</small>${tab === 'chats' ? unread(f.unread) : `<button class="primary" data-open-chat="${f.id}">چت</button><button class="ghost" data-invite="${f.id}">دعوت</button>`}</div>`).join('');
}

function unread(n: number): string { return n ? `<em class="chat-unread">${n.toLocaleString('fa-IR')}</em>` : '<small>باز کردن گفتگو</small>'; }
function tabButton(id: string, label: string, active: string): string { return `<button class="${id === active ? 'active' : ''}" data-friends-tab="${id}">${label}</button>`; }
