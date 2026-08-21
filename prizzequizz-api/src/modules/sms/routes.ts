/* SMS PANEL — admin REST. All under the 'sms' permission tab. */
import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { bodyObject, optionalString } from '../../utils/validation.js';
import {
  listGroups, createGroup, renameGroup, deleteGroup,
  addNumber, addNumbers, removeNumber, listNumbers, sendToGroup, GroupError
} from '../../services/smsGroupService.js';
import {
  getSmsConfig, updateSmsConfig, maskConfig, listTemplates, saveTemplate, removeTemplate,
  listLog, listBlacklist, addBlacklist, removeBlacklist, smsStats, sendSms, resend, cancelPending,
  niazpardazAccount
} from '../../services/smsService.js';

export function registerSmsRoutes(router: Router, base: string): void {
  const guard = (ctx: any) => requireAdmin(ctx, { tab: 'sms' });

  router.add('GET', `${base}/admin/sms/config`, async (ctx) => { if (!guard(ctx)) return; json(ctx.res, 200, maskConfig(await getSmsConfig())); });
  router.add('PUT', `${base}/admin/sms/config`, async (ctx) => {
    if (!guard(ctx)) return;
    const b = bodyObject(ctx.body) as any;
    const patch: any = {
      enabled: !!b.enabled, sandbox: !!b.sandbox, provider: String(b.provider || 'sandbox'),
      sender: String(b.sender || ''), genericUrl: b.genericUrl != null ? String(b.genericUrl) : undefined,
      otp: {
        maxPerHour: Number(b?.otp?.maxPerHour ?? 5),
        expirySeconds: Number(b?.otp?.expirySeconds ?? 120),
        minIntervalSeconds: Number(b?.otp?.minIntervalSeconds ?? 60),
        testCode: String(b?.otp?.testCode ?? '1234').replace(/\D/g, '').slice(0, 6) || '1234'
      }
    };
    // Keep existing secret/apiKey when the field is blank or still masked.
    if (b.apiKey && !String(b.apiKey).startsWith('••••')) patch.apiKey = String(b.apiKey);
    if (b.secret && !String(b.secret).startsWith('••••')) patch.secret = String(b.secret);
    json(ctx.res, 200, maskConfig(await updateSmsConfig(patch)));
  });
  /* Reads the panel back: remaining credit and the sender lines the key is
   * allowed to use. It answers the two questions a failed send raises — is the
   * key right, and is the sender number one this account actually owns —
   * without spending an SMS to find out. */
  router.add('GET', `${base}/admin/sms/account`, async (ctx) => {
    if (!guard(ctx)) return;
    const cfg = await getSmsConfig();
    if (cfg.provider !== 'niazpardaz') return json(ctx.res, 200, { provider: cfg.provider, supported: false });
    const acc = await niazpardazAccount(cfg);
    json(ctx.res, 200, { provider: cfg.provider, supported: true, ...acc, senderConfigured: cfg.sender, senderValid: !acc.senders.length ? null : acc.senders.includes(cfg.sender) });
  });

  router.add('POST', `${base}/admin/sms/test`, async (ctx) => {
    if (!guard(ctx)) return;
    const b = bodyObject(ctx.body) as any;
    const to = String(b.to || '').trim(); if (!to) return error(ctx.res, 422, 'TO_REQUIRED', 'شماره مقصد لازم است.');
    const log = await sendSms(to, String(b.body || 'پیام آزمایشی پرایز کوییز ✅'), null);
    json(ctx.res, 200, log);
  });

  router.add('GET', `${base}/admin/sms/templates`, async (ctx) => { if (!guard(ctx)) return; json(ctx.res, 200, { rows: await listTemplates() }); });
  router.add('POST', `${base}/admin/sms/templates`, async (ctx) => {
    if (!guard(ctx)) return; const b = bodyObject(ctx.body) as any;
    try { await saveTemplate({ key: String(b.key || ''), title: String(b.title || ''), text: String(b.text || '') }); json(ctx.res, 200, { saved: true }); }
    catch (e) { error(ctx.res, 422, 'TEMPLATE_INVALID', (e as Error).message); }
  });
  router.add('DELETE', `${base}/admin/sms/templates/:key`, async (ctx) => {
    if (!guard(ctx)) return;
    try { await removeTemplate(decodeURIComponent(ctx.params.key!)); json(ctx.res, 200, { removed: true }); }
    catch (e) {
      if ((e as Error).message === 'TEMPLATE_BUILTIN') {
        return error(ctx.res, 409, 'TEMPLATE_BUILTIN', 'این قالب از پیام‌های خود بازی است و حذف نمی‌شود — متنش را می‌توانی تغییر بدهی.');
      }
      throw e;
    }
  });

  router.add('GET', `${base}/admin/sms/log`, async (ctx) => { if (!guard(ctx)) return; json(ctx.res, 200, { rows: await listLog({ status: ctx.query.get('status') || undefined, recipient: ctx.query.get('q') || undefined, limit: Number(ctx.query.get('limit') ?? 100) }) }); });
  router.add('POST', `${base}/admin/sms/log/:id/resend`, async (ctx) => { if (!guard(ctx)) return; const r = await resend(ctx.params.id!); if (!r) return error(ctx.res, 404, 'LOG_NOT_FOUND', 'یافت نشد.'); json(ctx.res, 200, r); });
  router.add('POST', `${base}/admin/sms/log/:id/cancel`, async (ctx) => { if (!guard(ctx)) return; await cancelPending(ctx.params.id!); json(ctx.res, 200, { cancelled: true }); });

  router.add('GET', `${base}/admin/sms/stats`, async (ctx) => { if (!guard(ctx)) return; json(ctx.res, 200, await smsStats()); });

  /* ===== Number groups: a list of people who are not players =====
   * The panel could message registered players; it could not keep a list of
   * leads and message that. Numbers go in one at a time — number, Enter,
   * number, Enter — which is how somebody actually types them. */
  router.add('GET', `${base}/admin/sms/groups`, async (ctx) => {
    if (!guard(ctx)) return;
    json(ctx.res, 200, await listGroups());
  });
  router.add('POST', `${base}/admin/sms/groups`, async (ctx) => {
    if (!guard(ctx)) return;
    const b = bodyObject(ctx.body);
    try { json(ctx.res, 201, await createGroup(String(b.name ?? ''), optionalString(b, 'note'))); }
    catch (e) { if (e instanceof GroupError) return error(ctx.res, 400, e.code, e.message); throw e; }
  });
  router.add('PUT', `${base}/admin/sms/groups/:id`, async (ctx) => {
    if (!guard(ctx)) return;
    const b = bodyObject(ctx.body);
    try { json(ctx.res, 200, { updated: await renameGroup(ctx.params.id!, String(b.name ?? ''), optionalString(b, 'note')) }); }
    catch (e) { if (e instanceof GroupError) return error(ctx.res, 400, e.code, e.message); throw e; }
  });
  router.add('DELETE', `${base}/admin/sms/groups/:id`, async (ctx) => {
    if (!guard(ctx)) return;
    json(ctx.res, 200, { removed: await deleteGroup(ctx.params.id!) });
  });

  router.add('GET', `${base}/admin/sms/groups/:id/numbers`, async (ctx) => {
    if (!guard(ctx)) return;
    json(ctx.res, 200, await listNumbers(ctx.params.id!, Number(ctx.query.get('limit') ?? 500)));
  });
  /* One number per call: this is the Enter key. A pasted block goes to the
   * same place through `numbers`. */
  router.add('POST', `${base}/admin/sms/groups/:id/numbers`, async (ctx) => {
    if (!guard(ctx)) return;
    const b = bodyObject(ctx.body);
    try {
      if (typeof b.numbers === 'string' && b.numbers.trim()) {
        return json(ctx.res, 200, await addNumbers(ctx.params.id!, b.numbers));
      }
      json(ctx.res, 200, await addNumber(ctx.params.id!, String(b.phone ?? ''), optionalString(b, 'label')));
    } catch (e) { if (e instanceof GroupError) return error(ctx.res, 400, e.code, e.message); throw e; }
  });
  router.add('DELETE', `${base}/admin/sms/groups/:id/numbers/:phone`, async (ctx) => {
    if (!guard(ctx)) return;
    json(ctx.res, 200, { removed: await removeNumber(ctx.params.id!, ctx.params.phone!) });
  });

  router.add('POST', `${base}/admin/sms/groups/:id/send`, async (ctx) => {
    if (!guard(ctx)) return;
    const b = bodyObject(ctx.body);
    try { json(ctx.res, 200, await sendToGroup({ groupId: ctx.params.id!, text: String(b.text ?? ''), link: optionalString(b, 'link') })); }
    catch (e) { if (e instanceof GroupError) return error(ctx.res, 400, e.code, e.message); throw e; }
  });

  router.add('GET', `${base}/admin/sms/blacklist`, async (ctx) => { if (!guard(ctx)) return; json(ctx.res, 200, { rows: await listBlacklist() }); });
  router.add('POST', `${base}/admin/sms/blacklist`, async (ctx) => { if (!guard(ctx)) return; const b = bodyObject(ctx.body) as any; const n = String(b.number || '').trim(); if (!n) return error(ctx.res, 422, 'NUMBER_REQUIRED', 'شماره لازم است.'); await addBlacklist(n, b.reason ? String(b.reason) : undefined); json(ctx.res, 201, { added: true }); });
  router.add('DELETE', `${base}/admin/sms/blacklist/:number`, async (ctx) => { if (!guard(ctx)) return; await removeBlacklist(decodeURIComponent(ctx.params.number!)); json(ctx.res, 200, { removed: true }); });
}
