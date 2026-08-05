'use strict';

const { TextDecoder } = require('node:util');
const { URL } = require('node:url');

const RUN_INTENT_VERSION = 'zeroshot.run-intent/v2';
const MAX_RUN_INTENT_REQUEST_BYTES = 10 * 1024 * 1024 + 64 * 1024;
const MAX_RUN_INTENT_RESPONSE_BYTES = 11 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const RUN_INTENT_POLL_MS = 500;
const MAX_TRANSIENT_POLL_FAILURES = 3;
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

class RunIntentHttpError extends Error {
  constructor(status) {
    super(`RunIntent request failed with HTTP ${status}`);
    this.name = 'RunIntentHttpError';
    this.status = status;
  }
}

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

class RunIntentTransportError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'RunIntentTransportError';
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
  if (!isPlainObject(value) || !hasExactRunIntentKeys(value)) {
    throw invalidRunIntent();
  }
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

function assertNoForbiddenInputKeys(value) {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_INPUT_KEYS.has(key.replaceAll(/[-_]/g, '').toLowerCase())) {
      throw new RunIntentRequestError(`RunIntent input contains forbidden field ${key}`);
    }
  }
}

function assertCredentialFreeInput(input) {
  if (!isPlainObject(input)) throw new RunIntentRequestError('RunIntent input must be an object');
  const pending = [input];
  while (pending.length > 0) {
    const value = pending.pop();
    assertNoForbiddenInputKeys(value);
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
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length));
    return JSON.parse(text);
  } catch (error) {
    throw new RunIntentProtocolError('RunIntent response is not valid UTF-8 JSON', {
      cause: error,
    });
  }
}

function boundedSignal(parent) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(parent.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new globalThis.DOMException('RunIntent request timed out', 'TimeoutError'));
  }, REQUEST_TIMEOUT_MS);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    close() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

function validatedRunIntentTarget(descriptor) {
  if (
    descriptor?.kind !== RUN_INTENT_VERSION ||
    !['submit', 'status', 'cancel'].every(
      (name) => typeof descriptor.routes?.[name]?.expand === 'function'
    )
  ) {
    throw new RunIntentRequestError('RunIntent discovery descriptor is invalid');
  }
  const endpoint = new URL(descriptor.baseUrl);
  const secure = endpoint.protocol === 'https:';
  const loopback =
    endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(endpoint.hostname);
  const canonical =
    endpoint.username === '' &&
    endpoint.password === '' &&
    endpoint.search === '' &&
    endpoint.hash === '';
  if ((!secure && !loopback) || !canonical) {
    throw new RunIntentRequestError('RunIntent target must use HTTPS');
  }
  return { endpoint, routes: descriptor.routes };
}

function validateTransportDependencies(options) {
  if (typeof options.tokenProvider?.getAccessToken !== 'function') {
    throw new TypeError('RunIntent token provider is required');
  }
  if (typeof options.clearAccess !== 'function' || typeof options.fetch !== 'function') {
    throw new TypeError('RunIntent transport dependencies are required');
  }
}

function requestInit(options, accessToken, signal) {
  return {
    method: options.method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.submissionKey === undefined ? {} : { 'idempotency-key': options.submissionKey }),
    },
    redirect: 'error',
    cache: 'no-store',
    ...(options.body === undefined ? {} : { body: options.body }),
    signal,
  };
}

function isKnownRequestError(error) {
  return (
    error instanceof RunIntentHttpError ||
    error instanceof RunIntentProtocolError ||
    error instanceof RunIntentRequestError
  );
}

class RunIntentClient {
  #baseUrl;
  #routes;
  #organizationId;
  #tokenProvider;
  #clearAccess;
  #fetch;

  constructor(options) {
    const target = validatedRunIntentTarget(options.descriptor);
    validateTransportDependencies(options);
    this.#baseUrl = target.endpoint;
    this.#routes = target.routes;
    this.#organizationId = assertUuid(options.organizationId, 'target organization');
    this.#tokenProvider = options.tokenProvider;
    this.#clearAccess = options.clearAccess;
    this.#fetch = options.fetch;
  }

