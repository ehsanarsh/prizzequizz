import type { ApiErrorPayload } from './contracts';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(payload: ApiErrorPayload) {
    super(payload.message);
    this.name = 'ApiError';
    this.code = payload.code;
    this.status = payload.status;
    this.details = payload.details;
  }
}

export function normalizeUnknownError(error: unknown): ApiErrorPayload {
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message, status: error.status, details: error.details };
  }
  if (error instanceof Error) {
    return { code: 'UNKNOWN_ERROR', message: error.message, status: 500 };
  }
  return { code: 'UNKNOWN_ERROR', message: 'Unknown API error', status: 500 };
}
