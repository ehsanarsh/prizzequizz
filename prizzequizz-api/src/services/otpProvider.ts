import { id } from '../utils/id.js';

export interface OtpProvider {
  createOtp(phone: string): Promise<{ requestId: string; ttlSeconds: number }>;
  verifyOtp(requestId: string, code: string): Promise<{ phone: string } | null>;
}

interface OtpRecord {
  phone: string;
  code: string;
  expiresAt: number;
  attempts: number;
}

export class MemoryOtpProvider implements OtpProvider {
  private records = new Map<string, OtpRecord>();

  async createOtp(phone: string): Promise<{ requestId: string; ttlSeconds: number }> {
    const requestId = id();
    const code = process.env.NODE_ENV === 'production' ? String(Math.floor(1000 + Math.random() * 9000)) : '1234';
    const ttlSeconds = 120;
    this.records.set(requestId, { phone, code, expiresAt: Date.now() + ttlSeconds * 1000, attempts: 0 });
    // Production implementation should send SMS here.
    return { requestId, ttlSeconds };
  }

  async verifyOtp(requestId: string, code: string): Promise<{ phone: string } | null> {
    const record = this.records.get(requestId);
    if (!record) return null;
    record.attempts += 1;
    if (record.expiresAt < Date.now() || record.attempts > 5) {
      this.records.delete(requestId);
      return null;
    }
    if (record.code !== code) return null;
    this.records.delete(requestId);
    return { phone: record.phone };
  }
}

export const otpProvider = new MemoryOtpProvider();
