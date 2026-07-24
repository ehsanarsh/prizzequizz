import { createReport, listReports, reportCounts, setReportStatus, REPORT_REASONS, reasonLabel } from '../services/questionReportService.js';
import { repositories } from '../repositories/index.js';

(async () => {
  let pass = 0, fail = 0; const ok = (n: boolean, m: string) => { n ? pass++ : (fail++, console.log('  x', m)); };

  // Seed an approved question so the report snapshots its text/category.
  const qid = '00000000-0000-4000-8000-00000000q001'.replace(/q/g, '9');
  await repositories.questions.save({ id: qid, category: 'فوتبال', difficulty: 'easy', text: 'پایتخت ایران؟', options: ['تهران', 'شیراز', 'اصفهان', 'تبریز'], correctIndex: 0, tags: [], status: 'approved', version: 1 } as any);

  // 1) valid report is created open, snapshots question text
  const r1 = await createReport({ questionId: qid, userId: 'u-1', matchId: 'm-1', reason: 'wrong_answer', note: 'جواب اشتباهه' });
  ok(r1.status === 'open', 'report created open');
  ok(r1.reasonLabel === reasonLabel('wrong_answer'), 'reason label resolved');
  ok(r1.questionText === 'پایتخت ایران؟', 'question text snapshotted');
  ok(r1.category === 'فوتبال', 'category snapshotted');

  // 2) invalid reason rejected
  let threw = false; try { await createReport({ questionId: qid, reason: 'nonsense' }); } catch { threw = true; }
  ok(threw, 'invalid reason rejected');

  // 3) missing questionId rejected
  let threw2 = false; try { await createReport({ questionId: '', reason: 'typo' }); } catch { threw2 = true; }
  ok(threw2, 'missing questionId rejected');

  // 4) a report for a question that does not exist still succeeds (no snapshot)
  const r2 = await createReport({ questionId: 'ghost-q', reason: 'unclear' });
  ok(r2.status === 'open' && !r2.questionText, 'report for unknown question ok, no snapshot');

  // 5) listing open + counts
  const open = await listReports('open', 100);
  ok(open.some((r) => r.id === r1.id), 'open list contains r1');
  const c1 = await reportCounts();
  ok(c1.open >= 2, 'open count >= 2');

  // 6) resolve moves it out of open
  ok(await setReportStatus(r1.id, 'resolved', 'admin-1'), 'resolve succeeds');
  ok(!(await listReports('open', 100)).some((r) => r.id === r1.id), 'resolved no longer in open');
  ok((await listReports('resolved', 100)).some((r) => r.id === r1.id), 'resolved shows in resolved list');

  // 7) double-resolve fails (already handled)
  ok(!(await setReportStatus(r1.id, 'dismissed', 'admin-1')), 'cannot re-handle a handled report');

  // 8) dismiss the second one
  ok(await setReportStatus(r2.id, 'dismissed', 'admin-1'), 'dismiss succeeds');
  const c2 = await reportCounts();
  ok(c2.resolved >= 1 && c2.dismissed >= 1, 'counts reflect resolved + dismissed');

  // 9) all reasons have unique codes + labels
  ok(new Set(REPORT_REASONS.map((r) => r.code)).size === REPORT_REASONS.length, 'reason codes unique');

  console.log(`\nquestionReports: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
