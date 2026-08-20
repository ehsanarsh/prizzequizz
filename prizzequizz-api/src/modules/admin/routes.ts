import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { getEditableGameConfig, patchGameConfig, updateGameConfig, updateModeConfig, validateGameConfig } from '../../services/configService.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { repositories } from '../../repositories/index.js';
import { db } from '../../repositories/memory.js';
import { id } from '../../utils/id.js';
import { featureFlags, patchFeatureFlag, themes, upsertTheme } from '../../services/adminStores.js';
import { getAdminAnalytics } from '../../services/analyticsService.js';
import { getAdminUserOverview, resetUserStats, searchAdminUsers, setUserTickets, updateUserFields, updateUserRole, updateUserStatus } from '../../services/adminUserService.js';
import { getMatch, claimTimeout, forfeitMatch } from '../../services/matchEngine.js';
import { activeMatchState } from '../../services/matchStateStore.js';
import { createGiftCode, listGiftCodes, redeemGiftCode } from '../../services/giftCodeService.js';
import { aiGenerate, approve as approvePipeline, createDraft, getMeta as getPipelineMeta, listPipeline, reject as rejectPipeline, runPipeline } from '../../services/questionPipelineService.js';
import { listAdminAudit, recordAdmin } from '../../services/adminAuditService.js';
import { listPartners, savePartner, removePartner, addCodes, listCodes, stock as payoutStock, PayoutError } from '../../services/payoutPartnerService.js';
import { getOtpSettings, setOtpSettings } from '../../services/withdrawOtpService.js';
import { getSmsConfig, smsIsLive } from '../../services/smsService.js';
import { listReports, reportCounts, setReportStatus } from '../../services/questionReportService.js';
import { RESET_AREAS, type ResetArea, dashboardMetrics, financeSummary, finishedMatches, resetArea, runningMatches, suspiciousUsers } from '../../services/adminOpsService.js';
import { currentMatchOf } from '../../services/matchEngine.js';
import { getAccount } from '../../services/walletLedgerService.js';
import { matchmakingQueue } from '../../services/matchmakingQueue.js';
import { leaderboards } from '../../services/leaderboardService.js';
import { notifications } from '../../services/notificationService.js';
import { PushConfigError, effectivePushConfig, generateKeys, loadStoredConfig, maskPushConfig, savePushConfig } from '../../services/pushConfigService.js';
import { RewardsError, getConfig as getRewardsConfig, saveConfig as saveRewardsConfig } from '../../services/rewardsService.js';
import { getRecordConfig, saveRecordConfig } from '../../services/recordModeService.js';
import { createScheduled, listScheduled, cancelScheduled } from '../../services/scheduledNotificationService.js';
import { resolveSegment, resolveRecipients, describeSegment, type SegmentSpec } from '../../services/notificationSegmentService.js';
import { createCampaign, recordCampaignResult, listCampaigns, campaignAnalytics, campaignDashboard } from '../../services/notificationCampaignService.js';
import { listItems as shopList, saveItem as shopSave, removeItem as shopRemove, seedMissing as shopSeedMissing } from '../../services/shopService.js';
import { login as adminLogin, listAccounts, createAccount, updateAccount, deleteAccount, changeOwnPassword, resolveTokenSync, ADMIN_TABS } from '../../services/adminAccountService.js';
import { currentAdmin } from '../../services/adminGuard.js';
import { badgeCounts, markScreenSeen, isQueueScreen } from '../../services/adminBadgeService.js';
import { getOnlineConfig, setOnlineConfig } from '../../services/onlinePlayersService.js';
import { listSubmissions as listUserQuestions, submissionCounts, reviewSubmission, getQuizMakerConfig, setQuizMakerConfig, UserQuestionError } from '../../services/userQuestionService.js';
import { getPolicy, setPolicy, NOTIFICATION_TYPES, NOTIFICATION_TYPE_LABELS } from '../../services/notificationPolicyService.js';
import { financeDiagnostics, listWithdrawals, reviewWithdrawal, transactionsToCsv } from '../../services/financeService.js';
import { listRewardHolds, rewardHoldDiagnostics, reviewRewardHold } from '../../services/rewardReviewService.js';
import { integrity } from '../../services/integrityService.js';
import { calculateUserRisk, deviceDiagnostics, listCurrentUserDevices, updateDeviceBindingStatus } from '../../services/deviceRiskService.js';
import type { DeviceTrustStatus, IntegritySeverity, IntegrityStatus, NotificationType, RewardHoldStatus } from '../../types/domain.js';
import type { Question } from '../../types/domain.js';
import { financeReport, listExpenses, saveExpense, deleteExpense, setServerHourlyCost, reportToCsv, reportToPdf, EXPENSE_CATEGORIES } from '../../services/accountingService.js';
import { securityAlerts } from '../../services/securityAlertService.js';
import { streamBackup, backupFilename, BACKUP_TABLES } from '../../services/backupService.js';
import {
  CATEGORY_IMAGE_MAX_BYTES, CategoryImageError, categoryImageUrls, removeCategoryImage,
  renameCategoryImage, saveCategoryImage
} from '../../services/categoryImageService.js';
import {
  MissionError, METRICS as MISSION_METRICS, deleteDef as deleteMission,
  listDefs as listMissions, saveDef as saveMission
} from '../../services/missionService.js';

/* An unissued code is a secret worth money: shown as ABCD••••WXYZ so an
 * operator can tell rows apart without the panel becoming a place to harvest
 * unused credit. */
function maskCode(code: string): string {
  const c = String(code ?? '');
  if (c.length <= 8) return c.slice(0, 2) + '••••';
  return c.slice(0, 4) + '••••' + c.slice(-4);
}

/* Who is looking. The master key is one identity; every other admin is their
 * own, so their badges are their own. */
function badgeAdminId(ctx: any): string {
  const who = currentAdmin(ctx);
  return who.account?.id ? 'acc:' + who.account.id : 'master';
}

