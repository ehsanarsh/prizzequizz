import { repositories } from '../repositories/index.js';
import type { BetaAccess, BetaInvite, BetaInviteStatus } from '../types/domain.js';

export interface BetaDiagnostics {
  required: boolean;
  activeInvites: number;
  disabledInvites: number;
  expiredInvites: number;
  grantedUsers: number;
  remainingUses: number;
}

export async function createBetaInvite(input: { code?: string; maxUses?: number; expiresAt?: string; note?: string; createdBy?: string }): Promise<BetaInvite> {
  const invite: BetaInvite = {
    code: normalizeCode(input.code ?? randomCode()),
    maxUses: Math.max(1, Number(input.maxUses ?? 1)),
    usedCount: 0,
    status: 'active',
    note: input.note,
    createdBy: input.createdBy ?? 'system',
    createdAt: new Date().toISOString(),
    expiresAt: input.expiresAt
  };
  await repositories.beta.saveInvite(invite);
  return invite;
}

export async function redeemBetaInvite(userId: string, rawCode: string, grantedBy: string = 'system'): Promise<BetaAccess> {
  const code = normalizeCode(rawCode);
  const existingAccess = await repositories.beta.findAccess(userId);
  if (existingAccess) return existingAccess;
  const invite = await repositories.beta.findInvite(code);
  if (!invite) throw new Error('BETA_INVITE_NOT_FOUND');
  if (!isInviteUsable(invite)) throw new Error('BETA_INVITE_INVALID');
  invite.usedCount += 1;
  if (invite.usedCount >= invite.maxUses) invite.status = 'disabled';
  await repositories.beta.saveInvite(invite);
  const access: BetaAccess = { userId, inviteCode: invite.code, grantedAt: new Date().toISOString(), grantedBy };
  await repositories.beta.saveAccess(access);
  return access;
}

export async function ensureBetaAccess(userId: string, inviteCode?: string): Promise<boolean> {
  if (!betaRequired()) return true;
  if (await repositories.beta.findAccess(userId)) return true;
  if (!inviteCode) return false;
  await redeemBetaInvite(userId, inviteCode, 'system');
  return true;
}

export async function betaStatus(userId: string) {
  return { required: betaRequired(), access: await repositories.beta.findAccess(userId) };
}

export async function listBetaInvites(limit = 100): Promise<BetaInvite[]> {
  return repositories.beta.listInvites(limit);
}

export async function listBetaUsers(limit = 100): Promise<BetaAccess[]> {
  return repositories.beta.listAccess(limit);
}

export async function updateBetaInviteStatus(code: string, status: BetaInviteStatus): Promise<BetaInvite | null> {
  return repositories.beta.updateInviteStatus(normalizeCode(code), status);
}

export async function betaDiagnostics(): Promise<BetaDiagnostics> {
  const invites = await repositories.beta.listInvites(500);
  const access = await repositories.beta.listAccess(500);
  return {
    required: betaRequired(),
    activeInvites: invites.filter((i) => isInviteUsable(i)).length,
    disabledInvites: invites.filter((i) => i.status === 'disabled').length,
    expiredInvites: invites.filter((i) => i.status === 'expired' || isExpired(i)).length,
    grantedUsers: access.length,
    remainingUses: invites.filter((i) => isInviteUsable(i)).reduce((sum, i) => sum + Math.max(0, i.maxUses - i.usedCount), 0)
  };
}

export function betaRequired(): boolean {
  return process.env.CLOSED_BETA_REQUIRED === 'true';
}

function isInviteUsable(invite: BetaInvite): boolean {
  return invite.status === 'active' && invite.usedCount < invite.maxUses && !isExpired(invite);
}

function isExpired(invite: BetaInvite): boolean {
  return Boolean(invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now());
}

function normalizeCode(code: string): string { return code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 80); }
function randomCode(): string { return `BETA-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
