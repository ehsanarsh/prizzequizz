import type { AppState } from '../types/app';
import { topbar } from '../components/layout';
import { emptyState, errorState, skeletonList } from '../components/statusViews';
import { getAdminAnalytics, getBetaDiagnostics, getBetaInvites, getBetaUsers, getAdminCharacters, getAdminAuditLogs, getAdminConfig, getAdminKey, getAdminQuestions, getAdminTab, getAdminThemes, getAdminUsers, getSelectedUserOverview, getDatabaseVerification, getMigrationStatus, getDeviceDiagnostics, getFinanceDiagnostics, getFeatureFlags, getIntegrityDiagnostics, getIntegritySignals, getLeaderboardDiagnostics, getMonitoringDiagnostics, getErrorReports, getNotificationDiagnostics, getPaymentDiagnostics, getPaymentIntents, getQuestionFilter, getRiskUsers, getSupportDiagnostics, getAdminSupportTickets, getSelectedUserDevices, getRewardHoldDiagnostics, getRewardHolds, getWithdrawals, getRewardTuning } from '../features/admin/admin.state';

export function renderAdmin(state: AppState): string {
  const tab = getAdminTab();
  const loading = state.ui.loading['admin.hydrate'];
  const error = state.ui.errors['admin.hydrate'];
  return `<section class="screen admin pad">
    ${topbar('پنل ادمین', '<button class="iconbtn" data-go="home">→</button>')}
    <div class="admin-key-card"><b>کلید ادمین</b><input class="input" id="adminKeyInput" value="${getAdminKey()}"/><button class="primary" data-action="save-admin-key">ذخیره کلید</button></div>
    <div class="tabs small-tabs admin-tabs">
      ${tabButton('overview','داشبورد',tab)}${tabButton('beta','Beta',tab)}${tabButton('users','کاربران',tab)}${tabButton('characters','کاراکتر',tab)}${tabButton('config','Config',tab)}${tabButton('questions','سؤال‌ها',tab)}${tabButton('rewards','جوایز',tab)}${tabButton('rewardReview','Review',tab)}${tabButton('finance','Finance',tab)}${tabButton('payments','Payment',tab)}${tabButton('database','DB',tab)}${tabButton('supportOps','Support',tab)}${tabButton('leaderboards','رتبه‌ها',tab)}${tabButton('monitoring','Monitoring',tab)}${tabButton('notifications','اعلان‌ها',tab)}${tabButton('integrity','Anti-Cheat',tab)}${tabButton('devices','Devices',tab)}${tabButton('flags','Flags',tab)}${tabButton('themes','Theme',tab)}${tabButton('audit','Audit',tab)}
    </div>
    <div class="admin-content">${loading ? skeletonList(4) : error ? errorState(error,'retry-admin') : renderTab(tab)}</div>
  </section>`;
}

function renderTab(tab: string): string {
  if (tab === 'beta') return renderBeta();
  if (tab === 'users') return renderUsers();
  if (tab === 'characters') return renderCharacters();
  if (tab === 'config') return renderConfig();
  if (tab === 'questions') return renderQuestions();
  if (tab === 'rewards') return renderRewards();
  if (tab === 'rewardReview') return renderRewardReview();
  if (tab === 'finance') return renderFinance();
  if (tab === 'payments') return renderPayments();
  if (tab === 'database') return renderDatabase();
  if (tab === 'supportOps') return renderSupportOps();
  if (tab === 'leaderboards') return renderLeaderboards();
  if (tab === 'monitoring') return renderMonitoring();
  if (tab === 'notifications') return renderNotifications();
  if (tab === 'integrity') return renderIntegrity();
  if (tab === 'devices') return renderDevices();
  if (tab === 'flags') return renderFlags();
  if (tab === 'themes') return renderThemes();
  if (tab === 'audit') return renderAudit();
  return renderOverview();
}




