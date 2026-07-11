import './styles/tokens.css';
import './styles/base.css';
import './styles/screens.css';
import './styles/components.css';
import { store } from './core/stateStore';
import { screenManager } from './core/screenManager';
import { go } from './core/router';
import { eventBus } from './core/eventBus';
import { renderSplash } from './screens/splash.screen';
import { renderLogin } from './screens/login.screen';
import { renderHome } from './screens/home.screen';
import { renderModeEntry } from './screens/modeEntry.screen';
import { renderMatchmaking } from './screens/matchmaking.screen';
import { renderDuel, setDuelQuestion } from './screens/duel.screen';
import { renderResult } from './screens/result.screen';
import { renderWallet } from './screens/wallet.screen';
import { hydrateWallet, requestWithdraw, setWalletTab, topupWallet } from './features/wallet/wallet.state';
import { renderMissions } from './screens/missions.screen';
import { renderRankings } from './screens/rankings.screen';
import { hydrateLeaderboard, setLeaderboardKind, subscribeLeaderboard } from './features/leaderboards/leaderboard.state';
import { hydrateCharacter, equipCharacter, purchaseCharacterItem, randomizeCharacter, setActiveCharacterSlot } from './features/characters/character.state';
import { enablePushNotifications, hydrateNotifications, markAllNotificationsRead, markNotificationRead, updateNotificationPreference } from './features/notifications/notification.state';
import { renderFriends } from './screens/friends.screen';
import { renderSupport } from './screens/support.screen';
import { renderPlaceholder } from './screens/placeholder.screen';
import { renderSettings } from './screens/settings.screen';
import { renderCharacter } from './screens/character.screen';
import { renderAdmin } from './screens/admin.screen';
import { startDuelSearch, answerDuel, useDuelPowerup } from './features/duel/duel.logic';
import { spendPaidEntry, spendPracticeEntry, setPracticeCoinStake } from './features/practice/practiceEconomy';
import { claimMission } from './features/missions/missions.state';
import { openLuckyWheel } from './features/luckyWheel/luckyWheel';
import { claimDailyReward, dailyRewards, getDailyState } from './features/daily/dailyRewards';
import { acceptRequest, closeChat, declineRequest, getFriends, hydrateFriends, inviteFriend, openChat, sendFriendRequest, sendMessage, setFriendsTab } from './features/friends/friends.state';
import { createTicket, hydrateSupport, sendSupportMessage, setSupportTab } from './features/support/support.state';
import { installRewardAnimations } from './components/rewardAnimation';
import { showSnackbar } from './components/snackbar';
import { showModal } from './components/modal';
import { bootstrapSession, hasSession, loginWithOtp } from './features/auth/session';
import { installNetworkStatus } from './services/networkStatus';
import { installRealtimeManager, sendRealtimeChat } from './services/realtimeManager';
import { installClientErrorReporter } from './services/errorReporter';
import type { GameModeId, Question, ScreenId } from './types/app';
import { gameConfig } from './config/game.config';
import { broadcastAdminNotification, createAdminBetaInvite, createAdminQuestion, exportQuestionsAsJson, hydrateAdmin, importQuestionsFromText, loadAdminUserOverview, loadUserDevices, patchDuelTimer, patchFlag, patchRewardConfig, saveConfigFromText, setAdminKey, setAdminTab, setQuestionFilter, setAdminUserRole, setAdminUserStatus, updateAdminBetaInviteStatus, updateAdminQuestionStatus, updateCharacterCatalogStatus, updateDeviceStatus, updateIntegrityStatus, updateMonitoringStatus, replySupportTicket, updateRewardHoldStatus, updateSupportStatus, updateWithdrawalStatus, upsertAdminTheme, upsertCharacterCatalogItem } from './features/admin/admin.state';

const app = document.querySelector<HTMLDivElement>('#app')!;

