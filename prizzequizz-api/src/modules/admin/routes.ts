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
import { RESET_AREAS, type ResetArea, dashboardMetrics, financeSummary, finishedMatches, resetArea, runningMatches, suspiciousUsers } from '../../services/adminOpsService.js';
import { getAccount } from '../../services/walletLedgerService.js';
import { matchmakingQueue } from '../../services/matchmakingQueue.js';
import { leaderboards } from '../../services/leaderboardService.js';
import { notifications } from '../../services/notificationService.js';
import { financeDiagnostics, listWithdrawals, reviewWithdrawal, transactionsToCsv } from '../../services/financeService.js';
import { listRewardHolds, rewardHoldDiagnostics, reviewRewardHold } from '../../services/rewardReviewService.js';
import { integrity } from '../../services/integrityService.js';
import { calculateUserRisk, deviceDiagnostics, listCurrentUserDevices, updateDeviceBindingStatus } from '../../services/deviceRiskService.js';
import type { DeviceTrustStatus, IntegritySeverity, IntegrityStatus, NotificationType, RewardHoldStatus } from '../../types/domain.js';
import type { Question } from '../../types/domain.js';

export function registerAdminRoutes(router: Router, base: string): void {
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

  router.add('GET', `${base}/admin/questions`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const status = ctx.query.get('status') || undefined;
    const all = await repositories.questions.listAll(status);
    json(ctx.res, 200, all);
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

  router.add('GET', `${base}/admin/analytics`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await getAdminAnalytics());
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


  router.add('GET', `${base}/admin/notifications/diagnostics`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await notifications.diagnostics());
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

  router.add('POST', `${base}/admin/notifications/broadcast`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const body = ctx.body as any;
    const users = await repositories.users.list(1000);
    const userIds = Array.isArray(body?.userIds) && body.userIds.length ? body.userIds.map(String) : users.map((u) => u.id);
    const result = await notifications.broadcast({
      userIds,
      type: String(body?.type ?? 'system') as NotificationType,
      title: String(body?.title ?? 'PrizzeQuizz'),
      body: String(body?.body ?? ''),
      data: typeof body?.data === 'object' && body.data ? body.data : {},
      push: Boolean(body?.push ?? true)
    });
    audit(ctx.userId, 'NOTIFICATION_BROADCAST', 'notification', undefined, { ...result, type: body?.type ?? 'system' });
    json(ctx.res, 202, result);
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
/* Map difficulty to the game's easy|medium|hard, accepting numbers 1..5 or text. */
function normDifficulty(d: any): 'easy' | 'medium' | 'hard' {
  const n = Number(d);
  if (Number.isFinite(n)) return n <= 1 ? 'easy' : n >= 4 ? 'hard' : 'medium';
  const s = String(d ?? '').toLowerCase();
  if (/(hard|سخت|difficult|4|5)/.test(s)) return 'hard';
  if (/(medium|متوسط|normal|3)/.test(s)) return 'medium';
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