function renderBeta(): string {
  const d = getBetaDiagnostics();
  const invites = getBetaInvites();
  const users = getBetaUsers();
  if (!d) return emptyState('🎟️','داده‌ای نیست','Beta diagnostics بعد از اتصال API نمایش داده می‌شود.');
  const rows = invites.length ? invites.map((i) => `<div class="beta-row"><div><b>${i.code}</b><small>${i.status} · ${fa(i.usedCount)}/${fa(i.maxUses)} · ${i.note ?? '-'}</small></div><button class="ghost" data-beta-code="${i.code}" data-beta-status="${i.status === 'active' ? 'disabled' : 'active'}">${i.status === 'active' ? 'Disable' : 'Activate'}</button></div>`).join('') : emptyState('🎟️','دعوتی نیست','کدهای بتا اینجا نمایش داده می‌شوند.');
  return `<div class="admin-kpis"><div><b>${d.required ? 'ON' : 'OFF'}</b><span>Required</span></div><div><b>${fa(d.activeInvites)}</b><span>Active</span></div><div><b>${fa(d.grantedUsers)}</b><span>Users</span></div><div><b>${fa(d.remainingUses)}</b><span>Uses</span></div></div><div class="list-card"><b>کد دعوت جدید</b><input class="input" id="betaCodeInput" placeholder="BETA-2026"/><input class="input" id="betaMaxInput" placeholder="تعداد استفاده" inputmode="numeric"/><input class="input" id="betaNoteInput" placeholder="یادداشت"/><button class="primary" data-action="admin-beta-create">ساخت دعوت</button></div><div class="list-card"><b>Beta users</b><p>${users.slice(0, 5).map((u) => `${u.userId} ← ${u.inviteCode}`).join('<br>') || '—'}</p></div>${rows}`;
}

function renderUsers(): string {
  const users = getAdminUsers();
  const selected = getSelectedUserOverview();
  const rows = users.length ? users.map((u) => `<div class="admin-user-row ${u.status}"><div><b>${escapeHtml(u.username)}</b><small>${u.id} · ${u.status} · ${u.role} · Risk ${fa(u.riskScore ?? 0)}</small></div><button class="ghost" data-admin-user-overview="${u.id}">View</button><button class="ghost" data-admin-user-status="${u.status === 'banned' ? 'active' : 'banned'}" data-admin-user-id="${u.id}">${u.status === 'banned' ? 'Unban' : 'Ban'}</button><button class="primary" data-admin-user-role="${u.role === 'admin' ? 'user' : 'admin'}" data-admin-user-role-id="${u.id}">${u.role === 'admin' ? 'User' : 'Admin'}</button></div>`).join('') : emptyState('👤','کاربری نیست','لیست کاربران اینجا نمایش داده می‌شود.');
  const detail = selected ? `<div class="list-card"><b>${escapeHtml(selected.user.username)} · ${selected.user.status}</b><p>Wallet: ${fa(selected.balances.wallet)} · Coins: ${fa(selected.balances.coins)} · Devices: ${fa(selected.devices.length)} · Tickets: ${fa(selected.tickets.length)} · Signals: ${fa(selected.integritySignals.length)}</p></div>` : '<div class="list-card"><b>جزئیات کاربر</b><p>برای مشاهده جزئیات، روی View کلیک کن.</p></div>';
  return `${detail}${rows}`;
}

function renderCharacters(): string {
  const items = getAdminCharacters();
  const rows = items.length ? items.map((item) => `<div class="character-admin-row"><div><b>${escapeHtml(item.title)}</b><small>${item.id} · ${item.slot} · ${item.rarity} · ${item.status ?? 'active'} · 🪙 ${fa(item.priceCoins)}</small></div><button class="ghost" data-character-admin-id="${item.id}" data-character-admin-status="${item.status === 'active' ? 'archived' : 'active'}">${item.status === 'active' ? 'Archive' : 'Activate'}</button></div>`).join('') : emptyState('🧬','آیتمی نیست','آیتم‌های کاراکتر اینجا نمایش داده می‌شود.');
  return `<div class="list-card"><b>آیتم جدید کاراکتر</b><input class="input" id="charItemId" placeholder="item_id"/><select class="input" id="charItemSlot"><option value="head">head</option><option value="body">body</option><option value="shoes">shoes</option></select><input class="input" id="charItemTitle" placeholder="عنوان"/><input class="input" id="charItemSrc" placeholder="/character-assets/...png"/><input class="input" id="charItemPrice" placeholder="قیمت سکه" inputmode="numeric"/><button class="primary" data-action="admin-character-upsert">ذخیره آیتم</button></div>${rows}`;
}

