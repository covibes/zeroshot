function sanitize(text: string): string {
  return text
    .replace(/Authorization:\s*Bearer\s+\S+/gi, 'Authorization: Bearer [REDACTED]')
    .replace(/token["']?\s*[:=]\s*["'][^"']+["']/gi, 'token: "[REDACTED]"')
    .replace(/https?:\/\/[^\s]*(?:token|key|secret|credential|auth)[^\s]*/gi, '[REDACTED_URL]');
}

function sanitizeCause(cause: unknown): unknown {
  if (!cause) return cause;
  if (cause instanceof Error) {
    const cleaned = new Error(sanitize(cause.message));
    cleaned.name = cause.name;
    if (cause.cause) cleaned.cause = sanitizeCause(cause.cause);
    return cleaned;
  }
  if (typeof cause === 'string') return sanitize(cause);
  return cause;
}

export class TargetAdapterError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean, cause?: unknown) {
    super(sanitize(message), { cause: sanitizeCause(cause) });
    this.name = 'TargetAdapterError';
    this.code = code;
    this.retryable = retryable;
  }
}

export class TargetAuthError extends TargetAdapterError {
  constructor(message: string, cause?: unknown) {
    super('AUTH_FAILED', message, false, cause);
    this.name = 'TargetAuthError';
  }
}

export class TargetConflictError extends TargetAdapterError {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string, message: string, cause?: unknown) {
    super('CONFLICT', message, true, cause);
    this.name = 'TargetConflictError';
    this.idempotencyKey = idempotencyKey;
  }
}

export class TargetRateLimitError extends TargetAdapterError {
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number, cause?: unknown) {
    super('RATE_LIMITED', message, true, cause);
    this.name = 'TargetRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class TargetTransportError extends TargetAdapterError {
  constructor(message: string, cause?: unknown) {
    super('TRANSPORT', message, true, cause);
    this.name = 'TargetTransportError';
  }
}

export class TargetProtocolError extends TargetAdapterError {
  constructor(message: string, cause?: unknown) {
    super('PROTOCOL', message, false, cause);
    this.name = 'TargetProtocolError';
  }
}

export class TargetCapacityError extends TargetAdapterError {
  constructor(message: string, cause?: unknown) {
    super('CAPACITY', message, false, cause);
    this.name = 'TargetCapacityError';
  }
}

export class TargetNotFoundError extends TargetAdapterError {
  constructor(message: string, cause?: unknown) {
    super('NOT_FOUND', message, false, cause);
    this.name = 'TargetNotFoundError';
  }
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof TargetAdapterError) return error.retryable;
  return false;
}
