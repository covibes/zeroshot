'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.ZeroCloudV1TargetAdapter = void 0;
const bounds_ts_1 = require('./bounds.cjs');
const errors_ts_1 = require('./errors.cjs');
const retry_ts_1 = require('./retry.cjs');
const response_validation_ts_1 = require('./response-validation.cjs');
const DEFAULT_TRANSPORT = {
  fetch(url, init) {
    return globalThis.fetch(url, init);
  },
};
const DEFAULT_CLOCK = { now: () => Date.now() };
const ERROR_CODES = Object.freeze({
  unauthorized: { status: 401, retryable: false },
  invalid_request: { status: 400, retryable: false },
  not_found: { status: 404, retryable: false },
  forbidden: { status: 403, retryable: false },
  idempotency_conflict: { status: 409, retryable: false },
  run_conflict: { status: 409, retryable: true },
  rate_limited: { status: 429, retryable: true },
  temporarily_unavailable: { status: 503, retryable: true },
  internal_error: { status: 500, retryable: false },
});
function throwIfAborted(signal) {
  if (signal?.aborted)
    throw signal.reason ?? new globalThis.DOMException('The operation was aborted', 'AbortError');
}
function validOpaque(value, field) {
  if (value.length === 0 || value.length > 1024)
    throw new errors_ts_1.TargetProtocolError(`${field} is invalid`);
}
async function wait(delayMs, signal) {
  throwIfAborted(signal);
  if (delayMs <= 0) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(
          signal.reason ?? new globalThis.DOMException('The operation was aborted', 'AbortError')
        );
      },
      { once: true }
    );
  });
}
function jsonRequest(body) {
  return JSON.stringify(body);
}
class ZeroCloudV1TargetAdapter {
  #descriptor;
  #organizationId;
  #tokenProvider;
  #transport;
  #clock;
  #retryPolicy;
  constructor(options) {
    this.#descriptor = options.descriptor;
    this.#organizationId = options.organization.id;
    validOpaque(this.#organizationId, 'organization id');
    this.#tokenProvider = options.tokenProvider;
    this.#transport = options.transport ?? DEFAULT_TRANSPORT;
    this.#clock = options.clock ?? DEFAULT_CLOCK;
    this.#retryPolicy = options.retryPolicy ?? new retry_ts_1.DefaultRetryPolicy();
  }
  get credentialInstall() {
    const descriptor = this.#descriptor.credentialInstall;
    return descriptor === null
      ? Object.freeze({ supported: false })
      : Object.freeze({ supported: true, descriptor });
  }
  allocate(request, signal) {
    try {
      if (!bounds_ts_1.IDEMPOTENCY_KEY_PATTERN.test(request.idempotencyKey))
        throw new errors_ts_1.TargetProtocolError('Idempotency key is invalid');
      if (request.label !== undefined && (request.label.length < 1 || request.label.length > 100)) {
        throw new errors_ts_1.TargetProtocolError('Capsule label is outside the supported bounds');
      }
      if (request.size !== undefined && !this.#descriptor.sizes.catalog.includes(request.size)) {
        throw new errors_ts_1.TargetProtocolError('Capsule size is not advertised by the target');
      }
      const body = {
        ...(request.label === undefined ? {} : { label: request.label }),
        ...(request.size === undefined ? {} : { size: request.size }),
      };
      return this.#execute(
        'allocate',
        'POST',
        this.#descriptor.capsule.routes.allocate,
        { org_id: this.#organizationId },
        201,
        response_validation_ts_1.assertCapsule,
        signal,
        {
          body: jsonRequest(body),
          headers: { 'Idempotency-Key': request.idempotencyKey },
        }
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }
  async list(request = {}, signal) {
    if (request.cursor !== undefined) validOpaque(request.cursor, 'cursor');
    if (
      request.limit !== undefined &&
      (!Number.isSafeInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > this.#descriptor.pagination.maxPageSize)
    ) {
      throw new errors_ts_1.TargetProtocolError(
        'Pagination limit is outside the advertised bounds'
      );
    }
    const page = await this.#execute(
      'list',
      'GET',
      this.#descriptor.capsule.routes.list,
      {
        org_id: this.#organizationId,
        cursor: request.cursor,
        limit: request.limit,
      },
      200,
      response_validation_ts_1.assertCapsuleListPage,
      signal
    );
    if (request.cursor !== undefined && page.nextCursor === request.cursor)
      throw new errors_ts_1.TargetProtocolError('Target returned a pagination loop');
    return page;
  }
  inspect(capsuleId, signal) {
    validOpaque(capsuleId, 'capsule id');
    return this.#execute(
      'inspect',
      'GET',
      this.#descriptor.capsule.routes.inspect,
      { org_id: this.#organizationId, capsule_id: capsuleId },
      200,
      response_validation_ts_1.assertCapsule,
      signal
    );
  }
  terminate(capsuleId, signal) {
    validOpaque(capsuleId, 'capsule id');
    return this.#execute(
      'terminate',
      'DELETE',
      this.#descriptor.capsule.routes.terminate,
      { org_id: this.#organizationId, capsule_id: capsuleId },
      202,
      response_validation_ts_1.assertCapsule,
      signal
    );
  }
  limits(signal) {
    return this.#execute(
      'limits',
      'GET',
      this.#descriptor.capsule.routes.limits,
      { org_id: this.#organizationId },
      200,
      response_validation_ts_1.assertCapsuleLimits,
      signal
    );
  }
  async access(capsuleId, signal) {
    validOpaque(capsuleId, 'capsule id');
    const result = await this.#execute(
      'access',
      'POST',
      this.#descriptor.capsule.routes.access,
      { capsule_id: capsuleId },
      200,
      response_validation_ts_1.assertCapsuleAccess,
      signal,
      {
        body: jsonRequest({ protocol: 'openengine.cluster/v1' }),
      }
    );
    this.#validateAccessUrl(result.websocketUrl, capsuleId);
    return result;
  }
  #execute(operation, method, template, values, expectedStatus, validate, signal, request = {}) {
    const path = template.expand(values);
    return this.#withRetry(
      operation,
      async () => {
        const response = await this.#request(method, path, signal, request);
        if (response.status !== expectedStatus) {
          if (response.status >= 200 && response.status < 300)
            throw new errors_ts_1.TargetProtocolError(
              'Target returned an unexpected success status'
            );
          await this.#throwServerError(response);
        }
        return validate(await this.#readJson(response));
      },
      signal
    );
  }
  async #request(method, path, signal, request) {
    throwIfAborted(signal);
    const url = new globalThis.URL(path, this.#descriptor.capsule.baseUrl);
    if (url.origin !== this.#descriptor.origin)
      throw new errors_ts_1.TargetProtocolError('Capsule route changed target authority');
    let token;
    try {
      token = await this.#tokenProvider.getAccessToken(signal);
    } catch {
      throw new errors_ts_1.TargetAuthError('Target access authorization failed');
    }
    const init = {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...request.headers,
      },
      redirect: 'error',
    };
    if (request.body !== undefined) init.body = request.body;
    if (signal !== undefined) init.signal = signal;
    try {
      const response = await this.#transport.fetch(url.href, init);
      if (response.url && new globalThis.URL(response.url).origin !== this.#descriptor.origin)
        throw new errors_ts_1.TargetProtocolError('Capsule response changed target authority');
      return response;
    } catch (error) {
      if (error instanceof errors_ts_1.TargetAdapterError) throw error;
      throwIfAborted(signal);
      throw new errors_ts_1.TargetTransportError('Capsule transport failed');
    }
  }
  async #throwServerError(response) {
    const body = await this.#readJson(response);
    if (body === null || typeof body !== 'object' || Array.isArray(body))
      throw new errors_ts_1.TargetProtocolError('Capsule error response is malformed');
    const value = body;
    if (
      Object.keys(value).length !== 4 ||
      !('code' in value) ||
      !('message' in value) ||
      !('capsule_id' in value) ||
      !('retryable' in value) ||
      typeof value.code !== 'string' ||
      !(value.code in ERROR_CODES) ||
      typeof value.message !== 'string' ||
      (value.capsule_id !== null && typeof value.capsule_id !== 'string') ||
      typeof value.retryable !== 'boolean'
    ) {
      throw new errors_ts_1.TargetProtocolError('Capsule error response is malformed');
    }
    const code = value.code;
    const contract = ERROR_CODES[code];
    if (contract.status !== response.status || contract.retryable !== value.retryable) {
      throw new errors_ts_1.TargetProtocolError(
        'Capsule error response contradicts its status contract'
      );
    }
    if (
      response.status === 401 &&
      response.headers.get('WWW-Authenticate') !== 'Bearer error="invalid_token"'
    ) {
      throw new errors_ts_1.TargetProtocolError('Capsule authentication challenge is malformed');
    }
    const retryAfterHeader = response.headers.get('Retry-After');
    const retryAfter = (0, retry_ts_1.parseRetryAfter)(retryAfterHeader, this.#clock) ?? undefined;
    if (retryAfterHeader !== null && retryAfter === undefined) {
      throw new errors_ts_1.TargetProtocolError('Capsule Retry-After header is malformed');
    }
    if (!contract.retryable && retryAfter !== undefined)
      throw new errors_ts_1.TargetProtocolError('Permanent capsule error advertised Retry-After');
    throw new errors_ts_1.TargetServerError(
      response.status,
      code,
      contract.retryable,
      value.capsule_id,
      retryAfter
    );
  }
  async #readJson(response) {
    const declared = response.headers.get('content-length');
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > bounds_ts_1.MAX_RESPONSE_BYTES)
    ) {
      throw new errors_ts_1.TargetProtocolError('Capsule response exceeds the size limit');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > bounds_ts_1.MAX_RESPONSE_BYTES)
      throw new errors_ts_1.TargetProtocolError('Capsule response exceeds the size limit');
    try {
      return JSON.parse(new globalThis.TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new errors_ts_1.TargetProtocolError('Capsule response is not valid UTF-8 JSON');
    }
  }
  async #withRetry(operation, effect, signal) {
    const retrySafe = operation !== 'access';
    const started = this.#clock.now();
    let attempt = 0;
    while (true) {
      throwIfAborted(signal);
      try {
        return await effect();
      } catch (error) {
        throwIfAborted(signal);
        if (!retrySafe || !(error instanceof errors_ts_1.TargetAdapterError) || !error.retryable)
          throw error;
        attempt += 1;
        const elapsed = this.#clock.now() - started;
        const decision = this.#retryPolicy.shouldRetry(attempt, elapsed, error);
        const remaining = bounds_ts_1.MAX_RETRY_ELAPSED_MS - elapsed;
        if (
          !decision.retry ||
          !Number.isFinite(decision.delayMs) ||
          decision.delayMs < 0 ||
          decision.delayMs >= remaining
        )
          throw error;
        await wait(decision.delayMs, signal);
      }
    }
  }
  #validateAccessUrl(value, capsuleId) {
    let url;
    try {
      url = new globalThis.URL(value);
    } catch {
      throw new errors_ts_1.TargetProtocolError('Capsule access WebSocket URL is invalid');
    }
    const expectedPath = this.#descriptor.transport.websocketRouteTemplate.expand({
      capsule_id: capsuleId,
    });
    const target = new globalThis.URL(this.#descriptor.origin);
    if (
      url.protocol !== 'wss:' ||
      url.host !== target.host ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== expectedPath
    ) {
      throw new errors_ts_1.TargetProtocolError(
        'Capsule access WebSocket URL does not match discovery'
      );
    }
  }
}
exports.ZeroCloudV1TargetAdapter = ZeroCloudV1TargetAdapter;
