export class TargetAdapterError extends Error {
  code;
  retryable;
  constructor(code, message, retryable) {
    super(message);
    this.name = 'TargetAdapterError';
    this.code = code;
    this.retryable = retryable;
  }
}
export class TargetServerError extends TargetAdapterError {
  status;
  serverCode;
  capsuleId;
  retryAfterMs;
  constructor(status, serverCode, retryable, capsuleId, retryAfterMs) {
    super('SERVER_REJECTED', `Capsule request failed (${serverCode})`, retryable);
    this.name = 'TargetServerError';
    this.status = status;
    this.serverCode = serverCode;
    this.capsuleId = capsuleId;
    this.retryAfterMs = retryAfterMs;
  }
}
export class TargetAuthError extends TargetAdapterError {
  constructor(message) {
    super('AUTH_FAILED', message, false);
    this.name = 'TargetAuthError';
  }
}
export class TargetConflictError extends TargetAdapterError {
  idempotencyKey;
  constructor(idempotencyKey, message) {
    super('CONFLICT', message, true);
    this.name = 'TargetConflictError';
    this.idempotencyKey = idempotencyKey;
  }
}
export class TargetRateLimitError extends TargetAdapterError {
  retryAfterMs;
  constructor(message, retryAfterMs) {
    super('RATE_LIMITED', message, true);
    this.name = 'TargetRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}
export class TargetTransportError extends TargetAdapterError {
  constructor(message) {
    super('TRANSPORT', message, true);
    this.name = 'TargetTransportError';
  }
}
export class TargetProtocolError extends TargetAdapterError {
  constructor(message) {
    super('PROTOCOL', message, false);
    this.name = 'TargetProtocolError';
  }
}
export class TargetCapacityError extends TargetAdapterError {
  constructor(message) {
    super('CAPACITY', message, false);
    this.name = 'TargetCapacityError';
  }
}
export class TargetNotFoundError extends TargetAdapterError {
  constructor(message) {
    super('NOT_FOUND', message, false);
    this.name = 'TargetNotFoundError';
  }
}
export function isRetryable(error) {
  if (error instanceof TargetAdapterError) return error.retryable;
  return false;
}