screenManager.register('splash', renderSplash);
screenManager.register('login', renderLogin, bindLogin);
screenManager.register('home', renderHome, bindCommon);
screenManager.register('mode-entry', renderModeEntry, bindModeEntry);
screenManager.register('matchmaking', renderMatchmaking, bindCommon);
screenManager.register('duel', renderDuel, bindDuel);
screenManager.register('result', renderResult, bindResult);
screenManager.register('wallet', renderWallet, bindWallet);
screenManager.register('missions', renderMissions, bindMissions);
screenManager.register('rankings', renderRankings, bindRankings);
screenManager.register('friends', renderFriends, bindFriends);
screenManager.register('support', renderSupport, bindSupport);
screenManager.register('settings', renderSettings, bindSettings);
screenManager.register('character', renderCharacter, bindCharacter);
screenManager.register('admin', renderAdmin, bindAdmin);

store.subscribe((state) => {
  screenManager.render(app, state);
  installRewardAnimations(app);
});

installNetworkStatus();
installRealtimeManager();
installClientErrorReporter();
void initializeApp();

async function initializeApp(): Promise<void> {
  const hasRealBackend = Boolean(import.meta.env.VITE_API_BASE_URL);
  if (hasRealBackend && !hasSession()) {
    window.setTimeout(() => go('login'), 650);
    return;
  }
  await bootstrapSession();
  window.setTimeout(() => go('home'), 500);
}

function rerender(): void { screenManager.render(app, store.get()); }

function bindLogin(root: HTMLElement) {
  bindCommon(root);
  root.querySelector('[data-action="login"]')?.addEventListener('click', () => {
    const phone = root.querySelector<HTMLInputElement>('#loginPhone')?.value ?? '';
    void loginWithOtp(phone).then((ok) => {
      if (ok) go('home');
      else rerender();
    });
  });
}

function bindCommon(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('[data-go]').forEach((el) => el.addEventListener('click', () => go(el.dataset.go as ScreenId)));
  root.querySelectorAll<HTMLElement>('[data-mode]').forEach((el) => el.addEventListener('click', () => {
    const mode = el.dataset.mode as GameModeId;
    store.set((draft) => { draft.match.mode = mode; });
    go('mode-entry');
  }));
  root.querySelector('[data-action="spin"]')?.addEventListener('click', openLuckyWheel);
  root.querySelector('[data-action="menu"]')?.addEventListener('click', showMainMenu);
  root.querySelector('[data-action="daily"]')?.addEventListener('click', showDailyRewards);
  root.querySelector('[data-action="opponent-profile"]')?.addEventListener('click', showOpponentProfile);
  root.querySelectorAll<HTMLElement>('[data-action^="retry-"]').forEach((el) => el.addEventListener('click', () => retryAction(el.dataset.action ?? '')));
}

function bindModeEntry(root: HTMLElement) {
  bindCommon(root);
  root.querySelectorAll<HTMLButtonElement>('[data-coin-stake]').forEach((button) => {
    button.addEventListener('click', () => {
      setPracticeCoinStake(Number(button.dataset.coinStake));
      rerender();
    });
  });
  root.querySelector('[data-action="start-mode"]')?.addEventListener('click', () => {
    const state = store.get();
    const mode = state.match.mode ?? 'duel';
    const cfg = gameConfig[mode];
    if (state.user.plan === 'free') {
      if (!spendPracticeEntry(state.economy.coinStake ?? cfg.entry?.free?.coins ?? 25)) return;
    } else {
      if (!spendPaidEntry(cfg.entry?.paid?.cash ?? 0)) return;
    }
    if (mode === 'duel') startDuelSearch();
    else go('result');
  });
}

function bindDuel(root: HTMLElement) {
  bindCommon(root);
  root.querySelectorAll<HTMLButtonElement>('[data-answer]').forEach((button) => button.addEventListener('click', () => answerDuel(Number(button.dataset.answer))));
  root.querySelectorAll<HTMLButtonElement>('[data-power]').forEach((button) => button.addEventListener('click', () => useDuelPowerup(button.dataset.power as 'fifty' | 'time' | 'stats')));
  root.querySelector('[data-action="duel-live-chat"]')?.addEventListener('click', () => {
    const input = root.querySelector<HTMLInputElement>('#duelLiveChatInput');
    sendRealtimeChat(input?.value ?? '');
    if (input) input.value = '';
  });
  root.querySelector<HTMLInputElement>('#duelLiveChatInput')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      sendRealtimeChat((event.target as HTMLInputElement).value);
      (event.target as HTMLInputElement).value = '';
    }
  });
}

