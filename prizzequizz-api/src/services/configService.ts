import { gameConfig } from '../core/config.js';

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
}

export function getEditableGameConfig(): any {
  return structuredClone(gameConfig);
}

export function validateGameConfig(input: any): ConfigValidationResult {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') errors.push('Config must be an object.');
  if (!input.version || typeof input.version !== 'string') errors.push('Config version is required.');
  if (!input.modes || typeof input.modes !== 'object') errors.push('Config modes are required.');
  for (const mode of ['duel', 'lastSurvivor', 'allOrNothing', 'weeklyLeague']) {
    if (!input.modes?.[mode]) errors.push(`Missing mode config: ${mode}`);
  }
  if (!input.economy?.free) errors.push('Missing free economy config.');
  if (!input.economy?.paid) errors.push('Missing paid economy config.');
  return { valid: errors.length === 0, errors };
}

export function updateGameConfig(next: any): any {
  const validation = validateGameConfig(next);
  if (!validation.valid) {
    const err = new Error(validation.errors.join(' | '));
    err.name = 'CONFIG_VALIDATION_ERROR';
    throw err;
  }
  // Mutate the loaded config object so existing imports keep the same reference.
  for (const key of Object.keys(gameConfig)) delete (gameConfig as any)[key];
  Object.assign(gameConfig, structuredClone(next));
  return getEditableGameConfig();
}

export function updateModeConfig(modeId: string, patch: any): any {
  if (!gameConfig.modes?.[modeId]) throw new Error('MODE_NOT_FOUND');
  gameConfig.modes[modeId] = { ...gameConfig.modes[modeId], ...structuredClone(patch) };
  return getEditableGameConfig();
}
