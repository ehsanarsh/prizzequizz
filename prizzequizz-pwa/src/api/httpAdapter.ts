import type { PrizzeQuizzApi } from './client';
import { ApiError } from './errors';
import { getClientDeviceId, getDeviceFingerprint, getPlatformLabel } from '../features/devices/device.state';

export interface HttpApiOptions {
  baseUrl: string;
  getToken?: () => string | null;
  timeoutMs?: number;
  retries?: number;
}

export function createHttpApi(options: HttpApiOptions): PrizzeQuizzApi {
  const request = createRequester(options);
  return {
    auth: {
      login: (phone) => request('/auth/login', { method: 'POST', body: { phone } }),
      verifyOtp: (requestId, code, inviteCode) => request('/auth/otp/verify', { method: 'POST', body: { requestId, code, inviteCode } }),
      refresh: (refreshToken) => request('/auth/refresh', { method: 'POST', body: { refreshToken } }),
      logout: (refreshToken) => request('/auth/logout', { method: 'POST', body: { refreshToken } })
    },
    beta: {
      status: () => request('/beta/status'),
      redeem: (code) => request('/beta/redeem', { method: 'POST', body: { code } })
    },
    users: {
      me: () => request('/users/me'),
      profile: (userId) => request(`/users/${userId}/profile`)
    },
    characters: {
      catalog: () => request('/characters/catalog'),
      me: () => request('/characters/me'),
      equip: (input) => request('/characters/equip', { method: 'POST', body: input }),
      unlock: (itemId) => request('/characters/unlock', { method: 'POST', body: { itemId } }),
      purchase: (itemId) => request('/characters/purchase', { method: 'POST', body: { itemId } }),
      randomize: () => request('/characters/randomize', { method: 'POST' })
    },
    leaderboards: {
      get: (kind, limit = 50) => request(`/leaderboards/${kind}?limit=${limit}`),
      weekly: (limit = 50) => request(`/leaderboards/weekly?limit=${limit}`),
      overall: (limit = 50) => request(`/leaderboards/overall?limit=${limit}`),
      winnings: (limit = 50) => request(`/leaderboards/winnings?limit=${limit}`)
    },
    matchmaking: {
      enqueue: (input) => request('/matchmaking/enqueue', { method: 'POST', body: input }),
      get: (ticketId) => request(`/matchmaking/${ticketId}`),
      cancel: (ticketId) => request(`/matchmaking/${ticketId}/cancel`, { method: 'POST' }),
      bot: (ticketId) => request(`/matchmaking/${ticketId}/bot`, { method: 'POST' }),
      stats: () => request('/matchmaking/stats')
    },
    matches: {
      create: (input) => request('/matches', { method: 'POST', body: input }),
      get: (matchId) => request(`/matches/${matchId}`),
      start: (matchId) => request(`/matches/${matchId}/start`, { method: 'POST' }),
      continue: (matchId) => request(`/matches/${matchId}/continue`, { method: 'POST' }),
      exit: (matchId) => request(`/matches/${matchId}/exit`, { method: 'POST' })
    },
    questions: {
      next: (matchId) => request(`/questions/next${matchId ? `?matchId=${encodeURIComponent(matchId)}` : ''}`),
      submitAnswer: (input) => request(`/matches/${input.matchId}/answer`, { method: 'POST', body: input })
    },
    monitoring: {
      report: (input) => request('/monitoring/reports', { method: 'POST', body: input })
    },
    payments: {
      createIntent: (input) => request('/payments/intents', { method: 'POST', body: input }),
      getIntent: (id) => request(`/payments/intents/${id}`),
      verifyIntent: (id, status = 'paid') => request(`/payments/intents/${id}/verify`, { method: 'POST', body: { status } })
    },
    notifications: {
      list: (limit = 50) => request(`/notifications?limit=${limit}`),
      preferences: () => request('/notifications/preferences'),
      updatePreferences: (patch) => request('/notifications/preferences', { method: 'PUT', body: patch }),
      subscribe: (input) => request('/notifications/push-subscriptions', { method: 'POST', body: input }),
      revoke: (subscriptionId) => request(`/notifications/push-subscriptions/${subscriptionId}`, { method: 'DELETE' }),
      markRead: (id) => request(`/notifications/${id}/read`, { method: 'POST' }),
      markAllRead: () => request('/notifications/read-all', { method: 'POST' })
    },
    rewards: {
      claim: (input) => request(`/rewards/${input.rewardId}/claim`, { method: 'POST' })
    },
    wallet: {
      get: () => request('/wallet'),
      topup: (amount) => request('/wallet/topup', { method: 'POST', body: { amount } }),
      withdraw: (amount) => request('/wallet/withdraw', { method: 'POST', body: { amount } })
    },
    friends: {
      list: () => request('/friends'),
      sendRequest: (username) => request('/friends/requests', { method: 'POST', body: { username } }),
      invite: (userId, mode, entry) => request('/friends/invites', { method: 'POST', body: { userId, mode, entry } })
    },
    support: {
      listTickets: () => request('/support/tickets'),
      createTicket: (input) => request('/support/tickets', { method: 'POST', body: input })
    },
    admin: {
      characterCatalog: (status) => request(`/admin/characters/catalog${status ? `?status=${encodeURIComponent(status)}` : ''}`),
      upsertCharacterItem: (input) => request('/admin/characters/items', { method: 'POST', body: input }),
      updateCharacterItemStatus: (id, status) => request(`/admin/characters/items/${id}/status`, { method: 'PATCH', body: { status } }),
      unlockCharacterForUser: (userId, itemId) => request(`/admin/characters/users/${userId}/unlock`, { method: 'POST', body: { itemId } }),
      characterUnlockEvents: (userId, limit = 100) => request(`/admin/characters/users/${userId}/events?limit=${limit}`),
      getConfig: () => request('/admin/config', { method: 'GET' }),
      updateConfig: (config) => request('/admin/config', { method: 'PUT', body: config }),
      patchMode: (modeId, patch) => request(`/admin/config/modes/${modeId}`, { method: 'PATCH', body: patch }),
      analytics: () => request('/admin/analytics'),
      financeDiagnostics: () => request('/admin/finance/diagnostics'),
      betaDiagnostics: () => request('/admin/beta/diagnostics'),
      betaInvites: (limit = 100) => request(`/admin/beta/invites?limit=${limit}`),
      createBetaInvite: (input) => request('/admin/beta/invites', { method: 'POST', body: input }),
      updateBetaInviteStatus: (code, status) => request(`/admin/beta/invites/${encodeURIComponent(code)}/status`, { method: 'PATCH', body: { status } }),
      betaUsers: (limit = 100) => request(`/admin/beta/users?limit=${limit}`),
      databaseStatus: () => request('/admin/database/status'),
      databaseVerify: () => request('/admin/database/verify'),
      paymentDiagnostics: () => request('/admin/payments/diagnostics'),
      paymentIntents: (filter = {}) => request(`/admin/payments/intents?${new URLSearchParams(Object.entries(filter).filter(([,v]) => v !== undefined && v !== '').map(([k,v]) => [k, String(v)])).toString()}`),
      supportDiagnostics: () => request('/admin/support/diagnostics'),
      supportTickets: (filter = {}) => request(`/admin/support/tickets?${new URLSearchParams(Object.entries(filter).filter(([,v]) => v !== undefined && v !== '').map(([k,v]) => [k, String(v)])).toString()}`),
      supportTicket: (id) => request(`/admin/support/tickets/${id}`),
      replySupportTicket: (id, body) => request(`/admin/support/tickets/${id}/reply`, { method: 'POST', body: { body } }),
      updateSupportTicketStatus: (id, status) => request(`/admin/support/tickets/${id}/status`, { method: 'PATCH', body: { status } }),
      withdrawals: (filter = {}) => request(`/admin/finance/withdrawals?${new URLSearchParams(Object.entries(filter).filter(([,v]) => v !== undefined && v !== '').map(([k,v]) => [k, String(v)])).toString()}`),
      updateWithdrawalStatus: (id, action) => request(`/admin/finance/withdrawals/${id}/status`, { method: 'PATCH', body: { action } }),
      auditLogs: () => request('/admin/audit-logs'),
      users: (query = '', limit = 100) => request(`/admin/users?q=${encodeURIComponent(query)}&limit=${limit}`),
      userOverview: (id) => request(`/admin/users/${id}/overview`),
      updateUserStatus: (id, status, reason) => request(`/admin/users/${id}/status`, { method: 'PATCH', body: { status, reason } }),
      updateUserRole: (id, role) => request(`/admin/users/${id}/role`, { method: 'PATCH', body: { role } }),
      listQuestions: (status) => request(`/admin/questions${status ? `?status=${encodeURIComponent(status)}` : ''}`),
      createQuestion: (input) => request('/admin/questions', { method: 'POST', body: input }),
      updateQuestionStatus: (id, status) => request(`/admin/questions/${id}/status`, { method: 'PATCH', body: { status } }),
      exportQuestions: (format='json', status) => request(`/admin/questions/export?format=${format}${status ? `&status=${encodeURIComponent(status)}` : ''}`),
      importQuestions: (questions) => request('/admin/questions/import', { method: 'POST', body: { questions } }),
      rewardTuning: () => request('/admin/rewards/tuning'),
      rewardHoldDiagnostics: () => request('/admin/rewards/holds/diagnostics'),
      rewardHolds: (filter = {}) => request(`/admin/rewards/holds?${new URLSearchParams(Object.entries(filter).filter(([,v]) => v !== undefined && v !== '').map(([k,v]) => [k, String(v)])).toString()}`),
      updateRewardHoldStatus: (id, status) => request(`/admin/rewards/holds/${id}/status`, { method: 'PATCH', body: { status } }),
      patchReward: (modeId, patch) => request(`/admin/rewards/tuning/${modeId}`, { method: 'PATCH', body: patch }),
      featureFlags: () => request('/admin/feature-flags'),
      patchFeatureFlag: (key, enabled) => request(`/admin/feature-flags/${key}`, { method: 'PATCH', body: { enabled } }),
      themes: () => request('/admin/themes'),
      upsertTheme: (input) => request('/admin/themes', { method: 'POST', body: input }),
      leaderboardDiagnostics: () => request('/admin/leaderboards/diagnostics'),
      monitoringDiagnostics: () => request('/admin/monitoring/diagnostics'),
      monitoringReports: (filter = {}) => request(`/admin/monitoring/reports?${new URLSearchParams(Object.entries(filter).filter(([,v]) => v !== undefined && v !== '').map(([k,v]) => [k, String(v)])).toString()}`),
      updateMonitoringReportStatus: (id, status) => request(`/admin/monitoring/reports/${id}/status`, { method: 'PATCH', body: { status } }),
      notificationDiagnostics: () => request('/admin/notifications/diagnostics'),
      deviceDiagnostics: () => request('/admin/devices/diagnostics'),
      riskUsers: (limit = 100) => request(`/admin/risk/users?limit=${limit}`),
      userDevices: (userId) => request(`/admin/users/${userId}/devices`),
      updateDeviceBindingStatus: (id, status) => request(`/admin/devices/bindings/${id}/status`, { method: 'PATCH', body: { status } }),
      integrityDiagnostics: () => request('/admin/integrity/diagnostics'),
      integritySignals: (filter = {}) => request(`/admin/integrity/signals?${new URLSearchParams(Object.entries(filter).filter(([,v]) => v !== undefined && v !== '').map(([k,v]) => [k, String(v)])).toString()}`),
      updateIntegritySignalStatus: (id, status) => request(`/admin/integrity/signals/${id}/status`, { method: 'PATCH', body: { status } }),
      broadcastNotification: (input) => request('/admin/notifications/broadcast', { method: 'POST', body: input })
    }
  };
}

function createRequester(options: HttpApiOptions) {
  const timeoutMs = options.timeoutMs ?? 10000;
  const retries = options.retries ?? 1;

  return async function request(path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const token = options.getToken?.();
        const response = await fetch(`${options.baseUrl}${path}`, {
          method: init.method ?? 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(localStorage.getItem('pq_admin_key') ? { 'x-admin-key': localStorage.getItem('pq_admin_key')! } : {}),
            'x-device-id': getClientDeviceId(),
            'x-device-fingerprint': getDeviceFingerprint(),
            'x-platform': getPlatformLabel()
          },
          body: init.body ? JSON.stringify(init.body) : undefined,
          signal: controller.signal
        });
        window.clearTimeout(timer);
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new ApiError({ code: payload?.error?.code ?? 'HTTP_ERROR', message: payload?.error?.message ?? response.statusText, status: response.status, details: payload?.error?.details });
        }
        return payload?.data ?? payload;
      } catch (error) {
        window.clearTimeout(timer);
        lastError = error;
      }
    }
    throw lastError;
  };
}
