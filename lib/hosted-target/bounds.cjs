'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.IDEMPOTENCY_KEY_PATTERN =
  exports.MAX_ERROR_BODY_BYTES =
  exports.MAX_RETRY_ELAPSED_MS =
  exports.MAX_RETRY_ATTEMPTS =
  exports.MAX_PAGINATION_PAGES =
  exports.MAX_RESPONSE_BYTES =
    void 0;
exports.MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
exports.MAX_PAGINATION_PAGES = 100;
exports.MAX_RETRY_ATTEMPTS = 3;
exports.MAX_RETRY_ELAPSED_MS = 30_000;
exports.MAX_ERROR_BODY_BYTES = 8192;
exports.IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
