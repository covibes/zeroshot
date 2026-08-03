'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.ZeroCloudV1TargetAdapter = void 0;
const bounds_js_1 = require('./bounds.cjs');
const errors_js_1 = require('./errors.cjs');
const retry_js_1 = require('./retry.cjs');
const response_validation_js_1 = require('./response-validation.cjs');
const bounded_response_js_1 = require('../target/bounded-response.cjs');
const capsule_error_response_js_1 = require('./capsule-error-response.cjs');
const access_url_js_1 = require('./access-url.cjs');
const retry_executor_js_1 = require('./retry-executor.cjs');
const adapter_request_js_1 = require('./adapter-request.cjs');
const DEFAULT_TRANSPORT = {
  fetch(url, init) {
    return globalThis.fetch(url, init);
  },
};
const DEFAULT_CLOCK = { now: () => Date.now() };
function throwIfAborted(signal) {
  if (signal?.aborted)
    throw signal.reason ?? new globalThis.DOMException('The operation was aborted', 'AbortError');
}
function validOpaque(value, field) {
  if (value.length === 0 || value.length > 1024)
    throw new errors_js_1.TargetProtocolError(`${field} is invalid`);
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
    this.#retryPolicy = options.retryPolicy ?? new retry_js_1.DefaultRetryPolicy();
  }
  get credentialInstall() {
    const descriptor = this.#descriptor.credentialInstall;
    return descriptor === null
      ? Object.freeze({ supported: false })
      : Object.freeze({ supported: true, descriptor });
  }
  allocate(request, signal) {
    try {
      if (!bounds_js_1.IDEMPOTENCY_KEY_PATTERN.test(request.idempotencyKey))
        throw new errors_js_1.TargetProtocolError('Idempotency key is invalid');
      if (request.label !== undefined && (request.label.length < 1 || request.label.length > 100)) {
        throw new errors_js_1.TargetProtocolError('Capsule label is outside the supported bounds');
      }
      if (request.size !== undefined && !this.#descriptor.sizes.catalog.includes(request.size)) {
        throw new errors_js_1.TargetProtocolError('Capsule size is not advertised by the target');
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
        response_validation_js_1.assertCapsule,
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
      throw new errors_js_1.TargetProtocolError(
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
      response_validation_js_1.assertCapsuleListPage,
      signal
    );
    if (request.cursor !== undefined && page.nextCursor === request.cursor)
      throw new errors_js_1.TargetProtocolError('Target returned a pagination loop');
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
      response_validation_js_1.assertCapsule,
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
      response_validation_js_1.assertCapsule,
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
      response_validation_js_1.assertCapsuleLimits,
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
      response_validation_js_1.assertCapsuleAccess,
      signal,
      {
        body: jsonRequest({ protocol: 'openengine.cluster/v1' }),
      }
    );
    (0, access_url_js_1.validateAccessUrl)(result.websocketUrl, capsuleId, this.#descriptor);
    return result;
  }
  #execute(...args) {
    return Promise.resolve().then(() => this.#executeExpanded(args));
  }
  #executeExpanded(args) {
    const [operation, method, template, values, expectedStatus, validate, signal, request = {}] =
      args;
    let path;
    try {
      path = template.expand(values);
    } catch {
      throw new errors_js_1.TargetProtocolError('Capsule route expansion is unsafe');
    }
    return (0, retry_executor_js_1.withTargetRetry)(
      operation,
      async () => {
        const response = await this.#request(method, path, signal, request);
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => undefined);
          throw new errors_js_1.TargetProtocolError('Capsule redirects are forbidden');
        }
        if (response.status !== expectedStatus) {
          if (response.status >= 200 && response.status < 300) {
            await response.body?.cancel().catch(() => undefined);
            throw new errors_js_1.TargetProtocolError(
              'Target returned an unexpected success status'
            );
          }
          await (0, capsule_error_response_js_1.throwCapsuleServerError)(
            response,
            (errorResponse) => this.#readJson(errorResponse),
            this.#clock
          );
        }
        return validate(await this.#readJson(response));
      },
      signal,
      { clock: this.#clock, policy: this.#retryPolicy }
    );
  }
  async #request(method, path, signal, request) {
    throwIfAborted(signal);
    const url = (0, adapter_request_js_1.requestUrl)(path, this.#descriptor);
    let token;
    try {
      token = await this.#tokenProvider.getAccessToken(signal);
    } catch {
      throw new errors_js_1.TargetAuthError('Target access authorization failed');
    }
    const init = {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...request.headers,
      },
      redirect: 'manual',
    };
    if (request.body !== undefined) init.body = request.body;
    if (signal !== undefined) init.signal = signal;
    try {
      const response = await this.#transport.fetch(url.href, init);
      if (response.url && new globalThis.URL(response.url).href !== url.href) {
        await response.body?.cancel().catch(() => undefined);
        throw new errors_js_1.TargetProtocolError('Capsule response changed target route');
      }
      return response;
    } catch (error) {
      if (error instanceof errors_js_1.TargetAdapterError) throw error;
      throwIfAborted(signal);
      throw new errors_js_1.TargetTransportError('Capsule transport failed');
    }
  }
  #readJson(response) {
    return (0, bounded_response_js_1.readBoundedResponseJson)(
      response,
      bounds_js_1.MAX_RESPONSE_BYTES,
      (kind) =>
        new errors_js_1.TargetProtocolError(
          kind === 'size'
            ? 'Capsule response exceeds the size limit'
            : 'Capsule response is not valid UTF-8 JSON'
        )
    );
  }
}
exports.ZeroCloudV1TargetAdapter = ZeroCloudV1TargetAdapter;
