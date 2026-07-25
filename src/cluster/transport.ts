/**
 * Transport-neutral contract for the Cluster Protocol client, mirroring
 * `openengine_cluster_client::{JsonRpcTransport, SubscriptionTransport, TransportError}`
 * (crates/openengine-cluster-client/src/lib.rs). Only a WebSocket binding
 * ({@link ./websocket-transport.js}) is implemented in this package; the interfaces below stay
 * transport-neutral so an alternate wire binding can implement them without touching
 * {@link ./cluster-client.js} or the subscription clients.
 */

import type { RequestId } from './generated/wire-types.js';
import { isRecord } from './json-guards.js';

export type { RequestId } from './generated/wire-types.js';

export const JSON_RPC_VERSION = '2.0';

/** Generic JSON-RPC request envelope, matching the shape of Rust's generic
 * `JsonRpcRequest<P>` (crates/openengine-cluster-protocol/src/wire.rs). Hand-declared rather
 * than generated: schemars can only emit one monomorphized interface per Rust generic
 * instantiation (`JsonRpcRequest`, `JsonRpcRequest2`, ...), so reusing those here would mean
 * importing a dozen structurally-identical duplicates instead of the one generic Rust already
 * expresses at the source level. */
export interface JsonRpcRequestEnvelope<TMethod extends string, TParams> {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: RequestId;
  method: TMethod;
  params: TParams;
}

/** Generic JSON-RPC success envelope, matching Rust's generic `JsonRpcSuccess<R>`. See
 * {@link JsonRpcRequestEnvelope} for why this is hand-declared instead of generated. */
export interface JsonRpcSuccessEnvelope<TResult> {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: RequestId;
  result: TResult;
}

/** Generic JSON-RPC notification envelope, matching Rust's generic `JsonRpcNotification<P>`.
 * See {@link JsonRpcRequestEnvelope} for why this is hand-declared instead of generated. */
export interface JsonRpcNotificationEnvelope<TMethod extends string, TParams> {
  jsonrpc: typeof JSON_RPC_VERSION;
  method: TMethod;
  params: TParams;
}

/** Mirrors `openengine_cluster_client::TransportError` (Io | Protocol): a transport-layer
 * failure, thrown/rejected below {@link ClusterClientError} in the public API surface exported
 * from {@link ./errors.js}. */
export class TransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransportError';
  }
}

/** Extracts the `id` from a request this module serialized itself. Throws on a malformed id,
 * since that indicates an internal bug in request construction rather than bad external input --
 * mirrors `extract_request_id`'s `expect`/`panic!` in crates/openengine-cluster-client/src/lib.rs,
 * translated to a thrown error since this is a library, not a binary. */
// eslint-disable-next-line sonarjs/function-return-type -- RequestId is `string | number` by design (mirrors Rust's `enum RequestId`).
export function extractRequestId(request: string): RequestId {
  const value: unknown = JSON.parse(request);
  if (!isRecord(value) || !('id' in value)) {
    throw new TransportError('outgoing request must carry an id');
  }
  const id = value.id;
  if (typeof id === 'string') {
    return id;
  }
  if (typeof id === 'number' && Number.isFinite(id)) {
    return id;
  }
  throw new TransportError(`outgoing request id must be a string or integer, got ${JSON.stringify(id)}`);
}

/** Mirrors `openengine_cluster_client::JsonRpcTransport`. */
export interface JsonRpcTransport {
  request(request: string): Promise<string>;
}

/** One demultiplexed unary response: the raw response line plus, only for a successful
 * subscription-establishing response, the freshly registered channel for that subscription's
 * `event`/`subscription/closed` notifications. Mirrors `PumpedSubscription`
 * (crates/openengine-cluster-client/src/lib.rs); its fields are only meant to be read by
 * {@link ./multiplex.js} and the subscription clients under this package, not by outside
 * consumers of the public `cluster` subpath. */
export interface PumpedSubscription {
  channel: BoundedChannel<string>;
  overflowed: OverflowFlag;
}

export interface OverflowFlag {
  value: boolean;
}

/** Mirrors `openengine_cluster_client::SubscriptionTransport`: transport-neutral generic
 * subscription framing (establish, cancel, best-effort cancel an in-flight unary request, mint
 * the next subscription-establishing request id). Subscription ids are always plain strings on
 * the wire -- never a dedicated JSON Schema type (`subscriptionId` fields are typed `string`
 * throughout schema.json) -- so this package does not declare its own alias for one. */
export interface SubscriptionTransport extends JsonRpcTransport {
  openSubscription(
    request: string,
    id: RequestId
  ): Promise<{ line: string; subscription?: PumpedSubscription }>;
  cancelSubscription(subscriptionId: string): Promise<void>;
  cancelRequest(id: RequestId): Promise<void>;
  nextWatchRequestId(): RequestId;
}

export function isSubscriptionTransport(
  transport: JsonRpcTransport
): transport is SubscriptionTransport {
  return (
    typeof (transport as Partial<SubscriptionTransport>).openSubscription === 'function' &&
    typeof (transport as Partial<SubscriptionTransport>).cancelSubscription === 'function' &&
    typeof (transport as Partial<SubscriptionTransport>).cancelRequest === 'function' &&
    typeof (transport as Partial<SubscriptionTransport>).nextWatchRequestId === 'function'
  );
}

/** One item read from a {@link BoundedChannel}: either the next value, or the channel's
 * permanent end (mirrors `Option<String>` from `mpsc::Receiver::recv`). */
export type ChannelItem<T> = { done: false; value: T } | { done: true };

/**
 * Minimal bounded, non-blocking-producer async queue, standing in for Rust's
 * `tokio::sync::mpsc::channel(SUBSCRIPTION_QUEUE_CAPACITY)`: {@link trySend} never awaits and
 * fails once `capacity` undelivered items are already buffered, exactly like `mpsc::Sender::
 * try_send`'s `Full` case, so one abandoned subscription can never stall the connection's sole
 * read pump. {@link recv} resolves items in FIFO order and resolves with `{done: true}` forever
 * once {@link close} has been called and the buffer has drained.
 */
export class BoundedChannel<T> {
  private readonly capacity: number;
  private readonly buffer: T[] = [];
  private readonly waiters: Array<(item: ChannelItem<T>) => void> = [];
  private closed = false;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  /** Non-blocking send. Returns `false` (mirroring `TrySendError::Full`) when `capacity`
   * undelivered items are already buffered and no consumer is currently waiting. */
  trySend(value: T): boolean {
    if (this.closed) {
      return false;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return true;
    }
    if (this.buffer.length >= this.capacity) {
      return false;
    }
    this.buffer.push(value);
    return true;
  }

  /** Ends the channel permanently: every already-waiting {@link recv} resolves with
   * `{done: true}`, and every future call does too once the buffer drains. Mirrors dropping the
   * `mpsc::Sender` half. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true });
    }
  }

  recv(): Promise<ChannelItem<T>> {
    if (this.buffer.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- length check above guarantees a defined element.
      return Promise.resolve({ done: false, value: this.buffer.shift() as T });
    }
    if (this.closed) {
      return Promise.resolve({ done: true });
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}
