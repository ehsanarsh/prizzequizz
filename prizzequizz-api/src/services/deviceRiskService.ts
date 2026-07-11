import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { repositories } from '../repositories/index.js';
import type { DeviceRecord, DeviceTrustStatus, RiskLevel, UserDeviceBinding, UserRiskProfile } from '../types/domain.js';
import { id } from '../utils/id.js';
import { logger } from './logger.js';
import { recordSecurityEvent } from './securityEvents.js';

export interface ObservedDeviceContext {
  device: DeviceRecord;
  binding: UserDeviceBinding;
  riskProfile: UserRiskProfile;
  sharedUserIds: string[];
}

export interface DeviceDiagnostics {
  devices: number;
  bindings: number;
  sharedDevices: number;
  highRiskUsers: number;
  criticalRiskUsers: number;
  topRiskUsers: UserRiskProfile[];
}

export async function observeRequestDevice(req: IncomingMessage, userId: string): Promise<ObservedDeviceContext | null> {
  if (!userId) return null;
  const observed = readObservedDevice(req);
  const now = new Date().toISOString();
  let device = await repositories.devices.findByFingerprintHash(observed.fingerprintHash);
  if (!device) {
    device = {
      id: id(),
      fingerprintHash: observed.fingerprintHash,
      clientDeviceId: observed.clientDeviceId,
      userAgent: observed.userAgent,
      platform: observed.platform,
      firstIpAddress: observed.ipAddress,
      lastIpAddress: observed.ipAddress,
      firstSeenAt: now,
      lastSeenAt: now,
      trustStatus: 'new'
    };
  } else {
    device.clientDeviceId = observed.clientDeviceId ?? device.clientDeviceId;
    device.userAgent = observed.userAgent ?? device.userAgent;
    device.platform = observed.platform ?? device.platform;
    device.lastIpAddress = observed.ipAddress;
    device.lastSeenAt = now;
  }
  await repositories.devices.saveDevice(device);

  let binding = await repositories.devices.findBinding(userId, device.id);
  if (!binding) {
    binding = { id: id(), userId, deviceId: device.id, firstSeenAt: now, lastSeenAt: now, lastIpAddress: observed.ipAddress, trustStatus: device.trustStatus, riskScore: 0 };
  } else {
    binding.lastSeenAt = now;
    binding.lastIpAddress = observed.ipAddress;
  }

  const shared = await repositories.devices.listBindingsByDevice(device.id);
  const sharedUserIds = [...new Set(shared.map((b) => b.userId).filter((id) => id !== userId))];
  if (sharedUserIds.length) {
    binding.trustStatus = binding.trustStatus === 'trusted' ? 'trusted' : 'limited';
    recordSecurityEvent({ req, userId, eventType: 'DEVICE_SHARED_BY_MULTIPLE_USERS', severity: sharedUserIds.length >= 3 ? 'critical' : 'warn', metadata: { deviceId: device.id, sharedUserIds } });
  }
  await repositories.devices.saveBinding(binding);

  const riskProfile = await calculateUserRisk(userId);
  binding.riskScore = riskProfile.riskScore;
  if (riskProfile.riskLevel === 'critical' && binding.trustStatus !== 'revoked') binding.trustStatus = 'limited';
  await repositories.devices.saveBinding(binding);

  return { device, binding, riskProfile, sharedUserIds };
}

