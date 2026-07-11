interface EnvRule {
  key: string;
  requiredInProduction?: boolean;
  disallowValuesInProduction?: string[];
  recommended?: boolean;
  description: string;
}

const rules: EnvRule[] = [
  { key: 'NODE_ENV', requiredInProduction: true, description: 'Runtime environment.' },
  { key: 'PORT', recommended: true, description: 'HTTP port.' },
  { key: 'API_BASE_PATH', recommended: true, description: 'API base path, usually /v1.' },
  { key: 'JWT_ACCESS_SECRET', requiredInProduction: true, disallowValuesInProduction: ['replace-in-production', 'dev-access-secret'], description: 'Access token signing secret.' },
  { key: 'JWT_REFRESH_SECRET', requiredInProduction: true, disallowValuesInProduction: ['replace-in-production', 'dev-refresh-secret'], description: 'Refresh token signing secret.' },
  { key: 'DATABASE_URL', requiredInProduction: true, description: 'PostgreSQL connection string.' },
  { key: 'REDIS_URL', requiredInProduction: true, description: 'Redis connection string.' },
  { key: 'REPOSITORY_DRIVER', requiredInProduction: true, disallowValuesInProduction: ['memory'], description: 'Repository driver: postgres in production.' },
  { key: 'REALTIME_ADAPTER', requiredInProduction: true, disallowValuesInProduction: ['memory'], description: 'Realtime adapter: redis in production.' },
  { key: 'LEADERBOARD_ADAPTER', requiredInProduction: true, disallowValuesInProduction: ['memory'], description: 'Leaderboard adapter: redis in production.' },
  { key: 'PAYMENT_PROVIDER', requiredInProduction: true, disallowValuesInProduction: ['sandbox'], description: 'Real payment provider in production.' },
  { key: 'PUSH_PROVIDER', recommended: true, description: 'Push provider: log or webpush.' },
  { key: 'VAPID_PUBLIC_KEY', recommended: true, description: 'Web Push public key.' },
  { key: 'VAPID_PRIVATE_KEY', recommended: true, description: 'Web Push private key.' },
  { key: 'CLOSED_BETA_REQUIRED', recommended: true, description: 'Closed beta gate switch.' },
  { key: 'ADMIN_KEY', requiredInProduction: true, disallowValuesInProduction: ['dev-admin'], description: 'Fallback admin key.' }
];

function main(): void {
  const production = process.env.NODE_ENV === 'production';
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const rule of rules) {
    const value = process.env[rule.key];
    if (production && rule.requiredInProduction && !value) errors.push(`${rule.key} is required in production. ${rule.description}`);
    if (!production && rule.recommended && !value) warnings.push(`${rule.key} is not set. ${rule.description}`);
    if (production && value && rule.disallowValuesInProduction?.includes(value)) errors.push(`${rule.key} has unsafe production value: ${value}`);
  }

  const summary = { ok: errors.length === 0, production, errors, warnings, checkedAt: new Date().toISOString() };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

main();
