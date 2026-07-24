import { resolveSegment, describeSegment } from '../services/notificationSegmentService.js';
import { createCampaign, recordCampaignResult, listCampaigns, campaignAnalytics, bumpCampaignClick, campaignDashboard } from '../services/notificationCampaignService.js';
import { repositories } from '../repositories/index.js';

(async () => {
  let pass = 0, fail = 0; const ok = (n: boolean, m: string) => { n ? pass++ : (fail++, console.log('  x', m)); };

  // Seed a spread of users (memory driver — DATABASE_URL unset in tests).
  const mk = (i: number, over: any) => ({ id: `seg-${i}`, phone: `+9891200000${i}`, username: `u${i}`, displayName: `U${i}`, plan: 'free', status: 'active', level: 1, xp: 0, weeklyScore: 0, wallet: 0, coins: 0, hearts: 5, tickets: { bronze: 0, silver: 0, gold: 0 }, ...over });
  await repositories.users.save(mk(1, { plan: 'paid', level: 10, xp: 5000, wallet: 500000, tickets: { bronze: 2, silver: 0, gold: 0 } }) as any);
  await repositories.users.save(mk(2, { plan: 'free', level: 3, xp: 300, wallet: 0 }) as any);
  await repositories.users.save(mk(3, { plan: 'paid', level: 7, xp: 2000, wallet: 100000, tickets: { bronze: 0, silver: 1, gold: 0 } }) as any);
  await repositories.users.save(mk(4, { plan: 'free', level: 1, xp: 0, wallet: 0, status: 'banned' }) as any);

  const only = (ids: string[]) => ids.filter((x) => x.startsWith('seg-'));

  // 1) plan segment
  let r = await resolveSegment({ plan: 'paid' });
  ok(only(r.userIds).sort().join(',') === 'seg-1,seg-3', 'plan=paid selects the two paid users');

  // 2) compound: paid AND level>=8
  r = await resolveSegment({ plan: 'paid', minLevel: 8 });
  ok(only(r.userIds).join(',') === 'seg-1', 'paid AND level>=8 selects only seg-1');

  // 3) hasTickets true
  r = await resolveSegment({ hasTickets: true });
  ok(only(r.userIds).sort().join(',') === 'seg-1,seg-3', 'hasTickets selects ticket holders');

  // 4) hasTickets false excludes ticket holders (and banned excluded by default)
  r = await resolveSegment({ hasTickets: false });
  ok(only(r.userIds).includes('seg-2') && !only(r.userIds).includes('seg-1') && !only(r.userIds).includes('seg-4'), 'hasTickets=false includes seg-2, excludes seg-1 and banned seg-4');

  // 5) walletGt
  r = await resolveSegment({ walletGt: 50000 });
  ok(only(r.userIds).sort().join(',') === 'seg-1,seg-3', 'walletGt filters by balance');

  // 6) banned excluded by default; status:banned targets them
  r = await resolveSegment({ base: 'all' });
  ok(!only(r.userIds).includes('seg-4'), 'banned excluded from base=all');
  r = await resolveSegment({ status: 'banned' });
  ok(only(r.userIds).join(',') === 'seg-4', 'status=banned targets the banned user');

  // 7) manual ids
  r = await resolveSegment({ userIds: ['seg-2', 'seg-3'] });
  ok(only(r.userIds).sort().join(',') === 'seg-2,seg-3', 'manual ids pass through');

  // 8) describeSegment is human-readable
  ok(describeSegment({ plan: 'paid', minLevel: 8 }).includes('اشتراک پولی'), 'describeSegment mentions paid');

  // 9) campaign lifecycle + analytics
  const c = await createCampaign({ title: 'تست', body: 'سلام', type: 'promo', action: { url: '/shop' }, segment: { plan: 'paid' }, audienceCount: 2, status: 'sending' });
  await recordCampaignResult(c.id, { created: 2, sent: 2, failed: 0, status: 'sent' });
  await bumpCampaignClick(c.id);
  const a = await campaignAnalytics(c.id);
  ok(!!a && a.sentCount === 2 && a.clickedCount === 1, 'campaign records sent + click');
  ok(!!a && a.ctr === 50, 'CTR = clicks/created = 50%');
  const list = await listCampaigns(50);
  ok(list.some((x) => x.id === c.id), 'campaign appears in history');
  const dash = await campaignDashboard();
  ok(dash.deliveredTotal >= 2 && dash.clicksTotal >= 1, 'dashboard rolls up delivered + clicks');

  console.log(`\nnotificationCenter: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