  submit({ envelope, submissionKey, size = 'standard', signal }) {
    assertUuid(submissionKey, 'submission key');
    if (!['tiny', 'small', 'standard', 'large'].includes(size)) {
      throw new RunIntentRequestError('RunIntent size is invalid');
    }
    const body = encodeBoundedJson({ label: 'zeroshot-cli', size, intent: envelope });
    return this.#request({
      route: this.#routes.submit,
      routeValues: { org_id: this.#organizationId },
      method: 'POST',
      body,
      submissionKey,
      expectedStatus: 202,
      signal,
    });
  }

  get(intentId, options = {}) {
    assertUuid(intentId, 'RunIntent id');
    return this.#request({
      route: this.#routes.status,
      routeValues: { org_id: this.#organizationId, intent_id: intentId },
      method: 'GET',
      expectedStatus: 200,
      signal: options.signal,
    });
  }

  cancel(intentId, options = {}) {
    assertUuid(intentId, 'RunIntent id');
    return this.#request({
      route: this.#routes.cancel,
      routeValues: { org_id: this.#organizationId, intent_id: intentId },
      method: 'DELETE',
      expectedStatus: 202,
      signal: options.signal,
    });
  }

  async #request(options) {
    const route = options.route.expand(options.routeValues);
    const path = `${this.#baseUrl.pathname.replace(/\/$/, '')}${route}`;
    const url = new URL(path, this.#baseUrl.origin);
    if (
      url.origin !== this.#baseUrl.origin ||
      url.search !== '' ||
      url.hash !== '' ||
      url.pathname !== path
    ) {
      throw new RunIntentRequestError('RunIntent discovery route is invalid');
    }
    let refreshed = false;
    for (;;) {
      const accessToken = await this.#tokenProvider.getAccessToken(options.signal);
      const result = await this.#send(url.href, options, accessToken);
      if (result.authorizationStatus === undefined) return result.intent;
      if (refreshed) throw new RunIntentHttpError(result.authorizationStatus);
      await this.#clearAccess();
      refreshed = true;
    }
  }

  async #send(url, options, accessToken) {
    const bounded = boundedSignal(options.signal);
    try {
      const response = await this.#fetch(url, requestInit(options, accessToken, bounded.signal));
      if (response.status === 401) {
        await discard(response);
        return { authorizationStatus: response.status };
      }
      if (response.status !== options.expectedStatus) {
        await discard(response);
        throw new RunIntentHttpError(response.status);
      }
      return { intent: validateRunIntent(await readBoundedJson(response)) };
    } catch (error) {
      if (isKnownRequestError(error)) throw error;
      if (options.signal?.aborted) throw options.signal.reason;
      throw new RunIntentTransportError(
        bounded.timedOut() ? 'RunIntent request timed out' : 'RunIntent target is unreachable',
        { cause: error }
      );
    } finally {
      bounded.close();
    }
  }
}

function abortReason(signal) {
  return (
    signal?.reason ?? new globalThis.DOMException('RunIntent observation interrupted', 'AbortError')
  );
}

function delay(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(abortReason(signal));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function transientRetryDelay(error, failures) {
  const retryable =
    error instanceof RunIntentTransportError ||
    (error instanceof RunIntentHttpError && (error.status === 429 || error.status >= 500));
  if (!retryable || failures >= MAX_TRANSIENT_POLL_FAILURES) return null;
  return RUN_INTENT_POLL_MS * 2 ** (failures + 1);
}

async function followRunIntent(client, initial, options = {}) {
  const pause = options.sleep ?? delay;
  let intent = validateRunIntent(initial);
  let displayed;
  let transientFailures = 0;
  for (;;) {
    const state = `${intent.state}:${intent.waiting_reason ?? ''}`;
    if (state !== displayed) {
      options.onChange?.(intent);
      displayed = state;
    }
    if (TERMINAL_STATES.has(intent.state)) return intent;
    await pause(RUN_INTENT_POLL_MS, options.signal);
    try {
      intent = await client.get(intent.intent_id, { signal: options.signal });
      transientFailures = 0;
    } catch (error) {
      const retryDelay = transientRetryDelay(error, transientFailures);
      if (retryDelay === null) throw error;
      transientFailures += 1;
      await pause(retryDelay, options.signal);
    }
  }
}

function displayRunIntentState(intent) {
  return intent.waiting_reason ? `${intent.state} (${intent.waiting_reason})` : intent.state;
}

module.exports = {
  MAX_RUN_INTENT_REQUEST_BYTES,
  MAX_RUN_INTENT_RESPONSE_BYTES,
  MAX_TRANSIENT_POLL_FAILURES,
  RUN_INTENT_VERSION,
  RunIntentClient,
  RunIntentHttpError,
  RunIntentProtocolError,
  RunIntentRequestError,
  RunIntentTransportError,
  assertUuid,
  buildRunIntentEnvelope,
  displayRunIntentState,
  followRunIntent,
  isUuid,
  validateRunIntent,
};