function bindResult(root: HTMLElement) {
  bindCommon(root);
  root.querySelector('[data-action="rematch"]')?.addEventListener('click', () => startDuelSearch());
  root.querySelector('[data-action="friend-request"]')?.addEventListener('click', () => showSnackbar({ icon: '✅', message: 'درخواست دوستی ارسال شد' }));
}

function bindWallet(root: HTMLElement) {
  bindCommon(root);
  void hydrateWallet().then(rerender);
  root.querySelectorAll<HTMLButtonElement>('[data-wallet-tab]').forEach((button) => button.addEventListener('click', () => { setWalletTab(button.dataset.walletTab as any); rerender(); }));
  root.querySelector('[data-action="wallet-topup"]')?.addEventListener('click', () => void topupWallet(100000).then(() => { showSnackbar({ icon: '💰', message: 'کیف پول شارژ شد' }); rerender(); }));
  root.querySelector('[data-action="wallet-withdraw"]')?.addEventListener('click', () => void requestWithdraw(50000).then((ok) => { if (ok) showSnackbar({ icon: '↑', message: 'درخواست برداشت ثبت شد' }); rerender(); }));
}

function bindRankings(root: HTMLElement) {
  bindCommon(root);
  const kind = root.querySelector<HTMLElement>('[data-leaderboard-kind].active')?.dataset.leaderboardKind as any ?? 'weekly';
  subscribeLeaderboard(kind);
  void hydrateLeaderboard(kind).then(rerender);
  root.querySelectorAll<HTMLButtonElement>('[data-leaderboard-kind]').forEach((button) => button.addEventListener('click', () => {
    const next = button.dataset.leaderboardKind as any;
    setLeaderboardKind(next);
    subscribeLeaderboard(next);
    void hydrateLeaderboard(next).then(rerender);
    rerender();
  }));
}

function bindMissions(root: HTMLElement) {
  bindCommon(root);
  root.querySelectorAll<HTMLButtonElement>('[data-claim]').forEach((button) => {
    button.addEventListener('click', () => {
      if (claimMission(button.dataset.claim!)) {
        showSnackbar({ icon: '🎯', message: 'جایزه ماموریت دریافت شد' });
        rerender();
      }
    });
  });
}

function bindFriends(root: HTMLElement) {
  bindCommon(root);
  void hydrateFriends().then(rerender);
  root.querySelectorAll<HTMLButtonElement>('[data-friends-tab]').forEach((button) => button.addEventListener('click', () => { setFriendsTab(button.dataset.friendsTab as any); rerender(); }));
  root.querySelectorAll<HTMLElement>('[data-open-chat]').forEach((el) => el.addEventListener('click', () => { openChat(el.dataset.openChat!); rerender(); }));
  root.querySelector('[data-action="close-chat"]')?.addEventListener('click', () => { closeChat(); rerender(); });
  root.querySelector('[data-action="send-message"]')?.addEventListener('click', () => { const input = root.querySelector<HTMLInputElement>('#friendMessageInput'); sendMessage(input?.value ?? ''); rerender(); window.setTimeout(rerender, 900); });
  root.querySelectorAll<HTMLElement>('[data-invite]').forEach((el) => el.addEventListener('click', () => showInviteDialog(el.dataset.invite!)));
  root.querySelectorAll<HTMLElement>('[data-accept-request]').forEach((el) => el.addEventListener('click', () => { acceptRequest(el.dataset.acceptRequest!); rerender(); }));
  root.querySelectorAll<HTMLElement>('[data-decline-request]').forEach((el) => el.addEventListener('click', () => { declineRequest(el.dataset.declineRequest!); rerender(); }));
  root.querySelector('[data-action="send-friend-request"]')?.addEventListener('click', () => { const input = root.querySelector<HTMLInputElement>('#friendRequestInput'); void sendFriendRequest(input?.value ?? '').then((sent) => { if (sent) showSnackbar({ icon: '✅', message: 'درخواست دوستی ارسال شد' }); rerender(); }); });
}