export function registerAdminRoutes(router: Router, base: string): void {
  /* ===== What is new, and where =====
   * Nothing on the panel moves when a payout request or a support ticket
   * arrives, so the only way to find one was to open every tab. These two
   * endpoints are what the sidebar counts come from.
   *
   * The mark is per admin account: two people share the panel, and one of them
   * opening the finance tab must not clear the other's badge. */
  router.add('GET', `${base}/admin/badges`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await badgeCounts(badgeAdminId(ctx), (ctx as any).adminPerms));
  });
  router.add('POST', `${base}/admin/badges/seen`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const screen = String(((ctx.body ?? {}) as any).screen || '').trim().slice(0, 60);
    if (!screen) return error(ctx.res, 422, 'SCREEN_REQUIRED', 'کدام صفحه؟');
    /* The previous mark, not the new one — everything after it is what this
     * admin is about to see for the first time, and that is what the table
     * tags «جدید». Returning the new mark would tag nothing, ever. */
    const previous = await markScreenSeen(badgeAdminId(ctx), screen);
    json(ctx.res, 200, { screen, previous, isQueue: isQueueScreen(screen) });
  });

  /* ===== Questions players wrote =====
   * The «کوییزساز» screen used to throw the question away. These are the panel
   * end: what came in, publish it or turn it down, and what approving pays. */
  router.add('GET', `${base}/admin/user-questions`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'questions' })) return;
    const status = String(ctx.query.get('status') || 'pending');
    json(ctx.res, 200, {
      rows: await listUserQuestions({ status, limit: Number(ctx.query.get('limit') ?? 200) }),
      counts: await submissionCounts(),
      config: await getQuizMakerConfig()
    });
  });
  router.add('POST', `${base}/admin/user-questions/:id/review`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'questions' })) return;
    const action = String(((ctx.body ?? {}) as any).action || '');
    if (action !== 'approve' && action !== 'reject') return error(ctx.res, 422, 'ACTION_INVALID', 'تأیید یا رد؟');
    try {
      const r = await reviewSubmission(String(ctx.params.id), action as 'approve' | 'reject');
      await recordAdmin({ action: 'user_question_' + action, meta: r as any });
      json(ctx.res, 200, r);
    } catch (e) {
      if (e instanceof UserQuestionError) return error(ctx.res, 404, e.code, e.message);
      throw e;
    }
  });
  /* «افراد آنلاین» on the home screen: how many faces, and what looking again
   * costs. The price was a constant nobody could change without a deploy. */
  router.add('GET', `${base}/admin/online-config`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'users' })) return;
    json(ctx.res, 200, await getOnlineConfig());
  });
  router.add('PUT', `${base}/admin/online-config`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'users' })) return;
    const next = await setOnlineConfig((ctx.body ?? {}) as any);
    await recordAdmin({ action: 'online_players_config', meta: next as any });
    json(ctx.res, 200, next);
  });

  router.add('PUT', `${base}/admin/user-questions/config`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'questions' })) return;
    const next = await setQuizMakerConfig((ctx.body ?? {}) as any);
    await recordAdmin({ action: 'quiz_maker_config', meta: next as any });
    json(ctx.res, 200, next);
  });

  /* ===== The code that guards a payout =====
   * It was the constant "1234", identical for every player and never sent.
   * The operator can now switch the requirement off, change its length and
   * timings, and see at a glance whether SMS is really live — because when it
   * is not, the test code works and that must never be a surprise. */
  router.add('GET', `${base}/admin/withdraw-otp`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const cfg = await getSmsConfig();
    const live = smsIsLive(cfg);
    json(ctx.res, 200, {
      settings: await getOtpSettings(),
      smsLive: live,
      /* In test mode this is the code that will work, so the panel can say so
       * rather than leaving the operator to discover it. */
      testCode: live ? null : (cfg.otp?.testCode || '1234')
    });
  });
  router.add('PUT', `${base}/admin/withdraw-otp`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const b = (ctx.body ?? {}) as any;
    const next = await setOtpSettings(b);
    await recordAdmin({ action: 'withdraw_otp_settings', meta: next as any });
    json(ctx.res, 200, next);
  });

  /* ===== Non-cash prize payouts: partners and their code stock =====
   * A prize can leave as a bank transfer or as credit with a partner. Until a
   * partner offers an API, the codes are a shelf the operator stocks here.
   * Every figure below is counted from real rows — a partner with an empty
   * shelf is never offered to a player. */
  router.add('GET', `${base}/admin/payout-partners`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const partners = await listPartners({ includeDisabled: true });
    const withStock = [];
    for (const p of partners) {
      const st = await payoutStock(p.id);
      withStock.push({
        ...p,
        stock: p.denominations.map((amt: number) => ({ amount: amt, available: st[amt] ?? 0 })),
        totalAvailable: Object.values(st).reduce((n: number, c: number) => n + c, 0)
      });
    }
    json(ctx.res, 200, withStock);
  });

  router.add('POST', `${base}/admin/payout-partners`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const b = (ctx.body ?? {}) as any;
    try {
      const p = await savePartner({ id: b.id, name: String(b.name ?? ''), logo: b.logo, enabled: b.enabled, denominations: b.denominations, instructions: b.instructions });
      await recordAdmin({ action: 'payout_partner_saved', meta: { partnerId: p.id, name: p.name } });
      json(ctx.res, 200, p);
    } catch (e) {
      if (e instanceof PayoutError) return error(ctx.res, 400, e.code, e.message);
      throw e;
    }
  });

  router.add('DELETE', `${base}/admin/payout-partners/:id`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const gone = await removePartner(ctx.params.id!);
    await recordAdmin({ action: 'payout_partner_removed', meta: { partnerId: ctx.params.id } });
    json(ctx.res, 200, { removed: gone });
  });

  /* Loading stock. Codes arrive as a pasted list — one per line, or comma
   * separated — and re-uploading the same list adds nothing, so an operator
   * who pastes twice does not double the shelf. */
  router.add('POST', `${base}/admin/payout-partners/:id/codes`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const b = (ctx.body ?? {}) as any;
    const raw = String(b.codes ?? '');
    const codes = Array.isArray(b.codes) ? b.codes.map(String) : raw.split(/[\r\n,;\t]+/);
    try {
      const r = await addCodes(ctx.params.id!, Number(b.amount), codes);
      await recordAdmin({ action: 'payout_codes_added', meta: { partnerId: ctx.params.id, amount: Number(b.amount), added: r.added, skipped: r.skipped } });
      json(ctx.res, 200, r);
    } catch (e) {
      if (e instanceof PayoutError) return error(ctx.res, 400, e.code, e.message);
      throw e;
    }
  });

  /* The shelf itself. Codes are secrets, so an available one is never printed
   * in full here — only what was already given to a player can be, because the
   * player already has it and support needs to be able to see it. */
  router.add('GET', `${base}/admin/payout-codes`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const rows = await listCodes({
      partnerId: ctx.query.get('partnerId') || undefined,
      status: (ctx.query.get('status') as any) || undefined,
      limit: Number(ctx.query.get('limit') ?? 200)
    });
    json(ctx.res, 200, rows.map((c) => ({
      ...c,
      code: c.status === 'issued' ? c.code : maskCode(c.code)
    })));
  });


  // ===== Admin auth + accounts (per-tab access control) =====
  // Login with username+password → returns a session token (used as x-admin-key).
  router.add('POST', `${base}/admin/auth/login`, async (ctx) => {
    const b = (ctx.body ?? {}) as any;
    const acc = await adminLogin(String(b.username ?? ''), String(b.password ?? ''));
    if (!acc) return error(ctx.res, 401, 'LOGIN_FAILED', 'نام کاربری یا رمز عبور نادرست است.');
    json(ctx.res, 200, { token: acc.token, username: acc.username, perms: acc.perms, isOwner: acc.isOwner });
  });
  // Who am I + my permissions (the panel uses this to build the nav it can see).
  router.add('GET', `${base}/admin/auth/me`, (ctx) => {
    if (!requireAdmin(ctx)) return;
    const me = currentAdmin(ctx);
    json(ctx.res, 200, { master: me.master, username: me.account?.username ?? 'owner', isOwner: me.master || !!me.account?.isOwner, perms: me.perms, tabs: ADMIN_TABS });
  });
  // Change my own password (rotates my token; the panel re-logs in with the new).
  router.add('POST', `${base}/admin/auth/password`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const b = (ctx.body ?? {}) as any;
    const key = String(ctx.req.headers['x-admin-key'] ?? '');
    const acc = resolveTokenSync(key);
    if (!acc) return error(ctx.res, 400, 'NO_ACCOUNT', 'این نشست با کلید اصلی (env) است؛ رمزِ کلید اصلی از سرور تنظیم می‌شود، نه از پنل. برای تغییر رمز، با یک حساب کاربری وارد شو.');
    const r = await changeOwnPassword(acc.id, String(b.current ?? ''), String(b.next ?? ''));
    if (!r.ok) return error(ctx.res, 400, r.error ?? 'FAILED', r.error === 'CURRENT_WRONG' ? 'رمز فعلی نادرست است.' : r.error === 'PASSWORD_TOO_SHORT' ? 'رمز جدید خیلی کوتاه است.' : 'تغییر رمز ناموفق بود.');
    json(ctx.res, 200, { ok: true, token: r.token });
  });
  // Account management — owner/master only.
  router.add('GET', `${base}/admin/accounts`, async (ctx) => {
    if (!requireAdmin(ctx, { ownerOnly: true })) return;
    json(ctx.res, 200, { rows: await listAccounts(), tabs: ADMIN_TABS });
  });
  router.add('POST', `${base}/admin/accounts`, async (ctx) => {
    if (!requireAdmin(ctx, { ownerOnly: true })) return;
    const b = (ctx.body ?? {}) as any;
    try {
      const acc = await createAccount({ username: String(b.username ?? ''), password: String(b.password ?? ''), perms: Array.isArray(b.perms) ? b.perms : [], createdBy: currentAdmin(ctx).account?.username ?? 'owner' });
      audit(ctx.userId, 'ADMIN_ACCOUNT_CREATED', 'admin_account', acc.id, { username: acc.username, perms: acc.perms });
      json(ctx.res, 201, { id: acc.id, username: acc.username, perms: acc.perms });
    } catch (e) {
      const c = e instanceof Error ? e.message : 'FAILED';
      return error(ctx.res, 422, c, c === 'USERNAME_TAKEN' ? 'این نام کاربری قبلاً وجود دارد.' : c === 'USERNAME_INVALID' ? 'نام کاربری نامعتبر است (فقط حروف/عدد، حداقل ۳ کاراکتر).' : c === 'PASSWORD_TOO_SHORT' ? 'رمز عبور خیلی کوتاه است.' : 'ساخت حساب ناموفق بود.');
    }
  });
  router.add('PATCH', `${base}/admin/accounts/:id`, async (ctx) => {
    if (!requireAdmin(ctx, { ownerOnly: true })) return;
    const b = (ctx.body ?? {}) as any;
    const ok = await updateAccount(ctx.params.id!, { perms: Array.isArray(b.perms) ? b.perms : undefined, password: b.password ? String(b.password) : undefined, active: typeof b.active === 'boolean' ? b.active : undefined });
    if (!ok) return error(ctx.res, 404, 'ACCOUNT_NOT_FOUND', 'حساب یافت نشد یا قابل تغییر نیست (مدیر کل).');
    audit(ctx.userId, 'ADMIN_ACCOUNT_UPDATED', 'admin_account', ctx.params.id, { fields: Object.keys(b) });
    json(ctx.res, 200, { updated: true });
  });
  router.add('DELETE', `${base}/admin/accounts/:id`, async (ctx) => {
    if (!requireAdmin(ctx, { ownerOnly: true })) return;
    const ok = await deleteAccount(ctx.params.id!);
    if (!ok) return error(ctx.res, 404, 'ACCOUNT_NOT_FOUND', 'حساب یافت نشد یا قابل حذف نیست (مدیر کل).');
    audit(ctx.userId, 'ADMIN_ACCOUNT_DELETED', 'admin_account', ctx.params.id, {});
    json(ctx.res, 200, { deleted: true });
  });

  router.add('GET', `${base}/admin/config`, (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, getEditableGameConfig());
  });

  router.add('PUT', `${base}/admin/config`, (ctx) => {
    if (!requireAdmin(ctx)) return;
    const body = ctx.body as any;
    const validation = validateGameConfig(body);
    if (!validation.valid) return error(ctx.res, 422, 'CONFIG_INVALID', 'Invalid game config.', { errors: validation.errors });
    const before = getEditableGameConfig();
    const updated = updateGameConfig(body);
    audit(ctx.userId, 'CONFIG_UPDATED', 'game_config', body.version, { beforeVersion: before.version, afterVersion: body.version });
    json(ctx.res, 200, updated);
  });

  router.add('PATCH', `${base}/admin/config/modes/:modeId`, (ctx) => {
    if (!requireAdmin(ctx)) return;
    const updated = updateModeConfig(ctx.params.modeId!, ctx.body, ctx.userId);
    audit(ctx.userId, 'MODE_CONFIG_PATCHED', 'mode_config', ctx.params.modeId, { patch: ctx.body as Record<string, unknown> });
    json(ctx.res, 200, updated);
  });

  // Partial config patch — the admin panel edits a few fields (rake %, ticket
  // prices, wallet limits, a mode's stake) and sends just those; deep-merged,
  // validated, and PERSISTED so it survives restarts.
  router.add('PATCH', `${base}/admin/config`, (ctx) => {
    if (!requireAdmin(ctx)) return;
    try {
      const updated = patchGameConfig(ctx.body, ctx.userId);
      audit(ctx.userId, 'CONFIG_PATCHED', 'game_config', updated.version, { patch: ctx.body as Record<string, unknown> });
      json(ctx.res, 200, updated);
    } catch (e) {
      return error(ctx.res, 422, 'CONFIG_INVALID', e instanceof Error ? e.message : 'Invalid config patch.');
    }
  });

  /* ---------------- TOPIC ARTWORK ----------------
   * A picture per category, shown wherever a topic is named — the duel picker,
   * the Last Survivor topic list, the record board. The panel shrinks the file
   * to a small square before sending it as a data URI; this validates the type,
   * checks the magic bytes and hard-caps the size. Stored in its own table, so
   * the public config carries a URL and never the bytes. */
  router.add('GET', `${base}/admin/categories/images`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, { images: await categoryImageUrls(), maxBytes: CATEGORY_IMAGE_MAX_BYTES });
  });

  router.add('POST', `${base}/admin/categories/:name/image`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const name = decodeURIComponent(ctx.params.name ?? '');
    const b = (ctx.body ?? {}) as any;
    try {
      const saved = await saveCategoryImage(name, String(b.image ?? ''));
      audit(ctx.userId, 'CATEGORY_IMAGE_SET', 'category', name, { bytes: saved.bytes, mime: saved.mime });
      json(ctx.res, 200, { name, ...saved, maxBytes: CATEGORY_IMAGE_MAX_BYTES });
    } catch (e) {
      if (e instanceof CategoryImageError) return error(ctx.res, 422, e.code, e.message);
      throw e;
    }
  });

  router.add('DELETE', `${base}/admin/categories/:name/image`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const name = decodeURIComponent(ctx.params.name ?? '');
    const removed = await removeCategoryImage(name);
    if (removed) audit(ctx.userId, 'CATEGORY_IMAGE_REMOVED', 'category', name, {});
    json(ctx.res, 200, { name, removed });
  });

  /* Renaming a topic in the panel would otherwise orphan its picture, since the
   * artwork is keyed by name. The panel calls this as part of saving a rename
   * so the admin does not have to upload the same file again. */
  router.add('POST', `${base}/admin/categories/image/rename`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const b = (ctx.body ?? {}) as any;
    const moved = await renameCategoryImage(String(b.from ?? ''), String(b.to ?? ''));
    if (moved) audit(ctx.userId, 'CATEGORY_IMAGE_RENAMED', 'category', String(b.to ?? ''), { from: b.from });
    json(ctx.res, 200, { moved });
  });

  router.add('GET', `${base}/admin/questions`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const status = ctx.query.get('status') || undefined;
    const all = await repositories.questions.listAll(status);
    json(ctx.res, 200, all);
  });

  // Diagnostic: difficulty distribution of the APPROVED bank, overall and per
  // category. If almost everything is «easy», adaptive difficulty has nothing
  // harder to serve — the fix is data (import questions carrying real levels).
  router.add('GET', `${base}/admin/questions/difficulty-stats`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const all = await repositories.questions.listAll('approved');
    const levels = ['easy', 'medium', 'hard', 'veryhard'];
    const blank = () => Object.fromEntries(levels.map((l) => [l, 0])) as Record<string, number>;
    const overall = blank();
    const byCategory: Record<string, Record<string, number>> = {};
    let other = 0;
    for (const q of all) {
      const d = String(q.difficulty || '');
      if (levels.includes(d)) { overall[d]! += 1; } else { other += 1; }
      const cat = q.category || 'بدون‌دسته';
      (byCategory[cat] ??= blank());
      if (levels.includes(d)) byCategory[cat]![d]! += 1;
    }
    json(ctx.res, 200, { totalApproved: all.length, overall, other, byCategory });
  });

  router.add('GET', `${base}/admin/questions/export`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const status = ctx.query.get('status') || undefined;
    const format = ctx.query.get('format') || 'json';
    const all = await repositories.questions.listAll(status);
    if (format === 'csv') {
      const csv = ['id,text,category,difficulty,correctIndex,status', ...all.map(q => [q.id, q.text, q.category, q.difficulty, q.correctIndex, q.status].map(v => '"'+String(v).replaceAll('"','""')+'"').join(','))].join('\n');
      ctx.res.statusCode = 200;ctx.res.setHeader('content-type','text/csv; charset=utf-8');ctx.res.end(csv);return;
    }
    json(ctx.res, 200, all);
  });

  router.add('POST', `${base}/admin/questions/import`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const body = ctx.body as any;
    const items = Array.isArray(body?.questions) ? body.questions
      : (Array.isArray(body) ? body : []);  // accept a bare array too
    // Existing texts (normalized) for in-DB duplicate detection.
    const existing = new Set((await repositories.questions.listAll().catch(() => [])).map((x) => normText(x.text)));
    const seen = new Set<string>();  // duplicates within THIS file
    let imported = 0, duplicates = 0, skipped = 0;
    const errors: { index: number; reason: string }[] = [];
    for (let i = 0; i < items.length; i++) {
      const raw = items[i] as any;
      const opts = pickOptions(raw);       // supports options[] OR option1..4 OR a/b/c/d
      const text = String(raw?.text ?? raw?.question ?? '').trim();
      if (!text) { skipped++; errors.push({ index: i + 1, reason: 'متن سوال خالی است' }); continue; }
      if (opts.length < 2 || opts.length > 4) { skipped++; errors.push({ index: i + 1, reason: `تعداد گزینه‌ها باید ۲ تا ۴ باشد (الان ${opts.length})` }); continue; }
      const ci = Number(raw?.correctIndex ?? raw?.correctAnswer ?? raw?.answer ?? 0);
      if (!Number.isInteger(ci) || ci < 0 || ci >= opts.length) { skipped++; errors.push({ index: i + 1, reason: `ایندکس پاسخ درست نامعتبر است (${raw?.correctIndex})` }); continue; }
      const nt = normText(text);
      if (seen.has(nt) || existing.has(nt)) { duplicates++; errors.push({ index: i + 1, reason: 'تکراری' }); continue; }
      seen.add(nt);
      // id is ALWAYS a server-generated UUID — a non-UUID id in the file used to
      // crash the whole import on Postgres. raw.id is intentionally ignored.
      const q: Question = {
        id: id(), text, options: opts, correctIndex: ci,
        category: String(raw?.category ?? 'عمومی').trim() || 'عمومی',
        difficulty: normDifficulty(raw?.difficulty), tags: Array.isArray(raw?.tags) ? raw.tags.map(String) : [],
        status: (raw?.status === 'pending' || raw?.status === 'archived') ? raw.status : 'approved',
        version: 1
      };
      try { await repositories.questions.save(q); imported++; }
      catch (e) { skipped++; errors.push({ index: i + 1, reason: e instanceof Error ? e.message : 'ذخیره ناموفق' }); }
    }
    audit(ctx.userId, 'QUESTIONS_IMPORTED', 'question', undefined, { imported, duplicates, skipped });
    // Honest result: the count is what ACTUALLY persisted, with per-item errors.
    json(ctx.res, 201, { imported, duplicates, skipped, total: items.length, errors: errors.slice(0, 50) });
  });

  router.add('POST', `${base}/admin/questions`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const body = ctx.body as any;
    if (!body?.text || !Array.isArray(body.options) || body.options.length !== 4) {
      return error(ctx.res, 422, 'QUESTION_INVALID', 'Question text and exactly four options are required.');
    }
    const question: Question = {
      id: body.id ?? id(),
      text: String(body.text),
      options: body.options.map(String),
      correctIndex: Number(body.correctIndex ?? 0),
      category: String(body.category ?? 'عمومی'),
      difficulty: body.difficulty ?? 'easy',
      tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
      status: body.status ?? 'pending',
      version: Number(body.version ?? 1)
    };
    await repositories.questions.save(question);
    audit(ctx.userId, 'QUESTION_CREATED', 'question', question.id, { question });
    json(ctx.res, 201, question);
  });

  router.add('PATCH', `${base}/admin/questions/:id/status`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const question = await repositories.questions.findById(ctx.params.id!);
    if (!question) return error(ctx.res, 404, 'QUESTION_NOT_FOUND', 'Question not found.');
    const status = String((ctx.body as any)?.status ?? 'pending') as Question['status'];
    question.status = status;
    question.version += 1;
    await repositories.questions.save(question);
    audit(ctx.userId, 'QUESTION_STATUS_UPDATED', 'question', question.id, { status });
    json(ctx.res, 200, question);
  });

  router.add('DELETE', `${base}/admin/questions/:id`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const q = await repositories.questions.findById(ctx.params.id!);
    if (!q) return error(ctx.res, 404, 'QUESTION_NOT_FOUND', 'Question not found.');
    await repositories.questions.remove(ctx.params.id!);
    audit(ctx.userId, 'QUESTION_DELETED', 'question', ctx.params.id, { text: q.text });
    json(ctx.res, 200, { deleted: true });
  });

  router.add('GET', `${base}/admin/users`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await searchAdminUsers(ctx.query.get('q') ?? '', Number(ctx.query.get('limit') ?? 100)));
  });

  router.add('GET', `${base}/admin/users/:id/overview`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const overview = await getAdminUserOverview(ctx.params.id!);
    if (!overview) return error(ctx.res, 404, 'USER_NOT_FOUND', 'User not found.');
    json(ctx.res, 200, overview);
  });

  router.add('PATCH', `${base}/admin/users/:id/status`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const status = String((ctx.body as any)?.status ?? 'active') as any;
    if (!['active','limited','banned'].includes(status)) return error(ctx.res, 422, 'USER_STATUS_INVALID', 'Invalid user status.');
    const updated = await updateUserStatus(ctx.params.id!, status, String((ctx.body as any)?.reason ?? ''));
    if (!updated) return error(ctx.res, 404, 'USER_NOT_FOUND', 'User not found.');
    audit(ctx.userId, 'USER_STATUS_UPDATED', 'user', updated.id, { status, reason: (ctx.body as any)?.reason });
    json(ctx.res, 200, updated);
  });

  router.add('PATCH', `${base}/admin/users/:id/role`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const role = String((ctx.body as any)?.role ?? 'user') as 'user' | 'admin';
    if (!['user','admin'].includes(role)) return error(ctx.res, 422, 'USER_ROLE_INVALID', 'Invalid user role.');
    const updated = await updateUserRole(ctx.params.id!, role);
    if (!updated) return error(ctx.res, 404, 'USER_NOT_FOUND', 'User not found.');
    audit(ctx.userId, 'USER_ROLE_UPDATED', 'user', updated.id, { role });
    json(ctx.res, 200, updated);
  });

  // Edit core user fields (name / xp / level / weekly cup / coins / hearts).
  router.add('PATCH', `${base}/admin/users/:id`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const b = (ctx.body ?? {}) as any;
    const updated = await updateUserFields(ctx.params.id!, { displayName: b.displayName, username: b.username, xp: b.xp, level: b.level, weeklyScore: b.weeklyScore, coins: b.coins, hearts: b.hearts });
    if (!updated) return error(ctx.res, 404, 'USER_NOT_FOUND', 'User not found.');
    audit(ctx.userId, 'USER_FIELDS_UPDATED', 'user', updated.id, b);
    if (updated) { const u = await repositories.users.findById(updated.id); if (u) await leaderboards.updateUser(u); }
    json(ctx.res, 200, updated);
  });

  /* DELETE AN ACCOUNT, FOR GOOD.
   *
   * «در تب کاربران کنار دکمهٔ مدیریت یک دکمهٔ حذف کاربر باید باشه.»
   *
   * This is the one admin action with no undo, in an app that holds people's
   * money — so it refuses before it destroys. An account with a balance, with
   * money locked in a withdrawal that has not been paid, or that is in the
   * middle of a match, is not deleted: the operator is told which of those it
   * is and can settle it first. Anything else would leave the ledger describing
   * money belonging to somebody who no longer exists. */
  router.add('DELETE', `${base}/admin/users/:id`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const uid = ctx.params.id!;
    const user = await repositories.users.findById(uid);
    if (!user) return error(ctx.res, 404, 'USER_NOT_FOUND', 'کاربر پیدا نشد.');
    if (uid === ctx.userId) return error(ctx.res, 400, 'DELETE_SELF', 'حساب خودت را نمی‌توانی حذف کنی.');

    /* `available` and `locked` — the ledger's own words. Reading a `balance`
       field that does not exist would make every account look empty, which is
       the one mistake this check exists to prevent. `pendingSettlement` counts
       too: it is money on its way in. */
    const acct = await getAccount(uid).catch(() => null);
    const available = Number(acct?.available ?? 0);
    const locked = Number(acct?.locked ?? 0);
    const pending = Number(acct?.pendingSettlement ?? 0);
    if (available > 0 || locked > 0 || pending > 0) {
      const bits: string[] = [];
      if (available > 0) bits.push(`${available.toLocaleString('fa-IR')} تومان موجودی`);
      if (locked > 0) bits.push(`${locked.toLocaleString('fa-IR')} تومان در انتظار برداشت`);
      if (pending > 0) bits.push(`${pending.toLocaleString('fa-IR')} تومان در حال تسویه`);
      return error(ctx.res, 409, 'USER_HAS_FUNDS',
        `این حساب هنوز ${bits.join(' و ')} دارد. اول تسویه کن، بعد حذف.`);
    }
    if (currentMatchOf(uid)) {
      return error(ctx.res, 409, 'USER_IN_MATCH', 'این کاربر وسط یک مسابقه است — بعد از تمام شدنش دوباره امتحان کن.');
    }
    /* Written down BEFORE the row goes, because afterwards there is nothing
       left to describe who was removed. */
    audit(ctx.userId, 'USER_DELETED', 'user', uid,
      { username: user.username, displayName: user.displayName, phone: user.phone, level: user.level });
    await repositories.users.remove(uid);
    json(ctx.res, 200, { deleted: true, id: uid, username: user.username });
  });

  // Grant / set a user's tickets (a granted asset — not a wallet movement).
  router.add('POST', `${base}/admin/users/:id/tickets`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const b = (ctx.body ?? {}) as any;
    const tickets = await setUserTickets(ctx.params.id!, String(b.tier ?? ''), Number(b.count ?? 0), b.mode === 'set' ? 'set' : 'add');
    if (!tickets) return error(ctx.res, 404, 'USER_NOT_FOUND', 'User not found.');
    audit(ctx.userId, 'USER_TICKETS_UPDATED', 'user', ctx.params.id, b);
    json(ctx.res, 200, { tickets });
  });

  // Send a direct in-app + push notification to one user.
  router.add('POST', `${base}/admin/users/:id/message`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const b = (ctx.body ?? {}) as any;
    await notifications.create({ userId: ctx.params.id!, type: 'system' as NotificationType, title: String(b.title ?? 'پیام از پشتیبانی'), body: String(b.body ?? ''), data: { fromAdmin: true }, push: true });
    audit(ctx.userId, 'USER_MESSAGED', 'user', ctx.params.id, { title: b.title });
    json(ctx.res, 200, { sent: true });
  });

  // Reset a user's progression (xp / level / weekly cup) — wallet untouched.
  router.add('POST', `${base}/admin/users/:id/reset`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const updated = await resetUserStats(ctx.params.id!);
    if (!updated) return error(ctx.res, 404, 'USER_NOT_FOUND', 'User not found.');
    const u = await repositories.users.findById(updated.id); if (u) await leaderboards.updateUser(u);
    audit(ctx.userId, 'USER_STATS_RESET', 'user', updated.id, {});
    json(ctx.res, 200, updated);
  });

  // ---- Matches (rooms) admin: RUNNING only (finished ones move to /history) ----
  router.add('GET', `${base}/admin/matches`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, { rows: await runningMatches() });
  });
  router.add('GET', `${base}/admin/matches/history`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, { rows: await finishedMatches(Number(ctx.query.get('limit') ?? 50)) });
  });
  router.add('POST', `${base}/admin/matches/:id/force-end`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const b = (ctx.body ?? {}) as any;
    try {
      const match = await getMatch(ctx.params.id!);
      if (b.winnerUserId) { await forfeitMatch(match.id, match.players.find((p) => p.userId !== b.winnerUserId)?.userId ?? match.players[0]!.userId); }
      else { await claimTimeout(match.id, match.players[0]!.userId); }
      audit(ctx.userId, 'MATCH_FORCE_ENDED', 'match', match.id, b);
      json(ctx.res, 200, { ended: true });
    } catch (e) { error(ctx.res, 400, 'MATCH_END_FAILED', e instanceof Error ? e.message : 'failed'); }
  });

  // ---- Gift codes ----
  router.add('GET', `${base}/admin/gift-codes`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, { rows: await listGiftCodes() });
  });
  router.add('POST', `${base}/admin/gift-codes`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const b = (ctx.body ?? {}) as any;
    try {
      const code = await createGiftCode({ code: b.code, rewardType: b.rewardType, amount: Number(b.amount ?? 0), tier: b.tier, maxUses: Number(b.maxUses ?? 1), expiresAt: b.expiresAt || null });
      audit(ctx.userId, 'GIFT_CODE_CREATED', 'gift_code', code.code, b);
      json(ctx.res, 201, code);
    } catch (e) { error(ctx.res, 400, 'GIFT_CODE_INVALID', e instanceof Error ? e.message : 'failed'); }
  });

  // ================= AI question pipeline =================
  router.add('POST', `${base}/admin/questions/ai/generate`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const b = (ctx.body ?? {}) as any;
    const r = await aiGenerate({ topic: String(b.topic ?? ''), difficulty: b.difficulty, count: Number(b.count ?? 1), category: b.category });
    json(ctx.res, 200, r);
  });
  // Save an AI draft (or a manual one) into the bank as a pending draft.
  router.add('POST', `${base}/admin/questions/draft`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const b = (ctx.body ?? {}) as any;
    if (!b.text || !Array.isArray(b.options) || b.options.length < 2) return error(ctx.res, 422, 'QUESTION_INVALID', 'text + options required.');
    const q = await createDraft({ text: String(b.text), options: b.options.map(String), correctIndex: Number(b.correctIndex ?? 0), category: b.category, difficulty: b.difficulty, source: b.source === 'ai' ? 'ai' : 'manual', explanation: b.explanation, sourceRef: b.source_ref });
    audit(ctx.userId, 'QUESTION_DRAFTED', 'question', q.id, { source: b.source });
    json(ctx.res, 201, q);
  });
  // Run reviewer + fact-check + dedup + quality (+ optional auto-approve).
  router.add('POST', `${base}/admin/questions/:id/pipeline`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    try {
      const m = await runPipeline(ctx.params.id!, { autoApprove: (ctx.body as any)?.autoApprove === true });
      json(ctx.res, 200, m);
    } catch (e) { error(ctx.res, 400, 'PIPELINE_FAILED', e instanceof Error ? e.message : 'failed'); }
  });
  router.add('POST', `${base}/admin/questions/:id/approve`, async (ctx) => { if (!requireAdmin(ctx)) return; await approvePipeline(ctx.params.id!); audit(ctx.userId, 'QUESTION_APPROVED', 'question', ctx.params.id, {}); json(ctx.res, 200, { approved: true }); });
  router.add('POST', `${base}/admin/questions/:id/reject`, async (ctx) => { if (!requireAdmin(ctx)) return; await rejectPipeline(ctx.params.id!); audit(ctx.userId, 'QUESTION_REJECTED', 'question', ctx.params.id, {}); json(ctx.res, 200, { rejected: true }); });
  router.add('GET', `${base}/admin/questions/pipeline`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, { rows: await listPipeline(ctx.query.get('stage') || undefined, Number(ctx.query.get('limit') ?? 100)) });
  });
  router.add('GET', `${base}/admin/questions/:id/feedback`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const m = await getPipelineMeta(ctx.params.id!);
    json(ctx.res, 200, m ?? { feedback: {}, reportCount: 0 });
  });

  // --- Player question reports (review queue) ---------------------------------
  router.add('GET', `${base}/admin/question-reports`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const status = ctx.query.get('status') || 'open';
    const [rows, counts] = await Promise.all([
      listReports(status, Number(ctx.query.get('limit') ?? 200)),
      reportCounts()
    ]);
    json(ctx.res, 200, { rows, counts });
  });

  router.add('POST', `${base}/admin/question-reports/:id/resolve`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const ok = await setReportStatus(ctx.params.id!, 'resolved', ctx.userId);
    if (!ok) return error(ctx.res, 404, 'REPORT_NOT_FOUND', 'Report not found or already handled.');
    audit(ctx.userId, 'QUESTION_REPORT_RESOLVED', 'question_report', ctx.params.id, {});
    json(ctx.res, 200, { resolved: true });
  });

  router.add('POST', `${base}/admin/question-reports/:id/dismiss`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const ok = await setReportStatus(ctx.params.id!, 'dismissed', ctx.userId);
    if (!ok) return error(ctx.res, 404, 'REPORT_NOT_FOUND', 'Report not found or already handled.');
    audit(ctx.userId, 'QUESTION_REPORT_DISMISSED', 'question_report', ctx.params.id, {});
    json(ctx.res, 200, { dismissed: true });
  });

  // --- Shop catalog management (add items, set prices, toggle, reorder) -------
  router.add('GET', `${base}/admin/shop/items`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, { rows: await shopList({ category: ctx.query.get('category') || undefined }) });
  });
  router.add('POST', `${base}/admin/shop/items`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const b = (ctx.body ?? {}) as any;
    if (!String(b.name ?? '').trim()) return error(ctx.res, 422, 'NAME_REQUIRED', 'نام آیتم الزامی است.');
    try {
      const item = await shopSave({
        id: b.id || undefined, category: String(b.category || 'util'), icon: b.icon, name: String(b.name),
        description: b.description, price: Number(b.price ?? 0), currency: b.currency === 'cash' ? 'cash' : 'coins',
        effectKey: b.effectKey, effectValue: Number(b.effectValue ?? 1), badge: b.badge,
        enabled: b.enabled != null ? !!b.enabled : true, sortOrder: Number(b.sortOrder ?? 0),
        /* Passed through only when the panel actually sent them. `undefined`
           means "leave as it was"; an empty array or an empty string means
           "the operator cleared it", and those must not be confused. */
        ...(b.rewards !== undefined ? { rewards: b.rewards } : {}),
        ...(b.image !== undefined ? { image: String(b.image || '') } : {})
      });
      audit(ctx.userId, b.id ? 'SHOP_ITEM_UPDATED' : 'SHOP_ITEM_CREATED', 'shop_item', item.id, { name: item.name, price: item.price });
      json(ctx.res, 201, item);
    } catch (e) {
      return error(ctx.res, 422, 'SHOP_SAVE_FAILED', e instanceof Error ? e.message : 'ذخیره ناموفق بود.');
    }
  });
  /* Add the built-in items this catalogue is missing.
   *
   * A server seeded before a category existed — the coin packs, for instance —
   * never receives it, because the automatic seed only fills a table that is
   * completely empty. This tops it up on request. It is a button rather than a
   * boot step on purpose: run automatically, it would resurrect whatever an
   * operator had deliberately deleted, every restart. */
  /* WHAT THE GAME IS ALLOWED TO SEND. The other half of the players' own
     preferences: this one is game-wide, and a muted type is never written to
     an inbox at all. */
  router.add('GET', `${base}/admin/notification-policy`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, { policy: await getPolicy(), types: NOTIFICATION_TYPES, labels: NOTIFICATION_TYPE_LABELS });
  });
  router.add('PUT', `${base}/admin/notification-policy`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const b = (ctx.body ?? {}) as any;
    const policy = await setPolicy({ types: b.types });
    audit(ctx.userId, 'NOTIFICATION_POLICY_UPDATED', 'config', 'notification_policy', { types: policy.types });
    json(ctx.res, 200, { policy });
  });
  router.add('POST', `${base}/admin/shop/seed-missing`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const { added, skipped } = await shopSeedMissing();
    audit(ctx.userId, 'SHOP_SEED_MISSING', 'shop_item', '', { added: added.length, skipped });
    json(ctx.res, 200, { added: added.map((i) => ({ id: i.id, name: i.name, category: i.category })), addedCount: added.length, skipped });
  });
  router.add('DELETE', `${base}/admin/shop/items/:id`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const ok = await shopRemove(ctx.params.id!);
    if (!ok) return error(ctx.res, 404, 'SHOP_ITEM_NOT_FOUND', 'آیتم یافت نشد.');
    audit(ctx.userId, 'SHOP_ITEM_DELETED', 'shop_item', ctx.params.id, {});
    json(ctx.res, 200, { deleted: true });
  });

  router.add('GET', `${base}/admin/analytics`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await getAdminAnalytics());
  });


  /* ---------------- ACCOUNTING / FINANCIAL REPORTS ---------------- */
  router.add('GET', `${base}/admin/accounting/report`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'accounting' })) return;
    json(ctx.res, 200, await financeReport({
      from: ctx.query.get('from') ?? undefined,
      to: ctx.query.get('to') ?? undefined,
      granularity: (ctx.query.get('granularity') as any) ?? undefined
    }));
  });

  // Excel-friendly CSV (BOM'd so Persian opens correctly) and a real PDF.
  router.add('GET', `${base}/admin/accounting/export.csv`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'accounting' })) return;
    const r = await financeReport({ from: ctx.query.get('from') ?? undefined, to: ctx.query.get('to') ?? undefined, granularity: (ctx.query.get('granularity') as any) ?? undefined });
    const body = Buffer.from(reportToCsv(r), 'utf8');
    ctx.res.statusCode = 200;
    ctx.res.setHeader('content-type', 'text/csv; charset=utf-8');
    ctx.res.setHeader('content-disposition', `attachment; filename="finance-${r.from}_${r.to}.csv"`);
    ctx.res.setHeader('content-length', String(body.length));
    ctx.res.end(body);
  });

  router.add('GET', `${base}/admin/accounting/export.pdf`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'accounting' })) return;
    const r = await financeReport({ from: ctx.query.get('from') ?? undefined, to: ctx.query.get('to') ?? undefined, granularity: (ctx.query.get('granularity') as any) ?? undefined });
    const body = reportToPdf(r);
    ctx.res.statusCode = 200;
    ctx.res.setHeader('content-type', 'application/pdf');
    ctx.res.setHeader('content-disposition', `attachment; filename="finance-${r.from}_${r.to}.pdf"`);
    ctx.res.setHeader('content-length', String(body.length));
    ctx.res.end(body);
  });

  /* ---------------- COMPANY EXPENSES ---------------- */
  router.add('GET', `${base}/admin/expenses`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'expenses' })) return;
    json(ctx.res, 200, { rows: await listExpenses(ctx.query.get('from') ?? undefined, ctx.query.get('to') ?? undefined), categories: EXPENSE_CATEGORIES });
  });
  router.add('POST', `${base}/admin/expenses`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'expenses' })) return;
    json(ctx.res, 201, await saveExpense((ctx.body ?? {}) as any));
  });
  router.add('DELETE', `${base}/admin/expenses/:id`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'expenses' })) return;
    json(ctx.res, 200, { removed: await deleteExpense(ctx.params.id!) });
  });
  // Price per hour for one machine; the accrual is worked out from it.
  router.add('PUT', `${base}/admin/expenses/server-cost/:id`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'expenses' })) return;
    await setServerHourlyCost(ctx.params.id!, Number((ctx.body as any)?.hourly ?? 0));
    json(ctx.res, 200, { ok: true });
  });

  /* ---------------- SECURITY ALERTS ---------------- */
  router.add('GET', `${base}/admin/security-alerts`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'security' })) return;
    json(ctx.res, 200, await securityAlerts());
  });

  /* ---------------- BACKUP ----------------
   * Owner-only by default. `backup` is a real permission, so the owner can hand
   * it to one trusted account from the roles tab without opening anything else. */
  router.add('GET', `${base}/admin/backup/export`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'backup' })) return;
    /* Streamed, so peak memory is one page of rows no matter how big the
     * database gets. That means no content-length — the size is unknown until
     * the last row is written — which is exactly what chunked transfer is for. */
    ctx.res.statusCode = 200;
    ctx.res.setHeader('content-type', 'application/json; charset=utf-8');
    ctx.res.setHeader('content-disposition', `attachment; filename="${backupFilename()}"`);
    ctx.res.setHeader('cache-control', 'no-store');
    try {
      await streamBackup(ctx.res);
    } catch { /* socket died mid-dump — nothing left to say on it */ }
    ctx.res.end();
  });
  router.add('GET', `${base}/admin/backup/status`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'backup' })) return;
    json(ctx.res, 200, { tables: BACKUP_TABLES.length, filename: backupFilename() });
  });

  router.add('GET', `${base}/admin/finance/diagnostics`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await financeDiagnostics());
  });

  router.add('GET', `${base}/admin/finance/withdrawals`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const rows = await listWithdrawals((ctx.query.get('status') || undefined) as any, Number(ctx.query.get('limit') ?? 100));
    if (ctx.query.get('format') === 'csv') {
      ctx.res.statusCode = 200;
      ctx.res.setHeader('content-type', 'text/csv; charset=utf-8');
      ctx.res.end(transactionsToCsv(rows));
      return;
    }
    json(ctx.res, 200, rows);
  });

  router.add('PATCH', `${base}/admin/finance/withdrawals/:id/status`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const action = String((ctx.body as any)?.action ?? 'approve') as 'approve' | 'reject';
    if (!['approve','reject'].includes(action)) return error(ctx.res, 422, 'WITHDRAW_ACTION_INVALID', 'Withdraw action must be approve or reject.');
    const updated = await reviewWithdrawal(ctx.params.id!, action, ctx.userId ?? 'system');
    if (!updated) return error(ctx.res, 404, 'WITHDRAW_NOT_FOUND', 'Withdrawal transaction not found.');
    audit(ctx.userId, 'WITHDRAW_REVIEWED', 'transaction', updated.id, { action, status: updated.status });
    json(ctx.res, 200, updated);
  });


  router.add('GET', `${base}/admin/matchmaking/analytics`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await matchmakingQueue.stats());
  });

  router.add('GET', `${base}/admin/leaderboards/diagnostics`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await leaderboards.diagnostics());
  });


  /* Daily reward + wheel. The whole prize table lives here — how many segments,
   * what each pays, how likely it is, and how long the streak calendar runs. */
  router.add('GET', `${base}/admin/rewards`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await getRewardsConfig());
  });

  router.add('POST', `${base}/admin/rewards`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    try { json(ctx.res, 200, await saveRewardsConfig(ctx.body ?? {})); }
    catch (e) {
      if (e instanceof RewardsError) return error(ctx.res, 422, e.code, e.message);
      throw e;
    }
  });

  /* What the wheel actually pays over many spins. Weights are relative numbers
   * and read as nothing in particular; an operator setting a jackpot needs to
   * see the odds and the expected cost per spin before players do. */
  router.add('GET', `${base}/admin/rewards/odds`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const cfg = await getRewardsConfig();
    const live = cfg.wheel.segments.filter((s) => s.enabled && s.weight > 0);
    const total = live.reduce((n, s) => n + s.weight, 0) || 1;
    json(ctx.res, 200, {
      totalWeight: total,
      rows: cfg.wheel.segments.map((s) => ({
        id: s.id, label: s.label, icon: s.icon, type: s.type, amount: s.amount, target: s.target,
        weight: s.weight, enabled: s.enabled,
        chance: s.enabled && s.weight > 0 ? s.weight / total : 0
      })),
      /* Split by kind: coins and cash are not the same currency and adding
       * them together would give a meaningless number. */
      perSpin: ['coins', 'xp', 'cash', 'ticket', 'heart', 'lifeline'].reduce((acc: any, t) => {
        acc[t] = live.filter((s) => s.type === t).reduce((n, s) => n + (s.weight / total) * s.amount, 0);
        return acc;
      }, {})
    });
  });

  /* Record mode: whether it runs at all, what entering costs, and — the point
   * of asking — how much of the rest of the game it is allowed to move. */
  router.add('GET', `${base}/admin/record`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await getRecordConfig());
  });
  router.add('POST', `${base}/admin/record`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await saveRecordConfig(ctx.body ?? {}));
  });

  /* Missions are data. Everything about one — what it counts, how much of it,
   * what it pays, who it is offered to, when it runs — is editable here, which
   * is the point: a new mission or a seasonal event must not need a release. */
  router.add('GET', `${base}/admin/missions`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, { rows: await listMissions(), metrics: MISSION_METRICS });
  });
  router.add('POST', `${base}/admin/missions`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    try { json(ctx.res, 200, await saveMission(ctx.body ?? {})); }
    catch (e) {
      if (e instanceof MissionError) return error(ctx.res, 422, e.code, e.message);
      throw e;
    }
  });
  router.add('DELETE', `${base}/admin/missions/:id`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const gone = await deleteMission(ctx.params.id!);
    if (!gone) return error(ctx.res, 404, 'MISSION_NOT_FOUND', 'این مأموریت وجود ندارد.');
    json(ctx.res, 200, { removed: true });
  });

  router.add('GET', `${base}/admin/notifications/diagnostics`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await notifications.diagnostics());
  });

  /* The push keys, manageable from the panel. They used to be environment
   * variables only, which meant recreating the API container to change them —
   * and a container that cannot be safely recreated made push unfixable. */
  router.add('GET', `${base}/admin/notifications/push-config`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const eff = await effectivePushConfig();
    json(ctx.res, 200, {
      ...maskPushConfig(await loadStoredConfig()),
      source: eff.source, configured: eff.configured,
      /* When the container sets them, panel edits are stored but ignored —
       * say so rather than letting a save look like it did nothing. */
      envOverride: eff.source === 'env'
    });
  });

  router.add('POST', `${base}/admin/notifications/push-config`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const b = (ctx.body ?? {}) as any;
    try {
      const saved = await savePushConfig({
        provider: b.provider === 'webpush' || b.provider === 'log' ? b.provider : undefined,
        publicKey: typeof b.publicKey === 'string' ? b.publicKey.trim() : undefined,
        privateKey: typeof b.privateKey === 'string' ? b.privateKey.trim() : undefined,
        subject: typeof b.subject === 'string' ? b.subject.trim() : undefined
      });
      const eff = await effectivePushConfig();
      json(ctx.res, 200, { ...maskPushConfig(saved), source: eff.source, configured: eff.configured, envOverride: eff.source === 'env' });
    } catch (e) {
      if (e instanceof PushConfigError) return error(ctx.res, 422, e.code, e.message);
      throw e;
    }
  });

  /* Make a fresh pair. Deliberately does NOT save: changing keys invalidates
   * every phone already registered, so the panel shows them first and the
   * operator has to confirm by saving. */
  router.add('POST', `${base}/admin/notifications/push-keys/generate`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, { ...generateKeys(), saved: false });
  });

  /* Send one real push to one person, and report exactly what happened. Without
   * this, checking that push works means broadcasting to everybody and hoping —
   * and when nothing arrives there is no way to tell whether the server is
   * unconfigured, the account has no devices, or the phone silenced it. */
  router.add('POST', `${base}/admin/notifications/test`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const b = (ctx.body ?? {}) as any;
    const who = String(b.user || b.userId || '').trim();
    if (!who) return error(ctx.res, 422, 'USER_REQUIRED', 'کاربر مقصد را وارد کن (شناسه، نام کاربری یا شماره).');
    const { ids, unknown } = await resolveRecipients([who]);
    if (!ids.length) return error(ctx.res, 404, 'USER_NOT_FOUND', 'این کاربر پیدا نشد: ' + unknown.join('، '));
    const userId = ids[0]!;

    const diag = await notifications.diagnostics();
    const devices = (await repositories.notifications.listSubscriptions(userId)).length;
    const note = await notifications.create({
      userId, type: 'system',
      title: String(b.title || 'پیام آزمایشی پرایز کوییز'),
      body: String(b.body || 'اگر این را روی گوشی‌ات می‌بینی، اعلان درست کار می‌کند ✅'),
      data: { url: '/' }, push: true
    });
    json(ctx.res, 200, {
      userId, devices,
      vapidConfigured: diag.vapidConfigured, provider: diag.provider,
      status: note.status, error: note.error ?? null,
      /* Said plainly, because "queued" has three very different causes. */
      hint: !diag.vapidConfigured ? 'کلیدهای VAPID روی سرور تنظیم نشده — تا آن نباشد هیچ اعلانی به گوشی نمی‌رود.'
        : devices === 0 ? 'این کاربر هیچ دستگاهی ثبت نکرده — باید یک بار در بازی «اعلان روی گوشی» را بزند.'
        : note.status === 'sent' ? 'به سرویس پوش تحویل شد.'
        : note.status === 'queued' ? 'در صندوق درون‌برنامه ثبت شد ولی به گوشی نرفت (ساعت سکوت یا تنظیمات کاربر).'
        : ('ارسال ناموفق: ' + (note.error || 'نامشخص'))
    });
  });


  router.add('GET', `${base}/admin/integrity/diagnostics`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await integrity.diagnostics());
  });

  router.add('GET', `${base}/admin/devices/diagnostics`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await deviceDiagnostics());
  });

  router.add('GET', `${base}/admin/risk/users`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const users = await repositories.users.list(1000);
    await Promise.all(users.map((u) => calculateUserRisk(u.id)));
    json(ctx.res, 200, await repositories.devices.listRiskProfiles(Number(ctx.query.get('limit') ?? 100)));
  });

  router.add('GET', `${base}/admin/users/:id/devices`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await listCurrentUserDevices(ctx.params.id!));
  });

  router.add('PATCH', `${base}/admin/devices/bindings/:id/status`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const status = String((ctx.body as any)?.status ?? 'limited') as DeviceTrustStatus;
    if (!['new','trusted','limited','revoked'].includes(status)) return error(ctx.res, 422, 'DEVICE_STATUS_INVALID', 'Invalid device status.');
    const updated = await updateDeviceBindingStatus(ctx.params.id!, status, ctx.userId ?? 'system');
    if (!updated) return error(ctx.res, 404, 'DEVICE_BINDING_NOT_FOUND', 'Device binding not found.');
    audit(ctx.userId, 'DEVICE_BINDING_STATUS_UPDATED', 'device_binding', updated.id, { status });
    json(ctx.res, 200, updated);
  });

  router.add('GET', `${base}/admin/integrity/signals`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await integrity.list({
      userId: ctx.query.get('userId') || undefined,
      matchId: ctx.query.get('matchId') || undefined,
      status: (ctx.query.get('status') || undefined) as IntegrityStatus | undefined,
      severity: (ctx.query.get('severity') || undefined) as IntegritySeverity | undefined,
      limit: Number(ctx.query.get('limit') ?? 100)
    }));
  });

  router.add('PATCH', `${base}/admin/integrity/signals/:id/status`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const status = String((ctx.body as any)?.status ?? 'reviewing') as IntegrityStatus;
    if (!['open','reviewing','dismissed','confirmed'].includes(status)) return error(ctx.res, 422, 'INTEGRITY_STATUS_INVALID', 'Invalid integrity signal status.');
    const updated = await integrity.updateStatus(ctx.params.id!, status, ctx.userId ?? 'system');
    if (!updated) return error(ctx.res, 404, 'INTEGRITY_SIGNAL_NOT_FOUND', 'Integrity signal not found.');
    audit(ctx.userId, 'INTEGRITY_SIGNAL_STATUS_UPDATED', 'integrity_signal', updated.id, { status });
    json(ctx.res, 200, updated);
  });

  // Resolve an audience segment to a live count (audience preview) BEFORE sending.
  router.add('POST', `${base}/admin/notifications/segment/preview`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const spec = (ctx.body ?? {}) as SegmentSpec;
    const { userIds, count, unknown } = await resolveSegment(spec);
    json(ctx.res, 200, { count, sample: userIds.slice(0, 20), description: describeSegment(spec), unknown: unknown ?? [] });
  });

  // Build the notification `data` payload (deep-link action + image + campaign id)
  // shared by immediate + scheduled sends.
  const buildData = (b: any, campaignId: string) => {
    const data: Record<string, unknown> = { campaignId };
    const url = b?.action?.url ?? b?.url;
    if (typeof url === 'string' && url.trim()) data.url = url.trim();
    if (b?.action?.label) data.actionLabel = String(b.action.label);
    if (typeof b?.image === 'string' && b.image.trim()) data.image = b.image.trim();
    if (typeof b?.data === 'object' && b.data) Object.assign(data, b.data);
    return data;
  };

  // Immediate send to a real segment, recorded as a campaign with analytics.
  router.add('POST', `${base}/admin/notifications/broadcast`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const body = ctx.body as any;
    const type = String(body?.type ?? 'system') as NotificationType;
    const title = String(body?.title ?? 'PrizzeQuizz');
    const msg = String(body?.body ?? '');
    if (!title.trim() || !msg.trim()) return error(ctx.res, 422, 'CONTENT_REQUIRED', 'عنوان و متن پیام الزامی است.');
    // Back-compat: an explicit userIds array still works; otherwise resolve segment.
    const spec: SegmentSpec = (body?.segment && typeof body.segment === 'object') ? body.segment
      : (Array.isArray(body?.userIds) && body.userIds.length ? { userIds: body.userIds.map(String) } : { base: 'all' });
    const { userIds, count, unknown } = await resolveSegment(spec);
    /* Nobody to send to is a mistake worth saying out loud, not an empty
     * success — most often a mistyped username in the recipient box. */
    if (!userIds.length) {
      return error(ctx.res, 422, 'AUDIENCE_EMPTY',
        unknown && unknown.length ? ('این کاربر پیدا نشد: ' + unknown.slice(0, 5).join('، ')) : 'هیچ کاربری با این شرایط پیدا نشد.');
    }
    const campaign = await createCampaign({ title, body: msg, type, image: body?.image, action: body?.action, segment: spec as any, segmentDesc: describeSegment(spec), audienceCount: count, status: 'sending', createdBy: ctx.userId });
    const result = await notifications.broadcast({ userIds, type, title, body: msg, data: buildData(body, campaign.id), push: Boolean(body?.push ?? true) });
    await recordCampaignResult(campaign.id, { created: result.created, sent: result.sent, failed: result.failed, status: 'sent' });
    audit(ctx.userId, 'NOTIFICATION_BROADCAST', 'notification', campaign.id, { ...result, type, audience: count });
    json(ctx.res, 202, { ...result, audienceCount: count, campaignId: campaign.id, unknown: unknown ?? [] });
  });

  // Re-send a past campaign to its (freshly re-resolved) segment.
  router.add('POST', `${base}/admin/notifications/campaigns/:id/resend`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const src = (await listCampaigns(500)).find((c) => c.id === ctx.params.id);
    if (!src) return error(ctx.res, 404, 'CAMPAIGN_NOT_FOUND', 'کمپین یافت نشد.');
    const spec = (src.segment ?? { base: 'all' }) as SegmentSpec;
    const { userIds, count } = await resolveSegment(spec);
    const campaign = await createCampaign({ title: src.title, body: src.body, type: src.type, image: src.image, action: src.action, segment: spec as any, segmentDesc: src.segmentDesc, audienceCount: count, status: 'sending', createdBy: ctx.userId });
    const data: Record<string, unknown> = { campaignId: campaign.id };
    if (src.action && (src.action as any).url) data.url = (src.action as any).url;
    if (src.image) data.image = src.image;
    const result = await notifications.broadcast({ userIds, type: src.type as NotificationType, title: src.title, body: src.body, data, push: true });
    await recordCampaignResult(campaign.id, { created: result.created, sent: result.sent, failed: 0, status: 'sent' });
    audit(ctx.userId, 'NOTIFICATION_RESENT', 'notification', campaign.id, { from: src.id, audience: count });
    json(ctx.res, 202, { ...result, audienceCount: count, campaignId: campaign.id });
  });

  // Campaign history (with computed analytics) + a dashboard rollup.
  router.add('GET', `${base}/admin/notifications/campaigns`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const rows = await listCampaigns(Number(ctx.query.get('limit') ?? 100));
    const withStats = await Promise.all(rows.map(async (c) => (await campaignAnalytics(c.id)) ?? c));
    json(ctx.res, 200, { rows: withStats });
  });
  router.add('GET', `${base}/admin/notifications/dashboard`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await campaignDashboard());
  });

  // Schedule a notification for a future date+time (fires automatically at that
  // moment via the server scheduler). Many can be queued — each is one entry.
  router.add('POST', `${base}/admin/notifications/schedule`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const b = (ctx.body ?? {}) as any;
    try {
      // segment / specific / all
      const hasSegment = b.segment && typeof b.segment === 'object';
      const audience: 'all' | 'specific' | 'segment' = hasSegment ? 'segment' : (b.audience === 'specific' ? 'specific' : 'all');
      const spec: SegmentSpec = hasSegment ? b.segment : (audience === 'specific' ? { userIds: (b.userIds || []).map(String) } : { base: 'all' });
      const count = (await resolveSegment(spec)).count;
      const campaign = await createCampaign({ title: String(b.title ?? ''), body: String(b.body ?? ''), type: b.type, image: b.image, action: b.action, segment: spec as any, segmentDesc: describeSegment(spec), audienceCount: count, status: 'scheduled', scheduledAt: String(b.scheduledAt ?? ''), createdBy: ctx.userId });
      const sched = await createScheduled({
        title: String(b.title ?? ''), body: String(b.body ?? ''), type: b.type,
        audience, userIds: Array.isArray(b.userIds) ? b.userIds.map(String) : [],
        segment: hasSegment ? b.segment : undefined, image: b.image, action: b.action, campaignId: campaign.id,
        scheduledAt: String(b.scheduledAt ?? ''), push: b.push !== false, createdBy: ctx.userId
      });
      audit(ctx.userId, 'NOTIFICATION_SCHEDULED', 'notification', sched.id, { scheduledAt: sched.scheduledAt, audience: sched.audience, type: sched.type });
      json(ctx.res, 201, { ...sched, audienceCount: count, campaignId: campaign.id });
    } catch (e) {
      const code = e instanceof Error ? e.message : 'SCHEDULE_INVALID';
      return error(ctx.res, 422, code, code === 'SCHEDULE_TIME_INVALID' ? 'زمان زمان‌بندی نامعتبر است.' : code === 'NO_RECIPIENTS' ? 'گیرنده‌ای انتخاب نشده است.' : 'عنوان و متن پیام الزامی است.');
    }
  });
  router.add('GET', `${base}/admin/notifications/scheduled`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await listScheduled(Number(ctx.query.get('limit') ?? 200)));
  });
  router.add('POST', `${base}/admin/notifications/scheduled/:id/cancel`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const ok = await cancelScheduled(ctx.params.id!);
    if (!ok) return error(ctx.res, 404, 'NOT_CANCELABLE', 'این نوتیف قابل لغو نیست (ارسال شده یا وجود ندارد).');
    audit(ctx.userId, 'NOTIFICATION_CANCELED', 'notification', ctx.params.id, {});
    json(ctx.res, 200, { canceled: true });
  });

  router.add('GET', `${base}/admin/rewards/holds/diagnostics`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await rewardHoldDiagnostics());
  });

  router.add('GET', `${base}/admin/rewards/holds`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await listRewardHolds({
      userId: ctx.query.get('userId') || undefined,
      matchId: ctx.query.get('matchId') || undefined,
      status: (ctx.query.get('status') || undefined) as RewardHoldStatus | undefined,
      limit: Number(ctx.query.get('limit') ?? 100)
    }));
  });

  router.add('PATCH', `${base}/admin/rewards/holds/:id/status`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const status = String((ctx.body as any)?.status ?? 'approved') as 'approved' | 'rejected';
    if (!['approved','rejected'].includes(status)) return error(ctx.res, 422, 'REWARD_HOLD_STATUS_INVALID', 'Reward hold status must be approved or rejected.');
    const updated = await reviewRewardHold(ctx.params.id!, status, ctx.userId ?? 'system');
    if (!updated) return error(ctx.res, 404, 'REWARD_HOLD_NOT_FOUND', 'Reward hold not found.');
    audit(ctx.userId, 'REWARD_HOLD_REVIEWED', 'reward_hold', updated.id, { status });
    json(ctx.res, 200, updated);
  });

  router.add('GET', `${base}/admin/rewards/tuning`, (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, getEditableGameConfig().modes);
  });

  router.add('PATCH', `${base}/admin/rewards/tuning/:modeId`, (ctx) => {
    if (!requireAdmin(ctx)) return;
    const current = getEditableGameConfig();
    const mode = current.modes?.[ctx.params.modeId!];
    if (!mode) return error(ctx.res, 404, 'MODE_NOT_FOUND', 'Mode not found');
    const patch = ctx.body as any;
    const reward = { ...(mode.reward || {}), ...(patch.reward || patch) };
    const updated = updateModeConfig(ctx.params.modeId!, { reward });
    audit(ctx.userId, 'REWARD_TUNING_PATCHED', 'reward_config', ctx.params.modeId, { patch });
    json(ctx.res, 200, updated.modes[ctx.params.modeId!].reward);
  });

  router.add('GET', `${base}/admin/feature-flags`, (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, featureFlags);
  });

  router.add('PATCH', `${base}/admin/feature-flags/:key`, (ctx) => {
    if (!requireAdmin(ctx)) return;
    const flag = patchFeatureFlag(ctx.params.key!, Boolean((ctx.body as any)?.enabled));
    if (!flag) return error(ctx.res, 404, 'FLAG_NOT_FOUND', 'Feature flag not found');
    audit(ctx.userId, 'FEATURE_FLAG_PATCHED', 'feature_flag', ctx.params.key, { enabled: flag.enabled });
    json(ctx.res, 200, flag);
  });

  router.add('GET', `${base}/admin/themes`, (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, themes);
  });

  router.add('POST', `${base}/admin/themes`, (ctx) => {
    if (!requireAdmin(ctx)) return;
    const theme = upsertTheme(ctx.body as any);
    audit(ctx.userId, 'THEME_UPSERTED', 'theme', theme.id, { theme });
    json(ctx.res, 201, theme);
  });

  router.add('GET', `${base}/admin/audit-logs`, (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, [...db.adminLogs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100));
  });

  // Durable admin audit trail (who/target/before/after/delta/reason/time/id).
  router.add('GET', `${base}/admin/audit`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, { rows: await listAdminAudit({ limit: Number(ctx.query.get('limit') ?? 150), action: ctx.query.get('action') || undefined, targetUserId: ctx.query.get('userId') || undefined }) });
  });

  // Main dashboard — live system snapshot (users, DAU, matches, revenue, feed).
  router.add('GET', `${base}/admin/dashboard`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await dashboardMetrics());
  });

  // Transparent finance summary (every number from the immutable ledger).
  router.add('GET', `${base}/admin/wallet/finance`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await financeSummary());
  });

  // Full suspicious-users list with detail + resolve is wired to integrity.
  router.add('GET', `${base}/admin/suspicious`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, { rows: await suspiciousUsers() });
  });

  // Per-area RESET — destructive, requires an explicit confirm token, audited.
  router.add('POST', `${base}/admin/reset`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const b = (ctx.body ?? {}) as any;
    const area = String(b.area ?? '');
    if (!RESET_AREAS.includes(area as ResetArea)) return error(ctx.res, 422, 'RESET_AREA_INVALID', 'Unknown reset area.');
    if (b.confirm !== 'RESET') return error(ctx.res, 428, 'CONFIRM_REQUIRED', 'برای ریست باید confirm=RESET ارسال شود.');
    try {
      const r = await resetArea(area as ResetArea);
      await recordAdmin({ adminId: ctx.userId, action: 'RESET_' + area.toUpperCase(), reason: String(b.reason ?? ''), meta: { area, affected: r.affected } });
      json(ctx.res, 200, { ok: true, ...r });
    } catch (e) { error(ctx.res, 400, 'RESET_FAILED', e instanceof Error ? e.message : 'failed'); }
  });
}

