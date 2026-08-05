'use strict';

const { TextDecoder } = require('node:util');

const RUN_INTENT_VERSION = 'zeroshot.run-intent/v2';
const MAX_RUN_INTENT_REQUEST_BYTES = 10 * 1024 * 1024 + 64 * 1024;
const MAX_RUN_INTENT_RESPONSE_BYTES = 11 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const RUN_INTENT_STATES = new Set([
  'queued',
  'provisioning',
  'running',
  'cancelling',
  ...TERMINAL_STATES,
]);
const WAITING_REASONS = new Set([
  'weekly_quota_exhausted',
  'plan_concurrency_limit_reached',
  'technical_concurrency_limit_reached',
  'prepaid_credits_required',
  'billing_state_stale',
  'subscription_payment_failed',
  'billing_configuration_error',
]);
const RUN_INTENT_STATE_RULES = Object.freeze({
  queued: { null: ['result', 'error_code', 'terminal_at'], required: [] },
  provisioning: {
    null: ['waiting_reason', 'result', 'error_code', 'terminal_at'],
    required: ['capsule_id'],
  },
  running: {
    null: ['waiting_reason', 'result', 'error_code', 'terminal_at'],
    required: ['capsule_id'],
  },
  cancelling: {
    null: ['waiting_reason', 'result', 'error_code', 'terminal_at'],
    required: ['capsule_id'],
  },
  succeeded: {
    null: ['waiting_reason', 'error_code'],
    required: ['capsule_id', 'terminal_at'],
  },
  failed: {
    null: ['waiting_reason', 'result'],
    required: ['error_code', 'terminal_at'],
  },
  cancelled: {
    null: ['waiting_reason', 'result', 'error_code'],
    required: ['terminal_at'],
  },
  expired: {
    null: ['waiting_reason', 'result', 'error_code'],
    required: ['terminal_at'],
  },
});
const RUN_INTENT_KEYS = Object.freeze([
  'capsule_id',
  'error_code',
  'intent_id',
  'result',
  'state',
  'submitted_at',
  'terminal_at',
  'updated_at',
  'waiting_reason',
]);
const FORBIDDEN_INPUT_KEYS = new Set([
  'apikey',
  'authority',
  'command',
  'commands',
  'credential',
  'credentials',
  'cwd',
  'endpoint',
  'environment',
  'isolationprofile',
  'modellevel',
  'path',
  'paths',
  'provider',
  'providerendpoint',
  'providerprofile',
  'providersettings',
  'refreshtoken',
  'repository',
  'revision',
  'runtime',
  'settings',
  'token',
  'tokens',
  'accesstoken',
]);

class RunIntentRequestError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'RunIntentRequestError';
  }
}

class RunIntentProtocolError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'RunIntentProtocolError';
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function assertUuid(value, label) {
  if (!isUuid(value)) throw new RunIntentRequestError(`${label} must be a canonical UUID`);
  return value;
}

function isDateTime(value) {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    value.includes('T') &&
    value.endsWith('Z') &&
    Number.isFinite(Date.parse(value))
  );
}

function invalidRunIntent() {
  return new RunIntentProtocolError('target returned an invalid RunIntent response');
}

function hasExactRunIntentKeys(value) {
  const keys = Object.keys(value).sort();
  return (
    keys.length === RUN_INTENT_KEYS.length &&
    keys.every((key, index) => key === RUN_INTENT_KEYS[index])
  );
}

function isNullable(value, predicate) {
  return value === null || predicate(value);
}

function hasRunIntentStateShape(value) {
  const rule = RUN_INTENT_STATE_RULES[value.state];
  if (rule === undefined) return false;
  return (
    rule.null.every((field) => value[field] === null) &&
    rule.required.every((field) => value[field] !== null)
  );
}

function validateRunIntent(value) {
  if (!isPlainObject(value) || !hasExactRunIntentKeys(value)) throw invalidRunIntent();
  const validFields = [
    isUuid(value.intent_id),
    RUN_INTENT_STATES.has(value.state),
    isNullable(value.waiting_reason, (reason) => WAITING_REASONS.has(reason)),
    isNullable(value.capsule_id, isUuid),
    isNullable(value.result, isPlainObject),
    isNullable(
      value.error_code,
      (code) => typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code)
    ),
    isDateTime(value.submitted_at),
    isDateTime(value.updated_at),
    isNullable(value.terminal_at, isDateTime),
    hasRunIntentStateShape(value),
  ];
  if (!validFields.every(Boolean)) throw invalidRunIntent();
  return value;
}

function nestedObjects(value) {
  const children = [];
  for (const child of Object.values(value)) {
    if (isPlainObject(child)) children.push(child);
    if (Array.isArray(child)) children.push(...child.filter(isPlainObject));
  }
  return children;
}

function assertCredentialFreeInput(input) {
  if (!isPlainObject(input)) throw new RunIntentRequestError('RunIntent input must be an object');
  const pending = [input];
  while (pending.length > 0) {
    const value = pending.pop();
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_INPUT_KEYS.has(key.replaceAll(/[-_]/g, '').toLowerCase())) {
        throw new RunIntentRequestError(`RunIntent input contains forbidden field ${key}`);
      }
    }
    pending.push(...nestedObjects(value));
  }
}

function buildRunIntentEnvelope(graph, input) {
  if (!isPlainObject(graph)) throw new RunIntentRequestError('RunIntent graph must be an object');
  assertCredentialFreeInput(input);
  return Object.freeze({ version: RUN_INTENT_VERSION, graph, input });
}

function encodeBoundedJson(value) {
  let body;
  try {
    body = JSON.stringify(value);
  } catch (error) {
    throw new RunIntentRequestError('RunIntent request is not serializable', { cause: error });
  }
  if (Buffer.byteLength(body) > MAX_RUN_INTENT_REQUEST_BYTES) {
    throw new RunIntentRequestError('RunIntent request exceeds the upload size bound');
  }
  return body;
}

async function discard(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already rejected; draining is best-effort cleanup only.
  }
}

async function readBoundedJson(response) {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    if (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_RUN_INTENT_RESPONSE_BYTES) {
      await discard(response);
      throw new RunIntentProtocolError('RunIntent response exceeds the download size bound');
    }
  }
  if (response.body === null) throw new RunIntentProtocolError('RunIntent response body is empty');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RUN_INTENT_RESPONSE_BYTES) {
        await reader.cancel();
        throw new RunIntentProtocolError('RunIntent response exceeds the download size bound');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (length === 0) throw new RunIntentProtocolError('RunIntent response body is empty');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length));
    return JSON.parse(text);
  } catch (error) {
    throw new RunIntentProtocolError('RunIntent response is not valid UTF-8 JSON', {
      cause: error,
    });
  }
}

module.exports = {
  MAX_RUN_INTENT_REQUEST_BYTES,
  MAX_RUN_INTENT_RESPONSE_BYTES,
  RUN_INTENT_VERSION,
  RunIntentProtocolError,
  RunIntentRequestError,
  TERMINAL_STATES,
  assertUuid,
  buildRunIntentEnvelope,
  discard,
  encodeBoundedJson,
  isUuid,
  readBoundedJson,
  validateRunIntent,
};