function bindSupport(root: HTMLElement) {
  bindCommon(root);
  void hydrateSupport().then(rerender);
  root.querySelectorAll<HTMLButtonElement>('[data-support-tab]').forEach((button) => button.addEventListener('click', () => { setSupportTab(button.dataset.supportTab as any); rerender(); }));
  root.querySelector('[data-action="send-support-message"]')?.addEventListener('click', () => { const input = root.querySelector<HTMLInputElement>('#supportMessageInput'); sendSupportMessage(input?.value ?? ''); rerender(); window.setTimeout(rerender, 700); });
  root.querySelector('[data-action="create-ticket"]')?.addEventListener('click', () => { const title = root.querySelector<HTMLInputElement>('#ticketTitle')?.value ?? ''; const body = root.querySelector<HTMLTextAreaElement>('#ticketBody')?.value ?? ''; void createTicket(title, 'پشتیبانی', body).then((created) => { if (created) showSnackbar({ icon: '🎫', message: 'تیکت ثبت شد' }); rerender(); }); });
}


function retryAction(action: string): void {
  if (action === 'retry-wallet') void hydrateWallet().then(rerender);
  if (action === 'retry-friends') void hydrateFriends().then(rerender);
  if (action === 'retry-support') void hydrateSupport().then(rerender);
  if (action === 'retry-admin') void hydrateAdmin().then(rerender);
  if (action === 'retry-leaderboard') void hydrateLeaderboard().then(rerender);
  if (action === 'retry-notifications') void hydrateNotifications().then(rerender);
  if (action === 'retry-character') void hydrateCharacter().then(rerender);
}





function bindCharacter(root: HTMLElement) {
  bindCommon(root);
  void hydrateCharacter().then(rerender);
  root.querySelectorAll<HTMLButtonElement>('[data-character-state]').forEach((button) => button.addEventListener('click', () => {
    void equipCharacter({ state: button.dataset.characterState as any }).then(rerender);
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-character-slot]').forEach((button) => button.addEventListener('click', () => { setActiveCharacterSlot(button.dataset.characterSlot as any); rerender(); }));
  root.querySelectorAll<HTMLButtonElement>('[data-character-equip]').forEach((button) => button.addEventListener('click', () => {
    void equipCharacter({ slot: button.dataset.characterSlotEquip as any, itemId: button.dataset.characterEquip }).then(() => { showSnackbar({ icon:'🧬', message:'آیتم روی کاراکتر نصب شد' }); rerender(); });
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-character-buy]').forEach((button) => button.addEventListener('click', () => {
    void purchaseCharacterItem(button.dataset.characterBuy!).then((ok) => { if (ok) showSnackbar({ icon:'🪙', message:'آیتم کاراکتر باز شد' }); rerender(); });
  }));
  root.querySelector('[data-action="character-random"]')?.addEventListener('click', () => {
    void randomizeCharacter().then(() => { showSnackbar({ icon:'🎲', message:'استایل تصادفی شد' }); rerender(); });
  });
}

function bindSettings(root: HTMLElement) {
  bindCommon(root);
  void hydrateNotifications().then(rerender);
  root.querySelector('[data-action="enable-push"]')?.addEventListener('click', () => {
    void enablePushNotifications().then((result) => {
      const messages: Record<string, string> = { enabled: 'اعلان Push فعال شد', denied: 'اجازه اعلان داده نشد', unsupported: 'مرورگر از Push پشتیبانی نمی‌کند', 'missing-vapid': 'کلید Push در محیط تنظیم نشده است', failed: 'فعال‌سازی Push ناموفق بود' };
      showSnackbar({ icon: result === 'enabled' ? '🔔' : '⚠️', message: messages[result] ?? 'وضعیت اعلان مشخص نیست' });
      rerender();
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-pref-key]').forEach((button) => button.addEventListener('click', () => {
    void updateNotificationPreference(button.dataset.prefKey as any, button.dataset.prefValue === 'true').then((ok) => {
      if (ok) showSnackbar({ icon: '✅', message: 'تنظیم اعلان ذخیره شد' });
      rerender();
    });
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-notification-read]').forEach((button) => button.addEventListener('click', () => {
    void markNotificationRead(button.dataset.notificationRead!).then(rerender);
  }));
  root.querySelector('[data-action="notifications-read-all"]')?.addEventListener('click', () => {
    void markAllNotificationsRead().then(() => { showSnackbar({ icon: '✅', message: 'همه اعلان‌ها خوانده شد' }); rerender(); });
  });
}

