export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, 422, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super('UNAUTHORIZED', message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super('FORBIDDEN', message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super('NOT_FOUND', `${resource} not found`, 404);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, 409, details);
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    const known = knownErrorMap[error.message];
    if (known) return new AppError(known.code, known.message, known.status);
    return new AppError('INTERNAL_ERROR', error.message || 'Internal error', 500);
  }
  return new AppError('INTERNAL_ERROR', 'Internal error', 500);
}

const knownErrorMap: Record<string, { code: string; message: string; status: number }> = {
  USER_NOT_FOUND: { code: 'USER_NOT_FOUND', message: 'User not found', status: 404 },
  MATCH_NOT_FOUND: { code: 'MATCH_NOT_FOUND', message: 'Match not found', status: 404 },
  QUESTION_NOT_FOUND: { code: 'QUESTION_NOT_FOUND', message: 'Question not found', status: 404 },
  NO_QUESTIONS: { code: 'NO_QUESTIONS', message: 'No approved questions available', status: 503 },
  INSUFFICIENT_HEARTS: { code: 'INSUFFICIENT_HEARTS', message: 'Not enough hearts', status: 409 },
  INSUFFICIENT_COINS: { code: 'INSUFFICIENT_COINS', message: 'Not enough coins', status: 409 },
  INSUFFICIENT_BALANCE: { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient wallet balance', status: 409 },
  MATCH_NOT_ACCEPTING_ANSWERS: { code: 'MATCH_NOT_ACCEPTING_ANSWERS', message: 'Match is not accepting answers', status: 409 },
  MODE_NOT_FOUND: { code: 'MODE_NOT_FOUND', message: 'Mode not found', status: 404 }
};
