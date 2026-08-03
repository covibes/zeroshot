'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.DefaultRetryPolicy = void 0;
exports.parseRetryAfter = parseRetryAfter;
const bounds_ts_1 = require('./bounds.cjs');
const errors_ts_1 = require('./errors.cjs');
class DefaultRetryPolicy {
  shouldRetry(attempt, elapsed, error) {
    if (error instanceof errors_ts_1.TargetAuthError) return { retry: false, delayMs: 0 };
    if (!error.retryable) return { retry: false, delayMs: 0 };
    if (attempt >= bounds_ts_1.MAX_RETRY_ATTEMPTS) return { retry: false, delayMs: 0 };
    if (elapsed >= bounds_ts_1.MAX_RETRY_ELAPSED_MS) return { retry: false, delayMs: 0 };
    const requestedDelay =
      (error instanceof errors_ts_1.TargetRateLimitError ||
        error instanceof errors_ts_1.TargetServerError) &&
      error.retryAfterMs !== undefined
        ? Math.max(0, error.retryAfterMs)
        : Math.min(1000 * Math.pow(2, attempt), 10_000);
    const remaining = bounds_ts_1.MAX_RETRY_ELAPSED_MS - elapsed;
    if (!Number.isFinite(requestedDelay) || requestedDelay >= remaining) {
      return { retry: false, delayMs: 0 };
    }
    return { retry: true, delayMs: requestedDelay };
  }
}
exports.DefaultRetryPolicy = DefaultRetryPolicy;
function parseRetryAfter(header, clock) {
  if (header === null) return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;
  const numericSeconds = Number(trimmed);
  if (Number.isFinite(numericSeconds) && numericSeconds >= 0) {
    return Math.ceil(numericSeconds * 1000);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  const delayMs = date - clock.now();
  return delayMs > 0 ? Math.ceil(delayMs) : 0;
}