function bindAdmin(root: HTMLElement) {
  bindCommon(root);
  void hydrateAdmin().then(rerender);
  root.querySelectorAll<HTMLButtonElement>('[data-admin-tab]').forEach((button) => button.addEventListener('click', () => { setAdminTab(button.dataset.adminTab as any); rerender(); }));
  root.querySelector('[data-action="save-admin-key"]')?.addEventListener('click', () => { const key = root.querySelector<HTMLInputElement>('#adminKeyInput')?.value ?? ''; setAdminKey(key); showSnackbar({ icon: '🔐', message: 'کلید ادمین ذخیره شد' }); void hydrateAdmin().then(rerender); });
  root.querySelector('[data-action="admin-beta-create"]')?.addEventListener('click',()=>{void createAdminBetaInvite({code:root.querySelector<HTMLInputElement>('#betaCodeInput')?.value||undefined,maxUses:Number(root.querySelector<HTMLInputElement>('#betaMaxInput')?.value||1),note:root.querySelector<HTMLInputElement>('#betaNoteInput')?.value||undefined}).then((ok)=>{if(ok)showSnackbar({icon:'🎟️',message:'کد دعوت بتا ساخته شد'});rerender();});});
  root.querySelectorAll<HTMLButtonElement>('[data-beta-code]').forEach((button)=>button.addEventListener('click',()=>{void updateAdminBetaInviteStatus(button.dataset.betaCode!, button.dataset.betaStatus as any).then(rerender);}));
  root.querySelectorAll<HTMLButtonElement>('[data-admin-user-overview]').forEach((button)=>button.addEventListener('click',()=>{void loadAdminUserOverview(button.dataset.adminUserOverview!).then(rerender);}));
  root.querySelectorAll<HTMLButtonElement>('[data-admin-user-status]').forEach((button)=>button.addEventListener('click',()=>{void setAdminUserStatus(button.dataset.adminUserId!, button.dataset.adminUserStatus as any, 'admin action').then(()=>{showSnackbar({icon:'👤',message:'وضعیت کاربر ذخیره شد'});rerender();});}));
  root.querySelectorAll<HTMLButtonElement>('[data-admin-user-role]').forEach((button)=>button.addEventListener('click',()=>{void setAdminUserRole(button.dataset.adminUserRoleId!, button.dataset.adminUserRole as any).then(()=>{showSnackbar({icon:'🔐',message:'نقش کاربر ذخیره شد'});rerender();});}));
  root.querySelector('[data-action="admin-character-upsert"]')?.addEventListener('click',()=>{void upsertCharacterCatalogItem({id:root.querySelector<HTMLInputElement>('#charItemId')?.value||'',slot:root.querySelector<HTMLSelectElement>('#charItemSlot')?.value as any,title:root.querySelector<HTMLInputElement>('#charItemTitle')?.value||'',src:root.querySelector<HTMLInputElement>('#charItemSrc')?.value||'',priceCoins:Number(root.querySelector<HTMLInputElement>('#charItemPrice')?.value||0),rarity:'common',tags:[]}).then((ok)=>{if(ok)showSnackbar({icon:'🧬',message:'آیتم کاراکتر ذخیره شد'});rerender();});});
  root.querySelectorAll<HTMLButtonElement>('[data-character-admin-id]').forEach((button)=>button.addEventListener('click',()=>{void updateCharacterCatalogStatus(button.dataset.characterAdminId!, button.dataset.characterAdminStatus as any).then(rerender);}));
  root.querySelector('[data-action="patch-duel-timer"]')?.addEventListener('click', () => { const seconds = Number(root.querySelector<HTMLInputElement>('#duelTimerInput')?.value ?? 10); void patchDuelTimer(seconds).then((ok) => { if (ok) showSnackbar({ icon: '⚙️', message: 'تنظیمات Duel ذخیره شد' }); rerender(); }); });
  root.querySelector('[data-action="save-admin-config"]')?.addEventListener('click', () => { const raw = root.querySelector<HTMLTextAreaElement>('#adminConfigText')?.value ?? '{}'; void saveConfigFromText(raw).then((ok) => { if (ok) showSnackbar({ icon: '✅', message: 'Config ذخیره شد' }); rerender(); }); });
  root.querySelector('[data-action="admin-create-question"]')?.addEventListener('click', () => { void createAdminQuestion({ text: root.querySelector<HTMLInputElement>('#adminQText')?.value ?? '', category: root.querySelector<HTMLInputElement>('#adminQCat')?.value ?? '', correct: root.querySelector<HTMLInputElement>('#adminQCorrect')?.value ?? '', wrong: root.querySelector<HTMLInputElement>('#adminQWrong')?.value ?? '' }).then((ok) => { if (ok) showSnackbar({ icon: '❓', message: 'سؤال ثبت شد' }); rerender(); }); });
  root.querySelectorAll<HTMLButtonElement>('[data-question-status]').forEach((button) => button.addEventListener('click', () => { void updateAdminQuestionStatus(button.dataset.questionId!, button.dataset.questionStatus!).then(rerender); }));
  root.querySelector<HTMLSelectElement>('#questionStatusFilter')?.addEventListener('change', (e) => { void setQuestionFilter((e.target as HTMLSelectElement).value).then(rerender); });
  root.querySelector('[data-action="admin-export-questions"]')?.addEventListener('click', () => { void exportQuestionsAsJson().then((data) => showModal({ icon:'📤', title:'Export Questions', body:'<textarea class="input code-area">'+data.replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]!))+'</textarea>', actions:[{label:'بستن',variant:'primary'}] })); });
  root.querySelector('[data-action="admin-import-questions"]')?.addEventListener('click', () => { const raw=root.querySelector<HTMLTextAreaElement>('#adminImportQuestions')?.value ?? '[]'; void importQuestionsFromText(raw).then((n)=>{showSnackbar({icon:'📥',message:n.toLocaleString('fa-IR')+' سؤال import شد'});rerender();}); });
  root.querySelectorAll<HTMLButtonElement>('[data-reward-mode]').forEach((button)=>button.addEventListener('click',()=>{const mode=button.dataset.rewardMode!;const raw=root.querySelector<HTMLTextAreaElement>('#reward_'+mode)?.value ?? '{}';void patchRewardConfig(mode,raw).then((ok)=>{if(ok)showSnackbar({icon:'🎁',message:'تنظیم جایزه ذخیره شد'});rerender();});}));
  root.querySelectorAll<HTMLButtonElement>('[data-monitor-report]').forEach((button)=>button.addEventListener('click',()=>{void updateMonitoringStatus(button.dataset.monitorReport!, button.dataset.monitorStatus as any).then(()=>{showSnackbar({icon:'🧯',message:'وضعیت گزارش خطا ذخیره شد'});rerender();});}));
  root.querySelectorAll<HTMLButtonElement>('[data-support-reply]').forEach((button)=>button.addEventListener('click',()=>{const id=button.dataset.supportReply!;const body=root.querySelector<HTMLInputElement>('#supportReply_'+id)?.value||'';void replySupportTicket(id,body).then(()=>{showSnackbar({icon:'🎧',message:'پاسخ پشتیبانی ثبت شد'});rerender();});}));
  root.querySelectorAll<HTMLButtonElement>('[data-support-ticket]').forEach((button)=>button.addEventListener('click',()=>{void updateSupportStatus(button.dataset.supportTicket!, button.dataset.supportStatus!).then(()=>{showSnackbar({icon:'🎧',message:'وضعیت تیکت ذخیره شد'});rerender();});}));
  root.querySelectorAll<HTMLButtonElement>('[data-withdrawal]').forEach((button)=>button.addEventListener('click',()=>{void updateWithdrawalStatus(button.dataset.withdrawal!, button.dataset.withdrawalAction as any).then(()=>{showSnackbar({icon:'💳',message:'وضعیت برداشت ثبت شد'});rerender();});}));
  root.querySelectorAll<HTMLButtonElement>('[data-reward-hold]').forEach((button)=>button.addEventListener('click',()=>{void updateRewardHoldStatus(button.dataset.rewardHold!, button.dataset.rewardHoldStatus as any).then(()=>{showSnackbar({icon:'🧾',message:'وضعیت جایزه ثبت شد'});rerender();});}));
  root.querySelectorAll<HTMLButtonElement>('[data-load-devices]').forEach((button)=>button.addEventListener('click',()=>{void loadUserDevices(button.dataset.loadDevices!).then(rerender);}));
  root.querySelectorAll<HTMLButtonElement>('[data-device-binding]').forEach((button)=>button.addEventListener('click',()=>{void updateDeviceStatus(button.dataset.deviceBinding!, button.dataset.deviceStatus as any).then(()=>{showSnackbar({icon:'📱',message:'وضعیت دستگاه ذخیره شد'});rerender();});}));
  root.querySelectorAll<HTMLButtonElement>('[data-integrity-id]').forEach((button)=>button.addEventListener('click',()=>{void updateIntegrityStatus(button.dataset.integrityId!, button.dataset.integrityStatus as any).then(()=>{showSnackbar({icon:'🛡️',message:'وضعیت سیگنال ثبت شد'});rerender();});}));
  root.querySelectorAll<HTMLButtonElement>('[data-flag-key]').forEach((button)=>button.addEventListener('click',()=>{void patchFlag(button.dataset.flagKey!, button.dataset.flagEnabled==='true').then(rerender);}));
  root.querySelector('[data-action="admin-broadcast-notification"]')?.addEventListener('click',()=>{void broadcastAdminNotification({type:(root.querySelector<HTMLSelectElement>('#adminNotificationType')?.value as any)||'system',title:root.querySelector<HTMLInputElement>('#adminNotificationTitle')?.value||'PrizzeQuizz',body:root.querySelector<HTMLTextAreaElement>('#adminNotificationBody')?.value||'',push:true}).then((ok)=>{if(ok)showSnackbar({icon:'🔔',message:'اعلان ارسال شد'});rerender();});});
  root.querySelector('[data-action="admin-upsert-theme"]')?.addEventListener('click',()=>{void upsertAdminTheme({name:root.querySelector<HTMLInputElement>('#themeName')?.value||'Theme',primary:root.querySelector<HTMLInputElement>('#themePrimary')?.value||'#FFD21F',accent:root.querySelector<HTMLInputElement>('#themeAccent')?.value||'#F5B90D'}).then((ok)=>{if(ok)showSnackbar({icon:'🎨',message:'Theme ذخیره شد'});rerender();});});
}

