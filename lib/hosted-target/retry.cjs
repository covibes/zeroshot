'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.DefaultRetryPolicy = void 0;
exports.parseRetryAfter = parseRetryAfter;
const bounds_js_1 = require('./bounds.cjs');
const errors_js_1 = require('./errors.cjs');
const IMF_WEEKDAYS = new Set(['Mon,', 'Tue,', 'Wed,', 'Thu,', 'Fri,', 'Sat,', 'Sun,']);
const IMF_MONTHS = new Set([
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]);
function fixedDigits(value, length) {
  if (value.length !== length) return false;
  for (const character of value) {
    if (character < '0' || character > '9') return false;
  }
  return true;
}
function validImfDate(weekday, day, month, year) {
  return (
    IMF_WEEKDAYS.has(weekday) &&
    fixedDigits(day, 2) &&
    IMF_MONTHS.has(month) &&
    fixedDigits(year, 4)
  );
}
function validImfTime(value) {
  const parts = value.split(':');
  return parts.length === 3 && parts.every((part) => fixedDigits(part, 2));
}
function isImfFixdate(value) {
  const parts = value.split(' ');
  if (parts.length !== 6) return false;
  const [weekday = '', day = '', month = '', year = '', time = '', zone = ''] = parts;
  return validImfDate(weekday, day, month, year) && validImfTime(time) && zone === 'GMT';
}
class DefaultRetryPolicy {
  shouldRetry(attempt, elapsed, error) {
    if (error instanceof errors_js_1.TargetAuthError) return { retry: false, delayMs: 0 };
    if (!error.retryable) return { retry: false, delayMs: 0 };
    if (attempt >= bounds_js_1.MAX_RETRY_ATTEMPTS) return { retry: false, delayMs: 0 };
    if (elapsed >= bounds_js_1.MAX_RETRY_ELAPSED_MS) return { retry: false, delayMs: 0 };
    const requestedDelay =
      (error instanceof errors_js_1.TargetRateLimitError ||
        error instanceof errors_js_1.TargetServerError) &&
      error.retryAfterMs !== undefined
        ? Math.max(0, error.retryAfterMs)
        : Math.min(1000 * Math.pow(2, attempt), 10_000);
    const remaining = bounds_js_1.MAX_RETRY_ELAPSED_MS - elapsed;
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
  if (/^\d+$/.test(trimmed)) {
    const delayMs = Number(trimmed) * 1000;
    return Number.isSafeInteger(delayMs) ? delayMs : null;
  }
  if (!isImfFixdate(trimmed)) {
    return null;
  }
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date) || new Date(date).toUTCString() !== trimmed) return null;
  const delayMs = date - clock.now();
  return delayMs > 0 ? delayMs : 0;
}
