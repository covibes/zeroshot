"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withTargetRetry = withTargetRetry;
const bounds_js_1 = require("./bounds.cjs");
const errors_js_1 = require("./errors.cjs");
function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw signal.reason ?? new globalThis.DOMException('The operation was aborted', 'AbortError');
    }
}
async function wait(delayMs, signal) {
    throwIfAborted(signal);
    if (delayMs <= 0)
        return;
    await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason ?? new globalThis.DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
    });
}
function retryableError(value) {
    return value instanceof errors_js_1.TargetAdapterError && value.retryable;
}
function validRetryDelay(retry, delayMs, remaining) {
    return retry && Number.isFinite(delayMs) && delayMs >= 0 && delayMs < remaining;
}
async function withTargetRetry(operation, effect, signal, context) {
    const retrySafe = operation !== 'access';
    const started = context.clock.now();
    let attempt = 0;
    while (true) {
        throwIfAborted(signal);
        try {
            return await effect();
        }
        catch (error) {
            throwIfAborted(signal);
            if (!retrySafe || !retryableError(error))
                throw error;
            attempt += 1;
            const elapsed = context.clock.now() - started;
            const decision = context.policy.shouldRetry(attempt, elapsed, error);
            const remaining = bounds_js_1.MAX_RETRY_ELAPSED_MS - elapsed;
            if (!validRetryDelay(decision.retry, decision.delayMs, remaining))
                throw error;
            await wait(decision.delayMs, signal);
        }
    }
}
