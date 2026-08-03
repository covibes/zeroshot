"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TargetNotFoundError = exports.TargetCapacityError = exports.TargetProtocolError = exports.TargetTransportError = exports.TargetRateLimitError = exports.TargetConflictError = exports.TargetAuthError = exports.TargetServerError = exports.TargetAdapterError = void 0;
exports.isRetryable = isRetryable;
class TargetAdapterError extends Error {
    code;
    retryable;
    constructor(code, message, retryable) {
        super(message);
        this.name = 'TargetAdapterError';
        this.code = code;
        this.retryable = retryable;
    }
}
exports.TargetAdapterError = TargetAdapterError;
class TargetServerError extends TargetAdapterError {
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
exports.TargetServerError = TargetServerError;
class TargetAuthError extends TargetAdapterError {
    constructor(message) {
        super('AUTH_FAILED', message, false);
        this.name = 'TargetAuthError';
    }
}
exports.TargetAuthError = TargetAuthError;
class TargetConflictError extends TargetAdapterError {
    idempotencyKey;
    constructor(idempotencyKey, message) {
        super('CONFLICT', message, true);
        this.name = 'TargetConflictError';
        this.idempotencyKey = idempotencyKey;
    }
}
exports.TargetConflictError = TargetConflictError;
class TargetRateLimitError extends TargetAdapterError {
    retryAfterMs;
    constructor(message, retryAfterMs) {
        super('RATE_LIMITED', message, true);
        this.name = 'TargetRateLimitError';
        this.retryAfterMs = retryAfterMs;
    }
}
exports.TargetRateLimitError = TargetRateLimitError;
class TargetTransportError extends TargetAdapterError {
    constructor(message) {
        super('TRANSPORT', message, true);
        this.name = 'TargetTransportError';
    }
}
exports.TargetTransportError = TargetTransportError;
class TargetProtocolError extends TargetAdapterError {
    constructor(message) {
        super('PROTOCOL', message, false);
        this.name = 'TargetProtocolError';
    }
}
exports.TargetProtocolError = TargetProtocolError;
class TargetCapacityError extends TargetAdapterError {
    constructor(message) {
        super('CAPACITY', message, false);
        this.name = 'TargetCapacityError';
    }
}
exports.TargetCapacityError = TargetCapacityError;
class TargetNotFoundError extends TargetAdapterError {
    constructor(message) {
        super('NOT_FOUND', message, false);
        this.name = 'TargetNotFoundError';
    }
}
exports.TargetNotFoundError = TargetNotFoundError;
function isRetryable(error) {
    if (error instanceof TargetAdapterError)
        return error.retryable;
    return false;
}
