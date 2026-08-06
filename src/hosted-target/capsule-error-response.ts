import { TargetProtocolError, TargetServerError } from './errors.js';
import { parseRetryAfter } from './retry.js';
import type { Clock } from './types.js';

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
type ErrorCode = keyof typeof ERROR_CODES;

type CapsuleErrorBody = {
  readonly code: ErrorCode;
  readonly capsuleId: string | null;
  readonly retryable: boolean;
};

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && value in ERROR_CODES;
}

function isRecordBody(body: unknown): body is Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body);
}

function hasExactErrorFields(value: Record<string, unknown>): boolean {
  const fields = Object.keys(value);
  const exactFields = ['code', 'message', 'capsule_id', 'retryable'];
  return fields.length === exactFields.length &&
    exactFields.every((field) => field in value);
}

function hasValidErrorValues(value: Record<string, unknown>): value is Record<string, unknown> & {
  readonly code: ErrorCode;
  readonly capsule_id: string | null;
  readonly retryable: boolean;
} {
  return isErrorCode(value.code) &&
    typeof value.message === 'string' &&
    (value.capsule_id === null || typeof value.capsule_id === 'string') &&
    typeof value.retryable === 'boolean';
}

function parseErrorBody(body: unknown): CapsuleErrorBody {
  if (!isRecordBody(body) || !hasExactErrorFields(body) || !hasValidErrorValues(body)) {
    throw new TargetProtocolError('Capsule error response is malformed');
  }
  const value = body;
  return {
    code: value.code,
    capsuleId: value.capsule_id,
    retryable: value.retryable,
  };
}

function validateChallenge(response: Response): void {
  if (response.status !== 401) return;
  if (response.headers.get('WWW-Authenticate') !== 'Bearer error="invalid_token"') {
    throw new TargetProtocolError('Capsule authentication challenge is malformed');
  }
}

function validatedRetryAfter(
  response: Response,
  retryable: boolean,
  clock: Clock,
): number | undefined {
  const header = response.headers.get('Retry-After');
  const retryAfter = parseRetryAfter(header, clock) ?? undefined;
  if (header !== null && retryAfter === undefined) {
    throw new TargetProtocolError('Capsule Retry-After header is malformed');
  }
  if (retryable && retryAfter === undefined) {
    throw new TargetProtocolError('Retryable capsule error omitted Retry-After');
  }
  if (!retryable && retryAfter !== undefined) {
    throw new TargetProtocolError('Permanent capsule error advertised Retry-After');
  }
  return retryAfter;
}

export async function throwCapsuleServerError(
  response: Response,
  readJson: (response: Response) => Promise<unknown>,
  clock: Clock,
): Promise<never> {
  const value = parseErrorBody(await readJson(response));
  const contract = ERROR_CODES[value.code];
  if (!contract.statuses.includes(response.status) || contract.retryable !== value.retryable) {
    throw new TargetProtocolError('Capsule error response contradicts its status contract');
  }
  validateChallenge(response);
  const retryAfter = validatedRetryAfter(response, contract.retryable, clock);
  throw new TargetServerError(
    response.status,
    value.code,
    contract.retryable,
    value.capsuleId,
    retryAfter,
  );
}
