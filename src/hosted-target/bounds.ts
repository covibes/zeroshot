/** Shared wire limits for every hosted-target response and retry path. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_PAGINATION_PAGES = 100;
export const MAX_RETRY_ATTEMPTS = 3;
export const MAX_RETRY_ELAPSED_MS = 30_000;
export const MAX_ERROR_BODY_BYTES = 8192;
export const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