function renderOverview(): string {
  const a = getAdminAnalytics();
  if (!a) return emptyState('📊','داده‌ای نیست','داشبورد ادمین بعد از اتصال API نمایش داده می‌شود.');
  return `<div class="kpi-grid admin-kpis"><div><b>${fa(a.matches)}</b><span>مسابقه</span></div><div><b>${fa(a.questions)}</b><span>سؤال</span></div><div><b>${fa(a.transactions)}</b><span>تراکنش</span></div><div><b>${fa(a.rewards)}</b><span>پاداش</span></div></div><div class="list-card"><b>کاربران فعال تخمینی</b><p>${fa(a.activeUsersEstimate)}</p></div>`;
}

function renderConfig(): string {
  const cfg = getAdminConfig();
  const raw = cfg ? JSON.stringify(cfg, null, 2) : '{}';
  const duelTimer = (cfg as any)?.modes?.duel?.timerSeconds ?? 10;
  return `<div class="list-card"><b>ویرایش سریع Duel Timer</b><div class="admin-inline"><input class="input" id="duelTimerInput" inputmode="numeric" value="${duelTimer}"/><button class="primary" data-action="patch-duel-timer">ذخیره</button></div></div><div class="list-card"><b>Game Config JSON</b><textarea class="input code-area" id="adminConfigText">${escapeHtml(raw)}</textarea><button class="primary" data-action="save-admin-config">ذخیره Config</button></div>`;
}

function renderQuestions(): string {
  const qs = getAdminQuestions();
  const filter = getQuestionFilter();
  return `<div class="admin-toolbar"><select class="input" id="questionStatusFilter"><option value="approved" ${filter==='approved'?'selected':''}>Approved</option><option value="pending" ${filter==='pending'?'selected':''}>Pending</option><option value="rejected" ${filter==='rejected'?'selected':''}>Rejected</option><option value="" ${filter===''?'selected':''}>All</option></select><button class="ghost" data-action="admin-export-questions">Export JSON</button></div><div class="list-card"><b>Import JSON</b><textarea class="input code-area small" id="adminImportQuestions" placeholder='[{"text":"...","options":["a","b","c","d"],"correctIndex":0}]'></textarea><button class="primary" data-action="admin-import-questions">Import</button></div><div class="list-card"><b>سؤال جدید</b><input class="input" id="adminQText" placeholder="متن سؤال"/><input class="input" id="adminQCat" placeholder="دسته‌بندی"/><input class="input" id="adminQCorrect" placeholder="جواب درست"/><input class="input" id="adminQWrong" placeholder="سه گزینه غلط با / جدا شود"/><button class="primary" data-action="admin-create-question">ثبت سؤال</button></div>${qs.length ? qs.map((q) => `<div class="question-admin-row"><b>${q.text}</b><small>${q.category} · ${q.difficulty} · ${(q as any).status ?? 'approved'}</small><div><button class="primary" data-question-status="approved" data-question-id="${q.id}">تأیید</button><button class="ghost" data-question-status="rejected" data-question-id="${q.id}">رد</button></div></div>`).join('') : emptyState('❓','سؤالی نیست','سؤال‌های این فیلتر اینجا نمایش داده می‌شوند.')}`;
}

