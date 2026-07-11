import { api } from '../../api';
import type { LeaderboardDto, LeaderboardKind } from '../../api/contracts';
import { eventBus } from '../../core/eventBus';
import { runTask } from '../../core/asyncTask';
import { realtime } from '../../api';

const CACHE_KEY = 'prizzequizz-leaderboards-v1';

let activeKind: LeaderboardKind = 'weekly';
let boards: Partial<Record<LeaderboardKind, LeaderboardDto>> = load() ?? {};
let subscribed = new Set<LeaderboardKind>();
let inFlight = new Set<LeaderboardKind>();
let hydrated = new Set<LeaderboardKind>(Object.keys(boards) as LeaderboardKind[]);

export function getLeaderboardKind(): LeaderboardKind { return activeKind; }
export function setLeaderboardKind(kind: LeaderboardKind): void { activeKind = kind; }
export function getLeaderboard(kind = activeKind): LeaderboardDto | null { return boards[kind] ?? null; }

export async function hydrateLeaderboard(kind = activeKind, force = false): Promise<void> {
  if (!force && (hydrated.has(kind) || inFlight.has(kind))) return;
  inFlight.add(kind);
  await runTask(`leaderboard.${kind}`, async () => {
    const dto = await api.leaderboards.get(kind, 50);
    boards = { ...boards, [kind]: dto };
    hydrated.add(kind);
    save(boards);
  });
  inFlight.delete(kind);
}

export function subscribeLeaderboard(kind = activeKind): void {
  if (subscribed.has(kind)) return;
  subscribed.add(kind);
  realtime.send('client:subscribe_leaderboard', { kind }, `leaderboard_${kind}_${Date.now()}`);
}

export function unsubscribeLeaderboard(kind: LeaderboardKind): void {
  if (!subscribed.has(kind)) return;
  subscribed.delete(kind);
  realtime.send('client:unsubscribe_leaderboard', { kind }, `leaderboard_unsub_${kind}_${Date.now()}`);
}

eventBus.on<{ kind?: LeaderboardKind; leaderboard?: LeaderboardDto }>('server:leaderboard_update', (payload) => {
  const kind = payload?.kind;
  if (!kind || !payload?.leaderboard) return;
  boards = { ...boards, [kind]: payload.leaderboard };
  hydrated.add(kind);
  save(boards);
});

function load(): Partial<Record<LeaderboardKind, LeaderboardDto>> | null {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') as Partial<Record<LeaderboardKind, LeaderboardDto>> | null; }
  catch { return null; }
}

function save(value: Partial<Record<LeaderboardKind, LeaderboardDto>>): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(value)); } catch {}
}
