import { MAX_RETRY_ATTEMPTS, MAX_RETRY_ELAPSED_MS } from './bounds.ts';
import type { TargetAdapterError } from './errors.ts';
import { TargetAuthError, TargetRateLimitError } from './errors.ts';
import type { Clock, RetryPolicy } from './types.ts';

export class DefaultRetryPolicy implements RetryPolicy {
  shouldRetry(
    attempt: number,
    elapsed: number,
    error: TargetAdapterError,
  ): { retry: boolean; delayMs: number } {
    if (error instanceof TargetAuthError) return { retry: false, delayMs: 0 };
    if (!error.retryable) return { retry: false, delayMs: 0 };
    if (attempt >= MAX_RETRY_ATTEMPTS) return { retry: false, delayMs: 0 };
    if (elapsed >= MAX_RETRY_ELAPSED_MS) return { retry: false, delayMs: 0 };

    if (error instanceof TargetRateLimitError && error.retryAfterMs !== undefined) {
      return { retry: true, delayMs: error.retryAfterMs };
    }

    const baseDelay = 1000 * Math.pow(2, attempt);
    return { retry: true, delayMs: Math.min(baseDelay, 10_000) };
  }
}

export function parseRetryAfter(header: string | null, clock: Clock): number | null {
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
