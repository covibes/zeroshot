import { IDEMPOTENCY_KEY_PATTERN, MAX_RESPONSE_BYTES } from './bounds.js';
import { TargetProtocolError } from './errors.js';
import { DefaultRetryPolicy } from './retry.js';
import {
  assertCapsule,
  assertCapsuleAccess,
  assertCapsuleLimits,
  assertCapsuleListPage,
} from './response-validation.js';
import type { TargetAdapter, CreateTargetAdapterOptions } from './adapter-types.js';
import type {
  AllocateRequest,
  Capsule,
  CapsuleAccess,
  CapsuleLimits,
  CapsuleListPage,
  Clock,
  ListRequest,
  RetryPolicy,
} from './types.js';
import type { TargetDiscoveryDescriptor } from '../target/discovery.js';
import { readBoundedResponseJson } from '../target/bounded-response.js';
import { validateAccessUrl } from './access-url.js';
import { withTargetRetry } from './retry-executor.js';
import { installRuntime as installOpaqueRuntime } from './runtime-install.js';
import { assertCapsuleResponseStatus } from './response-status.js';
import {
  createAdapterRequester,
  type AdapterRequester,
  type ExecuteArguments,
} from './adapter-request.js';

const DEFAULT_CLOCK: Clock = { now: () => Date.now() };

function validOpaque(value: string, field: string): void {
  if (value.length === 0 || value.length > 1024)
    throw new TargetProtocolError(`${field} is invalid`);
}

function jsonRequest(body: unknown): string {
  return JSON.stringify(body);
}

export class ZeroCloudV1TargetAdapter implements TargetAdapter {
  readonly #descriptor: TargetDiscoveryDescriptor;
  readonly #organizationId: string;
  readonly #request: AdapterRequester;
  readonly #clock: Clock;
  readonly #retryPolicy: RetryPolicy;

  constructor(options: CreateTargetAdapterOptions) {
    this.#descriptor = options.descriptor;
    this.#organizationId = options.organization.id;
    validOpaque(this.#organizationId, 'organization id');
    this.#request = createAdapterRequester(
      options.descriptor,
      options.tokenProvider,
      options.transport
    );
    this.#clock = options.clock ?? DEFAULT_CLOCK;
    this.#retryPolicy = options.retryPolicy ?? new DefaultRetryPolicy();
  }

  get credentialInstall(): TargetAdapter['credentialInstall'] {
    const descriptor = this.#descriptor.credentialInstall;
    return descriptor === null
      ? Object.freeze({ supported: false as const })
      : Object.freeze({ supported: true as const, descriptor });
  }

  allocate(request: AllocateRequest, signal?: AbortSignal): Promise<Capsule> {
    try {
      if (!IDEMPOTENCY_KEY_PATTERN.test(request.idempotencyKey))
        throw new TargetProtocolError('Idempotency key is invalid');
      if (request.label !== undefined && (request.label.length < 1 || request.label.length > 100)) {
        throw new TargetProtocolError('Capsule label is outside the supported bounds');
      }
      if (request.size !== undefined && !this.#descriptor.sizes.catalog.includes(request.size)) {
        throw new TargetProtocolError('Capsule size is not advertised by the target');
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
        assertCapsule,
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

  async list(request: ListRequest = {}, signal?: AbortSignal): Promise<CapsuleListPage> {
    if (request.cursor !== undefined) validOpaque(request.cursor, 'cursor');
    if (
      request.limit !== undefined &&
      (!Number.isSafeInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > this.#descriptor.pagination.maxPageSize)
    ) {
      throw new TargetProtocolError('Pagination limit is outside the advertised bounds');
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
      assertCapsuleListPage,
      signal
    );
    if (request.cursor !== undefined && page.nextCursor === request.cursor)
      throw new TargetProtocolError('Target returned a pagination loop');
    return page;
  }

  inspect(capsuleId: string, signal?: AbortSignal): Promise<Capsule> {
    validOpaque(capsuleId, 'capsule id');
    return this.#execute(
      'inspect',
      'GET',
      this.#descriptor.capsule.routes.inspect,
      { org_id: this.#organizationId, capsule_id: capsuleId },
      200,
      assertCapsule,
      signal
    );
  }

  terminate(capsuleId: string, signal?: AbortSignal): Promise<Capsule> {
    validOpaque(capsuleId, 'capsule id');
    return this.#execute(
      'terminate',
      'DELETE',
      this.#descriptor.capsule.routes.terminate,
      { org_id: this.#organizationId, capsule_id: capsuleId },
      202,
      assertCapsule,
      signal
    );
  }

  limits(signal?: AbortSignal): Promise<CapsuleLimits> {
    return this.#execute(
      'limits',
      'GET',
      this.#descriptor.capsule.routes.limits,
      { org_id: this.#organizationId },
      200,
      assertCapsuleLimits,
      signal
    );
  }

  async access(capsuleId: string, signal?: AbortSignal): Promise<CapsuleAccess> {
    validOpaque(capsuleId, 'capsule id');
    const result = await this.#execute(
      'access',
      'POST',
      this.#descriptor.capsule.routes.access,
      { capsule_id: capsuleId },
      200,
      assertCapsuleAccess,
      signal,
      {
        body: jsonRequest({ protocol: 'openengine.cluster/v1' }),
      }
    );
    validateAccessUrl(result.websocketUrl, capsuleId, this.#descriptor);
    return result;
  }

  async installRuntime(
    capsuleId: string,
    runtime: unknown,
    accessToken: string,
    signal?: AbortSignal
  ): Promise<void> {
    const descriptor = this.#descriptor.credentialInstall;
    if (descriptor === null) {
      throw new TargetProtocolError('Target does not advertise runtime installation');
    }
    await installOpaqueRuntime({
      capsuleId,
      runtime,
      accessToken,
      descriptor,
      ...(signal === undefined ? {} : { signal }),
      clock: this.#clock,
      retryPolicy: this.#retryPolicy,
      request: (method, path, requestSignal, body, token) =>
        this.#request({
          method,
          path,
          signal: requestSignal,
          request: { body },
          accessToken: token,
        }),
    });
  }

  #execute<T>(...args: ExecuteArguments<T>): Promise<T> {
    return Promise.resolve().then(() => this.#executeExpanded(args));
  }

  #executeExpanded<T>(args: ExecuteArguments<T>): Promise<T> {
    const [operation, method, template, values, expectedStatus, validate, signal, request = {}] =
      args;
    let path: string;
    try {
      path = template.expand(values);
    } catch {
      throw new TargetProtocolError('Capsule route expansion is unsafe');
    }
    return withTargetRetry(
      operation,
      async () => {
        const response = await this.#request({
          method,
          path,
          signal,
          request,
          accessToken: undefined,
        });
        await assertCapsuleResponseStatus(
          response,
          expectedStatus,
          (errorResponse) => this.#readJson(errorResponse),
          this.#clock
        );
        return validate(await this.#readJson(response));
      },
      signal,
      { clock: this.#clock, policy: this.#retryPolicy }
    );
  }

  #readJson(response: Response): Promise<unknown> {
    return readBoundedResponseJson(
      response,
      MAX_RESPONSE_BYTES,
      (kind) =>
        new TargetProtocolError(
          kind === 'size'
            ? 'Capsule response exceeds the size limit'
            : 'Capsule response is not valid UTF-8 JSON'
        )
    );
  }
}
