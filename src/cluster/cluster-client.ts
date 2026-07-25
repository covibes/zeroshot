/**
 * Typed transport-neutral Cluster Protocol client, mirroring `openengine_cluster_client::
 * ClusterClient<T>` (crates/openengine-cluster-client/src/lib.rs): the nine unary v1 JSON-RPC
 * methods. `watch`/`logs`/`agent/attach` are subscription-establishing methods with their own
 * dedup/reconnect or cancellation semantics and are served by {@link ./watch-subscription.js},
 * {@link ./logs-subscription.js}, and {@link ./agent-attach-subscription.js} instead.
 */

import { ClusterAbortError, ClusterInvalidResponseError, ClusterRpcError, toClusterClientError } from './errors.js';
import { isRecord } from './json-guards.js';
import type { ClusterMethodMap, ClusterMethodName } from './generated/methods.js';
import type {
  ApplyParams,
  ApplyResult,
  DeleteParams,
  DeleteResult,
  GetParams,
  GetResult,
  InitializeParams,
  InitializeResult,
  JsonRpcErrorResponse,
  PlanParams,
  PlanResult,
  ResubmitParams,
  ResubmitResult,
  RetryParams,
  RetryResult,
  StopParams,
  StopResult,
  UpdateParams,
  UpdateResult,
} from './generated/wire-types.js';
import {
  isSubscriptionTransport,
  JSON_RPC_VERSION,
  type JsonRpcRequestEnvelope,
  type JsonRpcSuccessEnvelope,
  type JsonRpcTransport,
  type RequestId,
} from './transport.js';

/** The only protocol version this package speaks, matching Rust's `PROTOCOL_VERSION`. */
export const PROTOCOL_VERSION = 'openengine.cluster/v1' as const;

export interface ClusterCallOptions {
  signal?: AbortSignal;
}

export class ClusterClient {
  private readonly transport: JsonRpcTransport;
  private nextId = 1;

  constructor(transport: JsonRpcTransport) {
    this.transport = transport;
  }

  /** Initializes with {@link PROTOCOL_VERSION} and validates the server echoed it back. */
  initialize(options?: ClusterCallOptions): Promise<InitializeResult> {
    return this.initializeWithVersion(PROTOCOL_VERSION, options);
  }

  /**
   * Initializes with an explicit `protocolVersion`, for exercising the server's version
   * negotiation (e.g. `UNSUPPORTED_PROTOCOL_VERSION`) rather than the compiled-in constant.
   * Mirrors `ClusterClient::initialize_with_version`. The generated {@link InitializeParams}
   * type pins `protocolVersion` to the {@link PROTOCOL_VERSION} literal because that is what
   * every well-formed request sends; the cast below intentionally widens it back to `string` for
   * this one deliberate-mismatch entrypoint, exactly like Rust's unrestricted `impl Into<String>`
   * parameter.
   */
  async initializeWithVersion(
    protocolVersion: string,
    options?: ClusterCallOptions
  ): Promise<InitializeResult> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- deliberately widened; see doc comment above.
    const params = { protocolVersion } as unknown as InitializeParams;
    const result = await this.call('initialize', params, options);
    if (result.protocolVersion !== protocolVersion) {
      throw new ClusterInvalidResponseError(
        `protocol version mismatch: requested ${protocolVersion}, received ${result.protocolVersion}`
      );
    }
    return result;
  }

  plan(params: PlanParams, options?: ClusterCallOptions): Promise<PlanResult> {
    return this.call('plan', params, options);
  }

  apply(params: ApplyParams, options?: ClusterCallOptions): Promise<ApplyResult> {
    return this.call('apply', params, options);
  }

  get(params: GetParams = {}, options?: ClusterCallOptions): Promise<GetResult> {
    return this.call('get', params, options);
  }

  update(params: UpdateParams, options?: ClusterCallOptions): Promise<UpdateResult> {
    return this.call('update', params, options);
  }

  stop(params: StopParams, options?: ClusterCallOptions): Promise<StopResult> {
    return this.call('stop', params, options);
  }

  retry(params: RetryParams, options?: ClusterCallOptions): Promise<RetryResult> {
    return this.call('retry', params, options);
  }

  resubmit(params: ResubmitParams, options?: ClusterCallOptions): Promise<ResubmitResult> {
    return this.call('resubmit', params, options);
  }

  delete(params: DeleteParams, options?: ClusterCallOptions): Promise<DeleteResult> {
    return this.call('delete', params, options);
  }

  private call<TMethod extends ClusterMethodName>(
    method: TMethod,
    params: ClusterMethodMap[TMethod]['params'],
    options?: ClusterCallOptions
  ): Promise<ClusterMethodMap[TMethod]['result']> {
    if (options?.signal?.aborted) {
      return Promise.reject(new ClusterAbortError());
    }

    const id: RequestId = this.nextId++;
    const request: JsonRpcRequestEnvelope<TMethod, typeof params> = {
      jsonrpc: JSON_RPC_VERSION,
      id,
      method,
      params,
    };

    const resultPromise = this.transport.request(JSON.stringify(request)).then(
      (line) => parseJsonRpcResponse<ClusterMethodMap[TMethod]['result']>(line, id),
      (error) => {
        throw toClusterClientError(error);
      }
    );

    if (!options?.signal) {
      return resultPromise;
    }
    return raceAbort(resultPromise, options.signal, this.transport, id);
  }
}