function showMainMenu(): void {
  showModal({
    icon: '☰',
    title: 'منوی سریع',
    body: 'برای توسعه، دسترسی سریع به صفحات اصلی و پنل ادمین فعال است.',
    actions: [
      { label: 'Admin', variant: 'primary', onClick: () => go('admin') },
      { label: 'تنظیمات', variant: 'ghost', onClick: () => go('settings') },
      { label: 'بستن', variant: 'ghost' }
    ]
  });
}

function showOpponentProfile() {
  const opponent = store.get().match.duel.opponent;
  showModal({
    hideIcon: true,
    title: opponent.name,
    body: `<div class="profile-single-avatar">${opponent.avatar}</div><b>حریف فعلی</b><br>لول ۵ · لیگ برنزی<br>نرخ موفقیت ۶۲٪`,
    actions: [
      { label: 'درخواست دوستی', variant: 'primary', onClick: () => showSnackbar({ icon: '✅', message: 'درخواست دوستی ارسال شد' }) },
      { label: 'بستن', variant: 'ghost' }
    ]
  });
}

function showInviteDialog(friendId: string): void {
  const friend = getFriends().find((f) => f.id === friendId);
  showModal({
    icon: '🎮',
    title: `دعوت ${friend?.name ?? 'دوست'} به بازی`,
    body: `<div class="invite-form"><label>مود بازی</label><select id="inviteMode"><option>Duel</option><option>Survival</option><option>Vote Mode</option><option>Solo</option></select><label>ورودی</label><select id="inviteEntry"><option>Free</option><option>10,000</option><option>20,000</option><option>50,000</option><option>100,000</option></select><p>قبل از ارسال، دوستت نوع بازی و ورودی را می‌بیند.</p></div>`,
    actions: [
      { label: 'ارسال دعوت', variant: 'primary', onClick: () => {
        const mode = (document.getElementById('inviteMode') as HTMLSelectElement | null)?.value ?? 'Duel';
        const entry = (document.getElementById('inviteEntry') as HTMLSelectElement | null)?.value ?? 'Free';
        void inviteFriend(friendId, mode, entry).then(() => showSnackbar({ icon: '✅', message: 'دعوت بازی ارسال شد' }));
      } },
      { label: 'انصراف', variant: 'ghost' }
    ]
  });
}

