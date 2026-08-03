export declare class TargetAdapterError extends Error {
    readonly code: string;
    readonly retryable: boolean;
    constructor(code: string, message: string, retryable: boolean);
}
export declare class TargetServerError extends TargetAdapterError {
    readonly status: number;
    readonly serverCode: string;
    readonly capsuleId: string | null;
    readonly retryAfterMs: number | undefined;
    constructor(status: number, serverCode: string, retryable: boolean, capsuleId: string | null, retryAfterMs?: number);
}
export declare class TargetAuthError extends TargetAdapterError {
    constructor(message: string);
}
export declare class TargetConflictError extends TargetAdapterError {
    readonly idempotencyKey: string;
    constructor(idempotencyKey: string, message: string);
}
export declare class TargetRateLimitError extends TargetAdapterError {
    readonly retryAfterMs: number | undefined;
    constructor(message: string, retryAfterMs?: number);
}
export declare class TargetTransportError extends TargetAdapterError {
    constructor(message: string);
}
export declare class TargetProtocolError extends TargetAdapterError {
    constructor(message: string);
}
export declare class TargetCapacityError extends TargetAdapterError {
    constructor(message: string);
}
export declare class TargetNotFoundError extends TargetAdapterError {
    constructor(message: string);
}
export declare function isRetryable(error: unknown): boolean;
