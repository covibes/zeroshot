const assert = require('assert');
const crypto = require('node:crypto');
const {
  calculateRateLimitDelay,
  isRateLimitError,
  parseRetryAfter,
} = require('../../src/agent/rate-limit-backoff');

describe('rate-limit-backoff', () => {
  describe('isRateLimitError', () => {
    it('detects HTTP 429 errors', () => {
      assert.strictEqual(isRateLimitError(new Error('HTTP 429: Rate limit exceeded')), true);
      assert.strictEqual(isRateLimitError(new Error('Error 429 - Too many requests')), true);
    });

    it('detects "rate limit" text', () => {
      assert.strictEqual(isRateLimitError(new Error('Rate limit exceeded')), true);
      assert.strictEqual(isRateLimitError(new Error('rate-limit error')), true);
    });

    it('detects Gemini "No capacity available" errors', () => {
      assert.strictEqual(
        isRateLimitError(new Error('No capacity available for model gemini-3-pro')),
        true
      );
    });

    it('detects quota exceeded errors', () => {
      assert.strictEqual(isRateLimitError(new Error('Quota exceeded for this project')), true);
    });

    it('detects resource exhausted errors', () => {
      assert.strictEqual(isRateLimitError(new Error('RESOURCE_EXHAUSTED: No capacity')), true);
    });

    it('returns false for non-rate-limit errors', () => {
      assert.strictEqual(isRateLimitError(new Error('Network timeout')), false);
      assert.strictEqual(isRateLimitError(new Error('No messages returned')), false);
      assert.strictEqual(isRateLimitError(new Error('SIGTERM')), false);
    });

    it('handles null/undefined', () => {
      assert.strictEqual(isRateLimitError(null), false);
      assert.strictEqual(isRateLimitError(undefined), false);
    });
  });

  describe('parseRetryAfter', () => {
    it('parses "Retry-After: N" header format', () => {
      assert.strictEqual(parseRetryAfter(new Error('Rate limit. Retry-After: 120')), 120);
      assert.strictEqual(parseRetryAfter(new Error('Retry-After:60')), 60);
    });

    it('returns null when not found', () => {
      assert.strictEqual(parseRetryAfter(new Error('Rate limit exceeded')), null);
      assert.strictEqual(parseRetryAfter(null), null);
    });
  });

  describe('calculateRateLimitDelay', () => {
    let originalRandomInt;
    beforeEach(() => {
      originalRandomInt = crypto.randomInt;
      crypto.randomInt = () => 0x80000000; // Neutralizes jitter
    });
    afterEach(() => {
      crypto.randomInt = originalRandomInt;
    });

    it('uses 30s base for rate limit errors', () => {
      const error = new Error('HTTP 429: Rate limit');
      const delay = calculateRateLimitDelay(error, 1, {});
      assert.strictEqual(delay, 30000);
    });

    it('uses exponential backoff for rate limit errors', () => {
      const error = new Error('HTTP 429: Rate limit');
      assert.strictEqual(calculateRateLimitDelay(error, 1, {}), 30000);
      assert.strictEqual(calculateRateLimitDelay(error, 2, {}), 60000);
      assert.strictEqual(calculateRateLimitDelay(error, 3, {}), 120000);
    });

    it('caps rate limit delays at 5 minutes', () => {
      const error = new Error('HTTP 429: Rate limit');
      assert.strictEqual(calculateRateLimitDelay(error, 5, {}), 300000);
    });

    it('uses 2s base for non-rate-limit errors', () => {
      const error = new Error('No messages returned');
      const delay = calculateRateLimitDelay(error, 1, {});
      assert.strictEqual(delay, 2000);
    });

    it('honors Retry-After header', () => {
      const error = new Error('Rate limit. Retry-After: 120');
      assert.strictEqual(calculateRateLimitDelay(error, 1, {}), 120000);
    });

    it('caps Retry-After at 5 minutes', () => {
      const error = new Error('Rate limit. Retry-After: 600');
      assert.strictEqual(calculateRateLimitDelay(error, 1, {}), 300000);
    });
  });
});