export async function calculateUserRisk(userId: string): Promise<UserRiskProfile> {
  const bindings = await repositories.devices.listBindingsByUser(userId);
  const signals = await repositories.integrity.list({ userId, limit: 200 });
  const reasons: string[] = [];
  let score = 0;

  const criticalSignals = signals.filter((signal) => signal.severity === 'critical' && signal.status !== 'dismissed');
  const warnSignals = signals.filter((signal) => signal.severity === 'warn' && signal.status !== 'dismissed');
  if (criticalSignals.length) { score += Math.min(45, criticalSignals.length * 15); reasons.push(`${criticalSignals.length} critical integrity signal(s)`); }
  if (warnSignals.length) { score += Math.min(25, warnSignals.length * 5); reasons.push(`${warnSignals.length} warning integrity signal(s)`); }

  let sharedDeviceCount = 0;
  for (const binding of bindings) {
    const allOnDevice = await repositories.devices.listBindingsByDevice(binding.deviceId);
    const distinctUsers = new Set(allOnDevice.map((item) => item.userId));
    if (distinctUsers.size > 1) sharedDeviceCount += 1;
    if (binding.trustStatus === 'revoked') { score += 35; reasons.push('revoked device binding'); }
    if (binding.trustStatus === 'limited') { score += 10; reasons.push('limited device binding'); }
  }
  if (sharedDeviceCount) { score += Math.min(35, sharedDeviceCount * 18); reasons.push(`${sharedDeviceCount} shared device(s)`); }
  if (bindings.length >= 5) { score += 10; reasons.push('many devices'); }

  score = Math.max(0, Math.min(100, score));
  const profile: UserRiskProfile = {
    userId,
    riskScore: score,
    riskLevel: riskLevel(score),
    reasons: [...new Set(reasons)],
    deviceCount: bindings.length,
    sharedDeviceCount,
    integritySignalCount: signals.length,
    updatedAt: new Date().toISOString()
  };
  await repositories.devices.saveRiskProfile(profile);
  return profile;
}

export async function listCurrentUserDevices(userId: string): Promise<Array<UserDeviceBinding & { device?: DeviceRecord; sharedUsers: number }>> {
  const bindings = await repositories.devices.listBindingsByUser(userId);
  const enriched = [];
  for (const binding of bindings) {
    const device = await repositories.devices.findById(binding.deviceId) ?? undefined;
    const sharedUsers = new Set((await repositories.devices.listBindingsByDevice(binding.deviceId)).map((item) => item.userId)).size;
    enriched.push({ ...binding, device, sharedUsers });
  }
  return enriched;
}

export async function updateDeviceBindingStatus(bindingId: string, status: DeviceTrustStatus, reviewedBy: string): Promise<UserDeviceBinding | null> {
  const updated = await repositories.devices.updateBindingStatus(bindingId, status);
  if (updated) {
    await calculateUserRisk(updated.userId);
    logger.warn('device_binding_status_updated', { bindingId, userId: updated.userId, status, reviewedBy });
  }
  return updated;
}

export async function deviceDiagnostics(): Promise<DeviceDiagnostics> {
  const devices = await repositories.devices.listDevices(1000);
  const profiles = await repositories.devices.listRiskProfiles(1000);
  let bindings = 0;
  let sharedDevices = 0;
  for (const device of devices) {
    const deviceBindings = await repositories.devices.listBindingsByDevice(device.id);
    bindings += deviceBindings.length;
    if (new Set(deviceBindings.map((binding) => binding.userId)).size > 1) sharedDevices += 1;
  }
  return {
    devices: devices.length,
    bindings,
    sharedDevices,
    highRiskUsers: profiles.filter((p) => p.riskLevel === 'high').length,
    criticalRiskUsers: profiles.filter((p) => p.riskLevel === 'critical').length,
    topRiskUsers: profiles.slice(0, 10)
  };
}

function readObservedDevice(req: IncomingMessage): { fingerprintHash: string; clientDeviceId?: string; userAgent?: string; platform?: string; ipAddress?: string } {
  const header = (name: string) => req.headers[name.toLowerCase()]?.toString();
  const clientDeviceId = header('x-device-id')?.slice(0, 160);
  const rawFingerprint = header('x-device-fingerprint') || [clientDeviceId, req.headers['user-agent'], header('x-platform')].filter(Boolean).join('|') || 'anonymous-device';
  return {
    fingerprintHash: hash(rawFingerprint),
    clientDeviceId,
    userAgent: req.headers['user-agent']?.toString(),
    platform: header('x-platform')?.slice(0, 120),
    ipAddress: req.socket.remoteAddress
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function riskLevel(score: number): RiskLevel {
  if (score >= 80) return 'critical';
  if (score >= 55) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}
