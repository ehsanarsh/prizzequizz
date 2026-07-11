export interface FeatureFlag { key: string; enabled: boolean; description: string }
export interface ThemeRecord { id: string; name: string; primary: string; accent: string; enabled: boolean }

export let featureFlags: FeatureFlag[] = [
  { key: 'daily_rewards', enabled: true, description: 'Daily loyalty reward calendar' },
  { key: 'lucky_wheel', enabled: true, description: 'Daily lucky wheel' },
  { key: 'weekly_leagues', enabled: true, description: 'Weekly league hub' },
  { key: 'battle_pass', enabled: false, description: 'Future battle pass module' }
];

export let themes: ThemeRecord[] = [
  { id: 'paid', name: 'Paid Gold', primary: '#FFD21F', accent: '#F5B90D', enabled: true },
  { id: 'free', name: 'Practice Sky', primary: '#73D9FF', accent: '#1597D2', enabled: true }
];

export function patchFeatureFlag(key: string, enabled: boolean): FeatureFlag | null {
  const flag = featureFlags.find((f) => f.key === key);
  if (!flag) return null;
  flag.enabled = enabled;
  return flag;
}

export function upsertTheme(input: Partial<ThemeRecord>): ThemeRecord {
  const id = input.id || `theme_${Date.now()}`;
  const existing = themes.find((t) => t.id === id);
  if (existing) {
    Object.assign(existing, input);
    return existing;
  }
  const theme: ThemeRecord = { id, name: input.name || id, primary: input.primary || '#FFD21F', accent: input.accent || '#F5B90D', enabled: input.enabled ?? true };
  themes.push(theme);
  return theme;
}
