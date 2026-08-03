'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.throwCapsuleServerError = throwCapsuleServerError;
const errors_js_1 = require('./errors.cjs');
const retry_js_1 = require('./retry.cjs');
const ERROR_CODES = Object.freeze({
  unauthorized: { statuses: [401], retryable: false },
  invalid_request: { statuses: [400], retryable: false },
  not_found: { statuses: [404], retryable: false },
  forbidden: { statuses: [402, 403], retryable: false },
  idempotency_conflict: { statuses: [409], retryable: false },
  run_conflict: { statuses: [409], retryable: true },
  rate_limited: { statuses: [429], retryable: true },
  temporarily_unavailable: { statuses: [503], retryable: true },
  internal_error: { statuses: [500], retryable: false },
});
function isErrorCode(value) {
  return typeof value === 'string' && value in ERROR_CODES;
}
function isRecordBody(body) {
  return body !== null && typeof body === 'object' && !Array.isArray(body);
}
function hasExactErrorFields(value) {
  const fields = Object.keys(value);
  const exactFields = ['code', 'message', 'capsule_id', 'retryable'];
  return fields.length === exactFields.length && exactFields.every((field) => field in value);
}
function hasValidErrorValues(value) {
  return (
    isErrorCode(value.code) &&
    typeof value.message === 'string' &&
    (value.capsule_id === null || typeof value.capsule_id === 'string') &&
    typeof value.retryable === 'boolean'
  );
}
function parseErrorBody(body) {
  if (!isRecordBody(body) || !hasExactErrorFields(body) || !hasValidErrorValues(body)) {
    throw new errors_js_1.TargetProtocolError('Capsule error response is malformed');
  }
  const value = body;
  return {
    code: value.code,
    capsuleId: value.capsule_id,
    retryable: value.retryable,
  };
}
function validateChallenge(response) {
  if (response.status !== 401) return;
  if (response.headers.get('WWW-Authenticate') !== 'Bearer error="invalid_token"') {
    throw new errors_js_1.TargetProtocolError('Capsule authentication challenge is malformed');
  }
}
function validatedRetryAfter(response, retryable, clock) {
  const header = response.headers.get('Retry-After');
  const retryAfter = (0, retry_js_1.parseRetryAfter)(header, clock) ?? undefined;
  if (header !== null && retryAfter === undefined) {
    throw new errors_js_1.TargetProtocolError('Capsule Retry-After header is malformed');
  }
  if (retryable && retryAfter === undefined) {
    throw new errors_js_1.TargetProtocolError('Retryable capsule error omitted Retry-After');
  }
  if (!retryable && retryAfter !== undefined) {
    throw new errors_js_1.TargetProtocolError('Permanent capsule error advertised Retry-After');
  }
  return retryAfter;
}
async function throwCapsuleServerError(response, readJson, clock) {
  const value = parseErrorBody(await readJson(response));
  const contract = ERROR_CODES[value.code];
  if (!contract.statuses.includes(response.status) || contract.retryable !== value.retryable) {
    throw new errors_js_1.TargetProtocolError(
      'Capsule error response contradicts its status contract'
    );
  }
  validateChallenge(response);
  const retryAfter = validatedRetryAfter(response, contract.retryable, clock);
  throw new errors_js_1.TargetServerError(
    response.status,
    value.code,
    contract.retryable,
    value.capsuleId,
    retryAfter
  );
}
