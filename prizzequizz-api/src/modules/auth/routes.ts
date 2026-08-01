import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { repositories } from '../../repositories/index.js';
import { grantNewUserCampaign } from '../../services/campaignService.js';
import { OtpError, otpProvider } from '../../services/otpProvider.js';
import { createSession, refreshSession, revokeRefreshToken } from '../../services/sessionService.js';
import { recordSecurityEvent } from '../../services/securityEvents.js';
import { ensureBetaAccess } from '../../services/betaService.js';
import { observeRequestDevice } from '../../services/deviceRiskService.js';
import { id } from '../../utils/id.js';
import { bodyObject, requiredString } from '../../utils/validation.js';
import { effectiveWeeklyScore } from '../../services/scoringConfig.js';

export function registerAuthRoutes(router: Router, base: string): void {
  router.add('POST', `${base}/auth/login`, async (ctx) => {
    const body = bodyObject(ctx.body);
    const phone = requiredString(body, 'phone');
    if (!/^09\d{9}$/.test(phone)) return error(ctx.res, 422, 'PHONE_INVALID', 'شماره موبایل معتبر نیست.');
    try {
      const otp = await otpProvider.createOtp(phone);
      /* The phone comes back so the code screen can say which number the code
       * went to instead of printing a made-up example, and the two timings so
       * its countdown is the server's, not a guess. */
      json(ctx.res, 200, {
        otpRequired: true,
        requestId: otp.requestId,
        ttlSeconds: otp.ttlSeconds,
        resendAfterSeconds: otp.resendAfterSeconds,
        phone,
        delivered: otp.delivered,
        testMode: otp.testMode
      });
    } catch (e) {
      if (e instanceof OtpError) {
        recordSecurityEvent({ req: ctx.req, eventType: 'OTP_SEND_REFUSED', severity: 'warn', metadata: { code: e.code } });
        return error(ctx.res, e.status, e.code, e.message);
      }
      throw e;
    }
  });

  router.add('POST', `${base}/auth/otp/verify`, async (ctx) => {
    const body = bodyObject(ctx.body);
    const requestId = requiredString(body, 'requestId');
    const code = requiredString(body, 'code');
    const inviteCode = typeof body.inviteCode === 'string' ? body.inviteCode : undefined;
    const verified = await otpProvider.verifyOtp(requestId, code);
    if (!verified) {
      recordSecurityEvent({ req: ctx.req, eventType: 'OTP_VERIFY_FAILED', severity: 'warn', metadata: { requestId } });
      return error(ctx.res, 401, 'OTP_INVALID', 'Invalid or expired OTP');
    }
    let user = await repositories.users.findByPhone(verified.phone);
    if (!user) {
      user = { id: id(), phone: verified.phone, username: `user_${Date.now()}`, displayName: 'بازیکن جدید', plan: 'free', level: 1, xp: 0, weeklyScore: 0, wallet: 0, coins: 350, hearts: 5, tickets: { bronze: 0, silver: 0, gold: 0 } };
      await repositories.users.save(user);
      // Auto new-user reward campaign (no-op unless enabled + in date window).
      await grantNewUserCampaign(user.id);
      user = (await repositories.users.findByPhone(verified.phone)) ?? user; // reflect XP grant
    }
    const allowed = await ensureBetaAccess(user.id, inviteCode);
    if (!allowed) return error(ctx.res, 403, 'BETA_INVITE_REQUIRED', 'Closed beta invite code is required.');
    await observeRequestDevice(ctx.req, user.id).catch(() => undefined);
    const tokens = createSession(user.id, 'user');
    json(ctx.res, 200, { ...tokens, user: toDto(user) });
  });

  router.add('POST', `${base}/auth/refresh`, (ctx) => {
    const token = requiredString(bodyObject(ctx.body), 'refreshToken');
    const refreshed = refreshSession(token);
    if (!refreshed) {
      recordSecurityEvent({ req: ctx.req, eventType: 'REFRESH_FAILED', severity: 'warn' });
      return error(ctx.res, 401, 'REFRESH_INVALID', 'Invalid refresh token');
    }
    json(ctx.res, 200, refreshed);
  });

  router.add('POST', `${base}/auth/logout`, (ctx) => {
    const token = requiredString(bodyObject(ctx.body), 'refreshToken');
    json(ctx.res, 200, { revoked: revokeRefreshToken(token) });
  });
}

function toDto(user: any) {
  return { id: user.id, username: user.username, displayName: user.displayName, plan: user.plan, level: user.level, xp: user.xp, weeklyScore: effectiveWeeklyScore(user), balances: { wallet: user.wallet, coins: user.coins, hearts: user.hearts, tickets: user.tickets } };
}
