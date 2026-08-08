'use strict';

const { URL } = require('node:url');
const {
  MAX_RUN_INTENT_BYTES,
  MAX_RUN_INTENT_DISPATCH_BYTES,
  MAX_RUNTIME_BUNDLE_BYTES,
  RunIntentProtocolError,
  RunIntentRequestError,
  assertUuid,
  discard,
  encodeBoundedJson,
  readBoundedJson,
  validateRunIntent,
} = require('./run-intent-schema');

const REQUEST_TIMEOUT_MS = 15_000;
const DISPATCH_FRAME_BYTES = 4;

function serializeOpaqueJson(value, maximum, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new RunIntentRequestError(`RunIntent ${label} is not serializable`, { cause: error });
  }
  if (serialized === undefined) {
    throw new RunIntentRequestError(`RunIntent ${label} is not serializable`);
  }
  const bytes = Buffer.from(serialized, 'utf8');
  if (bytes.byteLength > maximum) {
    throw new RunIntentRequestError(`RunIntent ${label} exceeds the decoded size bound`);
  }
  return bytes;
}

class RunIntentHttpError extends Error {
  constructor(status) {
    super(`RunIntent request failed with HTTP ${status}`);
    this.name = 'RunIntentHttpError';
    this.status = status;
  }
}

class RunIntentTransportError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'RunIntentTransportError';
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
    descriptor?.kind !== 'zeroshot.run-intent/v2' ||
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

  submit({ envelope, runtime, submissionKey, size, signal }) {
    assertUuid(submissionKey, 'submission key');
    if (size !== undefined && !['tiny', 'small', 'standard', 'large'].includes(size)) {
      throw new RunIntentRequestError('RunIntent size is invalid');
    }
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
      throw new RunIntentRequestError('RunIntent runtime bundle must be an object');
    }
    const intentBytes = serializeOpaqueJson(envelope, MAX_RUN_INTENT_BYTES, 'intent');
    const runtimeBytes = serializeOpaqueJson(runtime, MAX_RUNTIME_BUNDLE_BYTES, 'runtime bundle');
    if (
      intentBytes.byteLength + runtimeBytes.byteLength + DISPATCH_FRAME_BYTES >
      MAX_RUN_INTENT_DISPATCH_BYTES
    ) {
      throw new RunIntentRequestError('RunIntent payloads exceed the decoded dispatch size bound');
    }
    const body = encodeBoundedJson({
      label: 'zeroshot-cli',
      ...(size === undefined ? {} : { size }),
      intent: intentBytes.toString('base64url'),
      runtime: runtimeBytes.toString('base64url'),
    });
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
      expectedIntentId: intentId,
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
      expectedIntentId: intentId,
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
      const intent = validateRunIntent(await readBoundedJson(response));
      if (options.expectedIntentId !== undefined && intent.intent_id !== options.expectedIntentId) {
        throw new RunIntentProtocolError('RunIntent response identity does not match the request');
      }
      return { intent };
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

module.exports = {
  RunIntentClient,
  RunIntentHttpError,
  RunIntentTransportError,
};
