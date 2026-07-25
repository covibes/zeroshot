import type {ConnectionMultiplexer} from './transport/multiplexer.js';
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
} from './generated/wire-types.js';
import {InvalidResponseError} from './errors.js';

/** The Cluster Protocol v1 wire version this client requests -- matches the Rust `PROTOCOL_VERSION`. */
export const PROTOCOL_VERSION = 'openengine.cluster/v1';

export interface CallOptions {
  readonly signal?: AbortSignal;
}

/**
 * Typed client for the nine unary Cluster Protocol v1 methods. Holds no id state of its own --
 * every request is minted and demultiplexed by the {@link ConnectionMultiplexer} it was
 * constructed with, so any number of `ClusterClient`s can safely share one transport (see
 * {@link ConnectionMultiplexer} for why that matters).
 */
export class ClusterClient {
  private readonly transport: ConnectionMultiplexer;

  public constructor(transport: ConnectionMultiplexer) {
    this.transport = transport;
  }

  /** The shared transport backing this client, e.g. to reconnect a subscription on a fresh client. */
  public getTransport(): ConnectionMultiplexer {
    return this.transport;
  }

  public async initialize(options?: CallOptions): Promise<InitializeResult> {
    const result = await this.transport.call(
      'initialize',
      {protocolVersion: PROTOCOL_VERSION},
      options?.signal
    );
    if (result.protocolVersion !== PROTOCOL_VERSION) {
      throw new InvalidResponseError(
        `protocol version mismatch: requested ${PROTOCOL_VERSION}, received ${result.protocolVersion}`
      );
    }
    return result;
  }

  public plan(params: PlanParams, options?: CallOptions): Promise<PlanResult> {
    return this.transport.call('plan', params, options?.signal);
  }

  public apply(params: ApplyParams, options?: CallOptions): Promise<ApplyResult> {
    return this.transport.call('apply', params, options?.signal);
  }

  public get(params: GetParams = {}, options?: CallOptions): Promise<GetResult> {
    return this.transport.call('get', params, options?.signal);
  }

  public update(params: UpdateParams, options?: CallOptions): Promise<UpdateResult> {
    return this.transport.call('update', params, options?.signal);
  }

  public stop(params: StopParams, options?: CallOptions): Promise<StopResult> {
    return this.transport.call('stop', params, options?.signal);
  }

  public retry(params: RetryParams, options?: CallOptions): Promise<RetryResult> {
    return this.transport.call('retry', params, options?.signal);
  }

  public resubmit(params: ResubmitParams, options?: CallOptions): Promise<ResubmitResult> {
    return this.transport.call('resubmit', params, options?.signal);
  }

  public delete(params: DeleteParams, options?: CallOptions): Promise<DeleteResult> {
    return this.transport.call('delete', params, options?.signal);
  }
}
