import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { getEditableGameConfig, patchGameConfig, updateGameConfig, updateModeConfig, validateGameConfig } from '../../services/configService.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { repositories } from '../../repositories/index.js';
import { db } from '../../repositories/memory.js';
import { id } from '../../utils/id.js';
import { featureFlags, patchFeatureFlag, themes, upsertTheme } from '../../services/adminStores.js';
import { getAdminAnalytics } from '../../services/analyticsService.js';
import { getAdminUserOverview, searchAdminUsers, updateUserRole, updateUserStatus } from '../../services/adminUserService.js';
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
    const items = Array.isArray(body?.questions) ? body.questions : [];
    let imported = 0;
    for (const raw of items) {
      if (!raw?.text || !Array.isArray(raw.options) || raw.options.length !== 4) continue;
      const q: Question = { id: raw.id ?? id(), text: String(raw.text), options: raw.options.map(String), correctIndex: Number(raw.correctIndex ?? 0), category: String(raw.category ?? 'عمومی'), difficulty: raw.difficulty ?? 'easy', tags: Array.isArray(raw.tags)?raw.tags.map(String):[], status: raw.status ?? 'pending', version: Number(raw.version ?? 1) };
      await repositories.questions.save(q); imported++;
    }
    audit(ctx.userId, 'QUESTIONS_IMPORTED', 'question', undefined, { imported });
    json(ctx.res, 201, { imported });
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
}

function audit(adminId: string | undefined, action: string, targetType: string, targetId: string | undefined, diff: Record<string, unknown>): void {
  const log = { id: id(), adminId: adminId ?? 'system', action, targetType, targetId, diff, createdAt: new Date().toISOString() };
  db.adminLogs.set(log.id, log);
}