function renderRewards(): string {
  const data = getRewardTuning();
  if (!data) return emptyState('🎁','داده‌ای نیست','Reward tuning بعد از اتصال API نمایش داده می‌شود.');
  return Object.entries(data as any).map(([mode, cfg]) => `<div class="list-card"><b>${mode}</b><textarea class="input code-area small" id="reward_${mode}">${escapeHtml(JSON.stringify((cfg as any).reward ?? cfg, null, 2))}</textarea><button class="primary" data-reward-mode="${mode}">ذخیره جایزه</button></div>`).join('');
}





function renderSupportOps(): string {
  const d = getSupportDiagnostics();
  const tickets = getAdminSupportTickets();
  if (!d) return emptyState('🎧','داده‌ای نیست','Support operations بعد از اتصال API نمایش داده می‌شود.');
  const rows = tickets.length ? tickets.map((t) => `<div class="support-admin-row ${t.priority ?? 'normal'}"><div><b>${escapeHtml(t.title)}</b><small>${t.userId ?? '-'} · ${t.status} · ${t.priority ?? 'normal'} · ${t.category}</small><p>${escapeHtml(t.body.slice(0, 150))}</p><input class="input" id="supportReply_${t.id}" placeholder="پاسخ ادمین" value="${escapeHtml(t.reply ?? '')}"/></div><button class="primary" data-support-reply="${t.id}">Reply</button><button class="ghost" data-support-status="closed" data-support-ticket="${t.id}">Close</button><button class="ghost" data-support-status="escalated" data-support-ticket="${t.id}">Escalate</button></div>`).join('') : emptyState('✅','تیکتی نیست','صف پشتیبانی خالی است.');
  return `<div class="admin-kpis"><div><b>${fa(d.open)}</b><span>Open</span></div><div><b>${fa(d.answered)}</b><span>Answered</span></div><div><b>${fa(d.escalated)}</b><span>Escalated</span></div><div><b>${fa(d.unassigned)}</b><span>Unassigned</span></div></div>${rows}`;
}



function renderDatabase(): string {
  const d = getDatabaseVerification();
  const migrations = getMigrationStatus();
  if (!d) return emptyState('🗄️','داده‌ای نیست','Database verification بعد از اتصال API نمایش داده می‌شود.');
  const rows = migrations.length ? migrations.map((m) => `<div class="db-row"><b>${m.applied ? '✓' : '…'} ${m.version}</b><small>${m.appliedAt ?? 'pending'}</small></div>`).join('') : '<div class="list-card"><b>Migration status</b><p>DATABASE_URL تنظیم نشده یا migrationای یافت نشد.</p></div>';
  return `<div class="admin-kpis"><div><b>${d.ok ? 'OK' : 'FAIL'}</b><span>Schema</span></div><div><b>${fa(d.migrations.applied)}</b><span>Applied</span></div><div><b>${fa(d.migrations.pending)}</b><span>Pending</span></div><div><b>${fa(d.tables.filter(t=>t.ok).length)}/${fa(d.tables.length)}</b><span>Tables</span></div></div>${rows}`;
}

function renderPayments(): string {
  const d = getPaymentDiagnostics();
  const rows = getPaymentIntents();
  if (!d) return emptyState('💳','داده‌ای نیست','Payment diagnostics بعد از اتصال API نمایش داده می‌شود.');
  const list = rows.length ? rows.map((p) => `<div class="finance-row"><div><b>${p.provider} · ${fa(p.amount)}</b><small>${p.id} · ${p.status} · ${new Date(p.createdAt).toLocaleString('fa-IR')}</small></div><em>${p.status}</em></div>`).join('') : emptyState('💳','پرداختی نیست','Payment intentها اینجا نمایش داده می‌شوند.');
  return `<div class="admin-kpis"><div><b>${d.provider}</b><span>Provider</span></div><div><b>${fa(d.pending)}</b><span>Pending</span></div><div><b>${fa(d.paid)}</b><span>Paid</span></div><div><b>${fa(d.totalPaidAmount)}</b><span>Paid Amount</span></div></div>${list}`;
}