/** Shared by every subscription client (`watch`/`logs`/`agent/attach` establishment responses
 * are unary JSON-RPC responses on the wire, exactly like the nine methods above) -- mirrors
 * `crate::validate_response_identity` in crates/openengine-cluster-client/src/lib.rs, which
 * `ndjson_watch.rs` and the `ndjson_subscription.rs` macro import the same way. */
export function validateResponseIdentity(
  jsonrpc: unknown,
  actualId: RequestId | null | undefined,
  expectedId: RequestId
): void {
  if (jsonrpc !== JSON_RPC_VERSION) {
    throw new ClusterInvalidResponseError(
      `expected jsonrpc ${JSON_RPC_VERSION}, received ${JSON.stringify(jsonrpc)}`
    );
  }
  if (actualId === null || actualId === undefined || actualId !== expectedId) {
    throw new ClusterInvalidResponseError(
      `response id mismatch: expected ${JSON.stringify(expectedId)}, received ${JSON.stringify(actualId)}`
    );
  }
}

/** Parses one unary (or subscription-establishing) response line, mirroring `ClusterClient::
 * call`'s response handling. Trusts the wire shape once identity validation passes, exactly like
 * Rust's `serde_json::from_value::<R>` -- this is the deserialization trust boundary for every
 * unary method's and every subscription establishment's result type. */
export function parseJsonRpcResponse<TResult>(line: string, expectedId: RequestId): TResult {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new ClusterInvalidResponseError(error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(value)) {
    throw new ClusterInvalidResponseError('response must be a JSON object');
  }
  if ('error' in value) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- deserialization trust boundary; see doc comment above.
    const response = value as unknown as JsonRpcErrorResponse;
    validateResponseIdentity(response.jsonrpc, response.id ?? undefined, expectedId);
    throw new ClusterRpcError(response.error);
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- deserialization trust boundary; see doc comment above.
  const response = value as unknown as JsonRpcSuccessEnvelope<TResult>;
  validateResponseIdentity(response.jsonrpc, response.id, expectedId);
  return response.result;
}

/** Races `promise` against `signal`'s abort event, resolving/rejecting exactly once. On abort,
 * best-effort cancels the in-flight request (if the transport supports it) then rejects locally
 * with {@link ClusterAbortError} -- mirrors the abort handling documented for every ClusterClient
 * method. */
export function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  transport: JsonRpcTransport,
  id: RequestId
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (isSubscriptionTransport(transport)) {
        transport.cancelRequest(id).catch(() => {
          // Best-effort: mirrors `SubscriptionTransport::cancel_request`'s fire-and-forget
          // contract -- the server silently no-ops an unknown or already-completed id.
        });
      }
      reject(new ClusterAbortError());
    };

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}
