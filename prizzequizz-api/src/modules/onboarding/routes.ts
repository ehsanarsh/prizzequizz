/* ONBOARDING — the welcome slides: public read, admin CRUD. */
import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { bodyObject } from '../../utils/validation.js';
import { OnboardingError, activeSlides, listSlides, saveSlide, deleteSlide } from '../../services/onboardingService.js';

export function registerOnboardingRoutes(router: Router, base: string): void {
  /* Open on purpose: the welcome slides are shown before anybody has an
   * account, so requiring a token would mean nobody ever sees them. */
  router.add('GET', `${base}/onboarding`, async (ctx) => {
    json(ctx.res, 200, { slides: await activeSlides() });
  });

  const guard = (ctx: any) => requireAdmin(ctx, { tab: 'onboarding' });

  router.add('GET', `${base}/admin/onboarding`, async (ctx) => {
    if (!guard(ctx)) return;
    json(ctx.res, 200, { rows: await listSlides() });
  });

  router.add('POST', `${base}/admin/onboarding`, async (ctx) => {
    if (!guard(ctx)) return;
    try { json(ctx.res, 200, await saveSlide(bodyObject(ctx.body) as any)); }
    catch (e) {
      if (e instanceof OnboardingError) return error(ctx.res, 422, e.code, e.message);
      throw e;
    }
  });

  router.add('DELETE', `${base}/admin/onboarding/:id`, async (ctx) => {
    if (!guard(ctx)) return;
    const gone = await deleteSlide(ctx.params.id!);
    if (!gone) return error(ctx.res, 404, 'SLIDE_NOT_FOUND', 'این اسلاید وجود ندارد.');
    json(ctx.res, 200, { removed: true });
  });
}