function renderFinance(): string {
  const d = getFinanceDiagnostics();
  const rows = getWithdrawals();
  if (!d) return emptyState('💳','داده‌ای نیست','Financial dashboard بعد از اتصال API نمایش داده می‌شود.');
  const withdrawals = rows.length ? rows.map((w) => `<div class="finance-row"><div><b>برداشت ${fa(w.amount)}</b><small>${w.id} · ${w.status} · ${new Date(w.createdAt).toLocaleString('fa-IR')}</small></div><button class="primary" data-withdrawal="${w.id}" data-withdrawal-action="approve">Approve</button><button class="ghost" data-withdrawal="${w.id}" data-withdrawal-action="reject">Reject</button></div>`).join('') : emptyState('✅','برداشت pending نیست','درخواستی برای بررسی مالی وجود ندارد.');
  return `<div class="admin-kpis"><div><b>${fa(d.totalTopups)}</b><span>Topups</span></div><div><b>${fa(d.pendingWithdrawAmount)}</b><span>Pending WD</span></div><div><b>${fa(d.totalRewardsPaid)}</b><span>Rewards Paid</span></div><div><b>${fa(d.netCashFlow)}</b><span>Net Cash</span></div></div><div class="list-card"><b>تعهدات مالی</b><p>Reward Hold: ${fa(d.pendingRewardHoldAmount)} · Withdraw Count: ${fa(d.pendingWithdrawCount)}</p></div>${withdrawals}`;
}

function renderRewardReview(): string {
  const d = getRewardHoldDiagnostics();
  const holds = getRewardHolds();
  if (!d) return emptyState('🧾','داده‌ای نیست','Reward review بعد از اتصال API نمایش داده می‌شود.');
  const rows = holds.length ? holds.map((h) => `<div class="reward-hold-row"><div><b>${h.rewardType} · ${fa(h.amount)}</b><small>${h.userId} · ${h.riskLevel} · Risk ${fa(h.riskScore)}</small><p>${escapeHtml(h.reason)} · ${new Date(h.createdAt).toLocaleString('fa-IR')}</p></div><button class="primary" data-reward-hold="${h.id}" data-reward-hold-status="approved">Approve</button><button class="ghost" data-reward-hold="${h.id}" data-reward-hold-status="rejected">Reject</button></div>`).join('') : emptyState('✅','صف بررسی خالی است','فعلاً جایزه‌ای در انتظار بررسی نیست.');
  return `<div class="admin-kpis"><div><b>${fa(d.pending)}</b><span>Pending</span></div><div><b>${fa(d.released)}</b><span>Released</span></div><div><b>${fa(d.rejected)}</b><span>Rejected</span></div><div><b>${fa(d.pendingAmount)}</b><span>Pending Amount</span></div></div>${rows}`;
}

function renderLeaderboards(): string {
  const d = getLeaderboardDiagnostics();
  if (!d) return emptyState('🏆','داده‌ای نیست','Diagnostics رتبه‌بندی بعد از اتصال API نمایش داده می‌شود.');
  return `<div class="admin-kpis"><div><b>${d.adapter}</b><span>Adapter</span></div><div><b>${d.fallbackAvailable ? 'OK' : 'NO'}</b><span>Fallback</span></div><div><b>${fa(d.boardSizes.weekly)}</b><span>Weekly rows</span></div><div><b>${fa(d.boardSizes.winnings)}</b><span>Winnings rows</span></div></div><div class="list-card"><b>Realtime Leaderboard</b><p>Redis URL: ${escapeHtml(d.redisUrl ?? 'memory')}</p><small>Last update: ${d.lastUpdatedAt ? new Date(d.lastUpdatedAt).toLocaleString('fa-IR') : '—'}</small></div>`;
}



