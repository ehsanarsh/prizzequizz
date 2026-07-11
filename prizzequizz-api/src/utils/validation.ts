import { ValidationError } from '../core/errors.js';

export function bodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Request body must be an object');
  return body as Record<string, unknown>;
}

export function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${key} is required`, { key });
  return value.trim();
}

export function optionalString(body: Record<string, unknown>, key: string, fallback = ''): string {
  const value = body[key];
  return typeof value === 'string' ? value.trim() : fallback;
}

export function requiredNumber(body: Record<string, unknown>, key: string): number {
  const value = Number(body[key]);
  if (!Number.isFinite(value)) throw new ValidationError(`${key} must be a number`, { key });
  return value;
}

export function optionalNumber(body: Record<string, unknown>, key: string, fallback = 0): number {
  const value = body[key] === undefined ? fallback : Number(body[key]);
  if (!Number.isFinite(value)) throw new ValidationError(`${key} must be a number`, { key });
  return value;
}

export function requiredOptions(body: Record<string, unknown>, key = 'options'): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.length !== 4 || value.some((x) => typeof x !== 'string' || !x.trim())) {
    throw new ValidationError('Exactly four non-empty options are required', { key });
  }
  return value.map((x) => String(x).trim());
}
