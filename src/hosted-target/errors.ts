export class TargetAdapterError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'TargetAdapterError';
    this.code = code;
    this.retryable = retryable;
  }
}
export class TargetServerError extends TargetAdapterError {
  readonly status: number;
  readonly serverCode: string;
  readonly capsuleId: string | null;
  readonly retryAfterMs: number | undefined;

  constructor(
    status: number,
    serverCode: string,
    retryable: boolean,
    capsuleId: string | null,
    retryAfterMs?: number
  ) {
    super('SERVER_REJECTED', `Capsule request failed (${serverCode})`, retryable);
    this.name = 'TargetServerError';
    this.status = status;
    this.serverCode = serverCode;
    this.capsuleId = capsuleId;
    this.retryAfterMs = retryAfterMs;
  }
}
export class TargetAuthError extends TargetAdapterError {
  constructor(message: string) {
    super('AUTH_FAILED', message, false);
    this.name = 'TargetAuthError';
  }
}

export class TargetConflictError extends TargetAdapterError {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string, message: string) {
    super('CONFLICT', message, true);
    this.name = 'TargetConflictError';
    this.idempotencyKey = idempotencyKey;
  }
}

export class TargetRateLimitError extends TargetAdapterError {
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super('RATE_LIMITED', message, true);
    this.name = 'TargetRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class TargetTransportError extends TargetAdapterError {
  constructor(message: string) {
    super('TRANSPORT', message, true);
    this.name = 'TargetTransportError';
  }
}

export class TargetProtocolError extends TargetAdapterError {
  constructor(message: string) {
    super('PROTOCOL', message, false);
    this.name = 'TargetProtocolError';
  }
}

export class TargetCapacityError extends TargetAdapterError {
  constructor(message: string) {
    super('CAPACITY', message, false);
    this.name = 'TargetCapacityError';
  }
}

export class TargetNotFoundError extends TargetAdapterError {
  constructor(message: string) {
    super('NOT_FOUND', message, false);
    this.name = 'TargetNotFoundError';
  }
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof TargetAdapterError) return error.retryable;
  return false;
}