function renderMonitoring(): string {
  const d = getMonitoringDiagnostics();
  const reports = getErrorReports();
  if (!d) return emptyState('🧯','داده‌ای نیست','Monitoring diagnostics بعد از اتصال API نمایش داده می‌شود.');
  const rows = reports.length ? reports.map((r) => `<div class="monitor-row ${r.severity}"><div><b>${escapeHtml(r.message.slice(0, 90))}</b><small>${r.source} · ${r.severity} · ${new Date(r.createdAt).toLocaleString('fa-IR')}</small><p>${escapeHtml((r.route ?? '').slice(0, 120))}</p></div><button class="ghost" data-monitor-report="${r.id}" data-monitor-status="triaged">Triage</button><button class="primary" data-monitor-report="${r.id}" data-monitor-status="resolved">Resolve</button><button class="ghost" data-monitor-report="${r.id}" data-monitor-status="ignored">Ignore</button></div>`).join('') : emptyState('✅','خطای باز نداریم','گزارش‌های خطای open اینجا نمایش داده می‌شوند.');
  return `<div class="admin-kpis"><div><b>${fa(d.open)}</b><span>Open</span></div><div><b>${fa(d.fatal)}</b><span>Fatal</span></div><div><b>${fa(d.frontend)}</b><span>Frontend</span></div><div><b>${fa(d.last24h)}</b><span>24h</span></div></div>${rows}`;
}

function renderNotifications(): string {
  const d = getNotificationDiagnostics();
  if (!d) return emptyState('🔔','داده‌ای نیست','Diagnostics اعلان‌ها بعد از اتصال API نمایش داده می‌شود.');
  return `<div class="admin-kpis"><div><b>${d.provider}</b><span>Provider</span></div><div><b>${d.vapidConfigured ? 'OK' : 'NO'}</b><span>VAPID</span></div><div><b>${fa(d.subscriptions)}</b><span>Subscription</span></div><div><b>${fa(d.unread)}</b><span>Unread</span></div></div><div class="list-card"><b>ارسال اعلان عمومی</b><select class="input" id="adminNotificationType"><option value="system">System</option><option value="match_update">Match</option><option value="leaderboard_update">Leaderboard</option><option value="wallet_update">Wallet</option><option value="promo">Promo</option></select><input class="input" id="adminNotificationTitle" placeholder="عنوان" value="پیام PrizzeQuizz"/><textarea class="input code-area small" id="adminNotificationBody" placeholder="متن اعلان"></textarea><button class="primary" data-action="admin-broadcast-notification">ارسال اعلان</button></div><div class="list-card"><b>وضعیت صف</b><p>Queued: ${fa(d.queued)} · Sent: ${fa(d.sent)} · Failed: ${fa(d.failed)}</p></div>`;
}


function renderIntegrity(): string {
  const d = getIntegrityDiagnostics();
  const signals = getIntegritySignals();
  if (!d) return emptyState('🛡️','داده‌ای نیست','Integrity diagnostics بعد از اتصال API نمایش داده می‌شود.');
  const rows = signals.length ? signals.map((s) => `<div class="integrity-row ${s.severity}"><div><b>${s.type}</b><small>${s.userId} · Risk ${fa(s.riskScore)} · ${new Date(s.createdAt).toLocaleString('fa-IR')}</small><p>${escapeHtml(JSON.stringify(s.evidence).slice(0, 140))}</p></div><div><em>${s.status}</em><button class="ghost" data-integrity-id="${s.id}" data-integrity-status="reviewing">Review</button><button class="primary" data-integrity-id="${s.id}" data-integrity-status="confirmed">Confirm</button><button class="ghost" data-integrity-id="${s.id}" data-integrity-status="dismissed">Dismiss</button></div></div>`).join('') : emptyState('✅','سیگنالی نیست','تا این لحظه رفتار مشکوکی ثبت نشده است.');
  return `<div class="admin-kpis"><div><b>${fa(d.openSignals)}</b><span>Open</span></div><div><b>${fa(d.criticalSignals)}</b><span>Critical</span></div><div><b>${fa(d.avgRiskScore)}</b><span>Avg Risk</span></div><div><b>${fa(d.confirmedSignals)}</b><span>Confirmed</span></div></div><div class="list-card"><b>Top Risk Users</b><p>${d.topRiskUsers.length ? d.topRiskUsers.map((u) => `${u.userId}: ${fa(u.riskScore)}`).join(' · ') : '—'}</p></div>${rows}`;
}


