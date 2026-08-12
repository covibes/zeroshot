import crypto = require('node:crypto');

/**
 * Rate-limit-aware backoff for API retries
 *
 * Rate limit errors (429, capacity exhausted, quota exceeded) need LONGER delays
 * than transient errors (timeouts, network issues).
 *
 * - Regular errors: 2s base, exponential backoff up to 30s
 * - Rate limits: 30s base, exponential backoff up to 5 minutes
 * - Retry-After header: Honored if present (capped at 5 min)
 */

type RateLimitError = Error | string | null | undefined;

interface BackoffSettings {
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  jitterFactor?: number;
}

function sampleJitter(): number {
  const range = 0x1_0000_0000;
  return crypto.randomInt(range) / range;
}

/** Check if an error represents a rate limit. */
function isRateLimitError(error: RateLimitError): boolean {
  const msg = error instanceof Error ? error.message || String(error) : String(error);
  return /\b429\b|rate.?limit|too many requests|no capacity|quota.?exceeded|resource.?exhausted/i.test(
    msg
  );
}

/** Parse a Retry-After delay in seconds from an error message. */
function parseRetryAfter(error: Error | null | undefined): number | null {
  const msg = error?.message || '';
  const match = /retry.?after[:\s]+(\d+)/i.exec(msg);
  const retryAfterSeconds = match?.[1];
  return retryAfterSeconds ? parseInt(retryAfterSeconds, 10) : null;
}

/** Calculate a retry delay with rate-limit awareness. */
function calculateRateLimitDelay(
  error: Error,
  attempt: number,
  settings: BackoffSettings = {}
): number {
  const baseDelay = settings.backoffBaseMs ?? 2000;
  const maxDelay = settings.backoffMaxMs ?? 30000;
  const jitter = settings.jitterFactor ?? 0.2;

  const retryAfter = parseRetryAfter(error);
  if (retryAfter) {
    return Math.min(retryAfter * 1000, 300000);
  }

  const isRateLimit = isRateLimitError(error);
  const effectiveBase = isRateLimit ? 30000 : baseDelay;
  let delay = effectiveBase * Math.pow(2, attempt - 1);
  delay = Math.min(delay, isRateLimit ? 300000 : maxDelay);

  const jitterAmount = delay * jitter * (sampleJitter() * 2 - 1);
  return Math.round(delay + jitterAmount);
}

export = {
  calculateRateLimitDelay,
  isRateLimitError,
  parseRetryAfter,
};