function showDailyRewards() {
  const state = getDailyState();
  const cells = dailyRewards.map((reward) => `<div class="daily-cell ${reward.day < state.day ? 'claimed' : reward.day === state.day ? 'today' : ''}"><span>${reward.icon}</span><b>روز ${reward.day.toLocaleString('fa-IR')}</b><small>${reward.label}</small></div>`).join('');
  showModal({
    icon: '🎁',
    title: 'پاداش روزانه',
    body: `<div class="daily-grid-modal">${cells}</div>`,
    actions: [
      { label: state.claimedToday ? 'دریافت شده' : 'دریافت امروز', variant: 'primary', onClick: () => {
        const reward = claimDailyReward();
        if (reward) showSnackbar({ icon: reward.icon, message: `${reward.label} دریافت شد` });
        rerender();
      } },
      { label: 'بستن', variant: 'ghost' }
    ]
  });
}

eventBus.on<Question>('QUESTION_LOADED', (question) => {
  setDuelQuestion(question);
  rerender();
});

eventBus.on<{ type: string; message: string }>('RESOURCE_MISSING', ({ type, message }) => {
  showSnackbar({ icon: type === 'hearts' ? '❤️' : type === 'cash' ? '💰' : '🪙', message, cta: type === 'hearts' ? 'فروشگاه' : 'ماموریت‌ها', onClick: () => go(type === 'cash' ? 'wallet' : 'missions') });
});