/* Normalize Persian/Arabic text for duplicate detection (unify ي/ك, drop
 * diacritics + punctuation, collapse whitespace). */
function normText(s: string): string {
  return String(s ?? '')
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
    .replace(/[ً-ْ‌‏]/g, '')
    .replace(/[.,،؛:!؟?()«»"'\-–]/g, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}
/* Accept several common option shapes so imports from different generators work:
 * options:[...] | [a,b,c,d] | {option1..4} | {optionA..D} | {a,b,c,d}. */
function pickOptions(raw: any): string[] {
  if (Array.isArray(raw?.options)) return raw.options.map((o: any) => String(o).trim()).filter(Boolean);
  const keysets = [['option1', 'option2', 'option3', 'option4'], ['optionA', 'optionB', 'optionC', 'optionD'], ['a', 'b', 'c', 'd'], ['1', '2', '3', '4']];
  for (const ks of keysets) {
    const vals = ks.map((k) => raw?.[k]).filter((v) => v != null && String(v).trim() !== '');
    if (vals.length >= 2) return vals.map((v) => String(v).trim());
  }
  return [];
}
/* Map difficulty to the game's easy|medium|hard|veryhard, accepting numbers 1..5
   or text (fa/en). 5 (or «بسیار سخت»/very hard/expert) = veryhard. */
function normDifficulty(d: any): 'easy' | 'medium' | 'hard' | 'veryhard' {
  const n = Number(d);
  if (Number.isFinite(n)) return n <= 1 ? 'easy' : n >= 5 ? 'veryhard' : n === 4 ? 'hard' : n === 3 ? 'medium' : n === 2 ? 'medium' : 'easy';
  const s = String(d ?? '').toLowerCase().trim();
  if (/(veryhard|very[\s_-]?hard|very[\s_-]?difficult|expert|بسیار\s*سخت|خیلی\s*سخت|۵|5)/.test(s)) return 'veryhard';
  if (/(hard|سخت|difficult|۴|4)/.test(s)) return 'hard';
  if (/(medium|متوسط|normal|۳|3|۲|2)/.test(s)) return 'medium';
  return 'easy';
}

function audit(adminId: string | undefined, action: string, targetType: string, targetId: string | undefined, diff: Record<string, unknown>): void {
  const log = { id: id(), adminId: adminId ?? 'system', action, targetType, targetId, diff, createdAt: new Date().toISOString() };
  db.adminLogs.set(log.id, log);
  // ALSO persist to the durable admin audit trail (survives restart, with
  // before/after/delta when the diff carries them).
  const before = typeof diff.before === 'number' ? diff.before : undefined;
  const after = typeof diff.after === 'number' ? diff.after : undefined;
  void recordAdmin({ adminId, targetUserId: targetType === 'user' ? targetId : undefined, action, before, after, reason: typeof diff.reason === 'string' ? diff.reason : undefined, meta: { targetType, targetId, ...diff } });
}