function renderDevices(): string {
  const d = getDeviceDiagnostics();
  const risks = getRiskUsers();
  const selected = getSelectedUserDevices();
  if (!d) return emptyState('📱','داده‌ای نیست','Device diagnostics بعد از اتصال API نمایش داده می‌شود.');
  const users = risks.length ? risks.map((u) => `<div class="device-risk-row"><div><b>${u.userId}</b><small>${u.riskLevel} · Risk ${fa(u.riskScore)} · ${u.reasons.join('، ') || 'بدون دلیل'}</small></div><button class="ghost" data-load-devices="${u.userId}">Devices</button></div>`).join('') : emptyState('✅','کاربر پرریسکی نیست','هنوز پروفایل پرریسکی ثبت نشده است.');
  const devices = selected.length ? selected.map((b) => `<div class="device-risk-row"><div><b>${b.device?.platform ?? b.deviceId}</b><small>${b.trustStatus} · Risk ${fa(b.riskScore)} · Shared ${fa(b.sharedUsers ?? 1)}</small></div><button class="ghost" data-device-binding="${b.id}" data-device-status="trusted">Trust</button><button class="ghost" data-device-binding="${b.id}" data-device-status="limited">Limit</button><button class="primary" data-device-binding="${b.id}" data-device-status="revoked">Revoke</button></div>`).join('') : '<div class="list-card"><b>Device bindings</b><p>برای دیدن دستگاه‌ها روی Devices کنار کاربر کلیک کن.</p></div>';
  return `<div class="admin-kpis"><div><b>${fa(d.devices)}</b><span>Devices</span></div><div><b>${fa(d.bindings)}</b><span>Bindings</span></div><div><b>${fa(d.sharedDevices)}</b><span>Shared</span></div><div><b>${fa(d.criticalRiskUsers)}</b><span>Critical Users</span></div></div><div class="list-card"><b>Risk Users</b></div>${users}<div class="list-card"><b>Selected User Devices</b></div>${devices}`;
}

function renderFlags(): string {
  const flags = getFeatureFlags();
  return flags.length ? flags.map((f) => `<div class="flag-row"><div><b>${f.key}</b><small>${f.description}</small></div><button class="${f.enabled?'primary':'ghost'}" data-flag-key="${f.key}" data-flag-enabled="${!f.enabled}">${f.enabled?'فعال':'غیرفعال'}</button></div>`).join('') : emptyState('🚩','فلگی نیست','Feature flagها اینجا نمایش داده می‌شوند.');
}

function renderThemes(): string {
  const themes = getAdminThemes();
  return `<div class="list-card"><b>Theme جدید</b><input class="input" id="themeName" placeholder="نام"/><input class="input" id="themePrimary" placeholder="#FFD21F"/><input class="input" id="themeAccent" placeholder="#F5B90D"/><button class="primary" data-action="admin-upsert-theme">ثبت Theme</button></div>${themes.map((t) => `<div class="theme-row"><span style="--c:${t.primary}"></span><div><b>${t.name}</b><small>${t.primary} · ${t.accent}</small></div><em>${t.enabled?'فعال':'خاموش'}</em></div>`).join('')}`;
}

function renderAudit(): string {
  const logs = getAdminAuditLogs();
  return logs.length ? logs.map((l) => `<div class="list-card"><b>${l.action}</b><p>${l.targetType} · ${l.targetId ?? '-'}</p><small>${new Date(l.createdAt).toLocaleString('fa-IR')}</small></div>`).join('') : emptyState('📜','لاگی ثبت نشده','تغییرات ادمین اینجا ثبت می‌شود.');
}

function tabButton(id: string, label: string, active: string): string { return `<button class="${id===active?'active':''}" data-admin-tab="${id}">${label}</button>`; }
function fa(n: number): string { return Number(n).toLocaleString('fa-IR'); }
function escapeHtml(value: string): string { return value.replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]!)); }