eventBus.on<{ won: boolean; coins: number }>('DUEL_FINISHED', ({ won, coins }) => {
  if (won && coins) showSnackbar({ icon: '🪙', message: `${coins.toLocaleString('fa-IR')} سکه دریافت شد` });
});

eventBus.on('FRIEND_INVITE_SENT', () => showSnackbar({ icon: '✅', message: 'دعوت بازی ارسال شد' }));


eventBus.on<{ online: boolean }>('NETWORK_OFFLINE', () => showSnackbar({ icon: '📡', message: 'اتصال اینترنت قطع شد' }));
eventBus.on<{ online: boolean }>('NETWORK_ONLINE', () => showSnackbar({ icon: '✅', message: 'اتصال اینترنت برقرار شد' }));
eventBus.on<{ message: string }>('API_ERROR', ({ message }) => showSnackbar({ icon: '⚠️', message }));
eventBus.on('REALTIME_RECONNECTING', () => showSnackbar({ icon: '🔄', message: 'در حال اتصال مجدد...' }));
eventBus.on('server:connected', () => showSnackbar({ icon: '🟢', message: 'اتصال زنده برقرار شد' }));
eventBus.on('server:leaderboard_update', () => rerender());
eventBus.on('REALTIME_ERROR', () => showSnackbar({ icon: '⚠️', message: 'اختلال در ارتباط زنده' }));

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => undefined));
}
