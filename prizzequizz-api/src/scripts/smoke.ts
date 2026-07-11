const base = `http://localhost:${process.env.PORT ?? 3000}${process.env.API_BASE_PATH ?? '/v1'}`;

async function main(): Promise<void> {
  const health = await fetch(`${base}/health`).then((r) => r.json());
  if (!health.ok) throw new Error('health failed');
  const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '+989120000000' }) }).then((r) => r.json());
  if (!login.ok) throw new Error('login failed');
  console.log('[smoke] API reachable');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
