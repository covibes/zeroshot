import {
  JSON_RPC_VERSION,
  PROTOCOL_VERSION,
  parseUnaryResponseLine,
  type JsonRpcRequest,
  type RequestId,
} from './envelope.js';
import { AbortError, InvalidResponseError } from './errors.js';
import type { PumpedResponse } from './multiplexed-transport.js';
import type {
  ApplyParams,
  ApplyResult,
  DeleteParams,
  DeleteResult,
  GetParams,
  GetResult,
  InitializeResult,
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
} from './wire-types.generated.js';

/** What {@link ClusterClient} needs from a transport: shared id allocation plus unary request/cancel. */
export interface ClusterRequestTransport {
  sendRequest(serialized: string, id: RequestId): Promise<PumpedResponse>;
  nextRequestId(): RequestId;
  cancelRequest(id: RequestId): Promise<void>;
}

export interface ClusterCallOptions {
  readonly signal?: AbortSignal;
}

function abortSignalRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortError());
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        reject(new AbortError());
      },
      { once: true }
    );
  });
}

/**
 * Typed transport-neutral Cluster Protocol client. Mirrors
 * crates/openengine-cluster-client/src/lib.rs's `ClusterClient`, except unary request ids are
 * minted by the shared transport (`transport.nextRequestId()`) rather than a per-client counter —
 * intentionally, so two `ClusterClient`s sharing one `MultiplexedTransport` never collide (see
 * `MultiplexedTransport`'s doc comment).
 */
export class ClusterClient {
  private readonly transport: ClusterRequestTransport;

  constructor(transport: ClusterRequestTransport) {
    this.transport = transport;
  }

  async initialize(options?: ClusterCallOptions): Promise<InitializeResult> {
    const result = await this.call<{ protocolVersion: string }, InitializeResult>(
      'initialize',
      { protocolVersion: PROTOCOL_VERSION },
      options
    );
    if (result.protocolVersion !== PROTOCOL_VERSION) {
      throw new InvalidResponseError(
        `protocol version mismatch: requested ${PROTOCOL_VERSION}, received ${result.protocolVersion}`
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

  get(params: GetParams, options?: ClusterCallOptions): Promise<GetResult> {
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

  /**
   * Sends one unary request and parses its typed result. When `options.signal` fires, `$/cancelRequest`
   * is sent exactly once (an idempotent flag guards a second `signal`/manual trigger) and this call
   * rejects locally without waiting for the transport to actually settle — the eventual settlement is
   * swallowed so it never surfaces as an unhandled rejection.
   */
  private async call<P, R>(method: string, params: P, options?: ClusterCallOptions): Promise<R> {
    const signal = options?.signal;
    if (signal?.aborted) throw new AbortError();

    const id = this.transport.nextRequestId();
    const request: JsonRpcRequest<P> = { jsonrpc: JSON_RPC_VERSION, id, method, params };
    const responsePromise = this.transport.sendRequest(JSON.stringify(request), id);

    if (!signal) {
      const response = await responsePromise;
      return parseUnaryResponseLine<R>(response.line, id);
    }

    let cancelled = false;
    const cancelOnce = (): void => {
      if (cancelled) return;
      cancelled = true;
      this.transport.cancelRequest(id).catch(() => {
        // Best-effort: the connection may already be gone.
      });
    };

    try {
      const response = await Promise.race([responsePromise, abortSignalRejection(signal)]);
      return parseUnaryResponseLine<R>(response.line, id);
    } catch (error) {
      if (error instanceof AbortError) {
        cancelOnce();
        responsePromise.catch(() => {
          // Swallow the eventual settlement; the caller already saw the abort rejection.
        });
      }
      throw error;
    }
  }
}
