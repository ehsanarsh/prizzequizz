export function createIdempotencyKey(prefix: string, parts: Array<string | number | undefined | null> = []): string {
  const safe = parts.map((part) => String(part ?? 'x').replace(/[^a-zA-Z0-9_-]/g, '')).join('_');
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${safe}_${Date.now()}_${random}`;
}
