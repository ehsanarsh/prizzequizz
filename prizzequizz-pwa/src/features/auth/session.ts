import { api } from '../../api';
import type { UserDto } from '../../api/contracts';
import { runTask } from '../../core/asyncTask';
import { store } from '../../core/stateStore';
import { eventBus } from '../../core/eventBus';

const ACCESS_TOKEN_KEY = 'pq_access_token';
const REFRESH_TOKEN_KEY = 'pq_refresh_token';

export function getAccessToken(): string | null {
  try { return localStorage.getItem(ACCESS_TOKEN_KEY); } catch { return null; }
}

export function hasSession(): boolean {
  return !!getAccessToken();
}

export async function bootstrapSession(): Promise<void> {
  await runTask('session.bootstrap', async () => {
    // In mock mode this succeeds without a real token. In production it validates the stored token.
    const user = await api.users.me();
    applyUserDto(user);
    eventBus.emit('SESSION_READY', user);
  });
}

export async function loginWithOtp(phone: string, code = '1234'): Promise<boolean> {
  const result = await runTask('auth.login', async () => {
    const login = await api.auth.login(phone);
    const verified = await api.auth.verifyOtp(login.requestId, code);
    persistTokens(verified.accessToken, verified.refreshToken);
    applyUserDto(verified.user);
    eventBus.emit('SESSION_READY', verified.user);
    return true;
  });
  return !!result;
}

export function logout(): void {
  try {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {}
  eventBus.emit('SESSION_LOGGED_OUT');
}

function persistTokens(accessToken: string, refreshToken: string): void {
  try {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  } catch {}
}

function applyUserDto(user: UserDto): void {
  store.set((draft) => {
    draft.user.id = user.id;
    draft.user.username = user.username;
    draft.user.displayName = user.displayName;
    draft.user.plan = user.plan;
    draft.user.level = user.level;
    draft.user.xp = user.xp;
    draft.user.weeklyScore = user.weeklyScore;
    draft.economy.wallet = user.balances.wallet;
    draft.economy.coins = user.balances.coins;
    draft.economy.hearts = user.balances.hearts;
    draft.economy.tickets = user.balances.tickets;
    draft.ui.theme = user.plan;
  });
}
