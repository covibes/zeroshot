import {AbortError, InvalidResponseError, RpcError, TransportError} from '../errors.js';
import type {MethodParams, MethodResult, SubscriptionMethod, UnaryMethod} from '../generated/methods.js';
import type * as Wire from '../generated/wire-types.js';
import {
  JSON_RPC_VERSION,
  extractSubscriptionId,
  parseIncomingMessage,
  type JsonRpcNotificationEnvelope,
  type JsonRpcRequestEnvelope,
} from '../json-guards.js';
import {AsyncQueue} from './async-queue.js';
import {createDeferred} from './deferred.js';
import {WEBSOCKET_READY_STATE, type WebSocketLike} from './websocket-like.js';

/** One raw subscription delivery: an `event` notification's params, or a terminal close. */
export type SubscriptionDelivery =
  | {kind: 'event'; params: unknown}
  | {kind: 'closed'; params: unknown};

export interface OpenSubscriptionResult<R> {
  readonly result: R;
  readonly subscriptionId: string;
  readonly deliveries: AsyncIterable<SubscriptionDelivery>;
}

interface SubscriptionSettlement {
  readonly result: unknown;
  readonly subscriptionId: string;
  readonly deliveries: AsyncIterable<SubscriptionDelivery>;
}

interface PendingUnary {
  readonly kind: 'unary';
  resolve(result: unknown): void;
  reject(error: Error): void;
}

interface PendingSubscription {
  readonly kind: 'subscription';
  resolve(value: SubscriptionSettlement): void;
  reject(error: Error): void;
}

type Pending = PendingUnary | PendingSubscription;

/**
 * Owns one WebSocket connection's demultiplexing state: outgoing frame writes, the pending-request
 * map, and per-subscription delivery queues. Mints exactly one shared, monotonically increasing
 * request id for every unary call AND every subscription-establish call made through this
 * transport -- the fix for the PR#799 finding that a per-`ClusterClient` id counter lets two
 * clients sharing a transport collide. Every `ClusterClient` and subscription factory built on top
 * of one `ConnectionMultiplexer` mints ids from this single counter, so a collision is impossible
 * by construction regardless of how many clients share it.
 */
export class ConnectionMultiplexer {
  private readonly socket: WebSocketLike;
  private nextId = 1;
  private readonly pending = new Map<Wire.RequestId, Pending>();
  private readonly subscriptions = new Map<string, AsyncQueue<SubscriptionDelivery>>();
  private closed = false;

  public constructor(socket: WebSocketLike) {
    this.socket = socket;
    this.socket.addEventListener('message', (event) => this.handleMessage(event.data));
    this.socket.addEventListener('close', () => this.handleClose());
    this.socket.addEventListener('error', () => this.handleClose());
  }

  /** Mints the next request id, shared across every unary and subscription-establish call. */
  public mintId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  /**
   * Wires an `AbortSignal` to best-effort cancel a still-pending request: removes it from
   * `pending`, sends `$/cancelRequest`, and rejects `reject` with an {@link AbortError}. A no-op if
   * the request already settled. Returns an unsubscribe function the caller must run once the
   * request settles normally, so the listener does not outlive it. Shared by `call` and
   * `openSubscription` so both cancel identically.
   */
  private registerAbort(
    id: Wire.RequestId,
    reject: (error: Error) => void,
    signal: AbortSignal | undefined
  ): () => void {
    const onAbort = (): void => {
      if (!this.pending.delete(id)) return;
      this.sendNotificationBestEffort('$/cancelRequest', {id});
      reject(new AbortError());
    };
    signal?.addEventListener('abort', onAbort, {once: true});
    return () => signal?.removeEventListener('abort', onAbort);
  }

  public async call<M extends UnaryMethod>(
    method: M,
    params: MethodParams[M],
    signal?: AbortSignal
  ): Promise<MethodResult[M]> {
    if (signal?.aborted) throw new AbortError();
    const id = this.mintId();
    const deferred = createDeferred<unknown>();
    this.pending.set(id, {kind: 'unary', resolve: deferred.resolve, reject: deferred.reject});
    const unregisterAbort = this.registerAbort(id, deferred.reject, signal);

    this.sendRequest(id, method, params);

    try {
      const result = await deferred.promise;
      // The pending map is heterogeneous by construction (one shared map serves every method);
      // `result` is only ever settled from `handleMessage` for THIS `id`, and the server always
      // answers request `id` with the result type of the method it was minted for.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return result as MethodResult[M];
    } finally {
      unregisterAbort();
    }
  }

  public async openSubscription<M extends SubscriptionMethod>(
    method: M,
    params: MethodParams[M],
    signal?: AbortSignal
  ): Promise<OpenSubscriptionResult<MethodResult[M]>> {
    if (signal?.aborted) throw new AbortError();
    const id = this.mintId();
    const deferred = createDeferred<SubscriptionSettlement>();
    this.pending.set(id, {kind: 'subscription', resolve: deferred.resolve, reject: deferred.reject});
    const unregisterAbort = this.registerAbort(id, deferred.reject, signal);

    this.sendRequest(id, method, params);

    try {
      const settled = await deferred.promise;
      return {
        // Same construction guarantee as `call`'s cast above.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        result: settled.result as MethodResult[M],
        subscriptionId: settled.subscriptionId,
        deliveries: settled.deliveries,
      };
    } finally {
      unregisterAbort();
    }
  }

  /** Best-effort `subscription/cancel`: fire-and-forget, matching the wire contract exactly. */
  public cancelSubscription(subscriptionId: string): void {
    this.sendNotificationBestEffort('subscription/cancel', {subscriptionId});
  }

  /** Drops (and closes) the local delivery queue for a subscription without sending on the wire. */
  public forgetSubscription(subscriptionId: string): void {
    const queue = this.subscriptions.get(subscriptionId);
    if (queue) {
      queue.close();
      this.subscriptions.delete(subscriptionId);
    }
  }

  public close(): void {
    this.socket.close();
  }

  private sendRequest(id: Wire.RequestId, method: string, params: unknown): void {
    const envelope: JsonRpcRequestEnvelope = {jsonrpc: JSON_RPC_VERSION, id, method, params};
    this.writeFrame(JSON.stringify(envelope));
  }

  private sendNotificationBestEffort(method: string, params: unknown): void {
    try {
      const envelope: JsonRpcNotificationEnvelope = {jsonrpc: JSON_RPC_VERSION, method, params};
      this.writeFrame(JSON.stringify(envelope));
    } catch {
      // Fire-and-forget: the wire contract carries no response for a cancellation notification,
      // so a write failure here (e.g. the socket already closed) is not surfaced to the caller.
    }
  }

  private writeFrame(frame: string): void {
    if (this.socket.readyState !== WEBSOCKET_READY_STATE.OPEN) {
      throw new TransportError('cannot send on a WebSocket that is not open');
    }
    this.socket.send(frame);
  }

  private handleMessage(data: unknown): void {
    let message;
    try {
      message = parseIncomingMessage(typeof data === 'string' ? data : String(data));
    } catch {
      // Malformed frame from the server: nothing to correlate it to, so it is dropped.
      return;
    }

    if (message.kind === 'notification') {
      this.routeNotification(message.method, message.params);
      return;
    }

    const id = message.id;
    if (id === null) return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);

    if (message.kind === 'error') {
      entry.reject(new RpcError(message.error));
      return;
    }

    if (entry.kind === 'unary') {
      entry.resolve(message.result);
      return;
    }

    const subscriptionId = extractSubscriptionId(message.result);
    if (subscriptionId === null) {
      entry.reject(new InvalidResponseError('subscription establishment result carried no subscriptionId'));
      return;
    }
    const queue = new AsyncQueue<SubscriptionDelivery>();
    this.subscriptions.set(subscriptionId, queue);
    entry.resolve({result: message.result, subscriptionId, deliveries: queue});
  }

  private routeNotification(method: string, params: unknown): void {
    if (method === 'event') {
      const subscriptionId = extractSubscriptionId(params);
      if (subscriptionId === null) return;
      this.subscriptions.get(subscriptionId)?.push({kind: 'event', params});
      return;
    }
    if (method !== 'subscription/closed') {
      // Unrecognized notification method: ignore rather than fail the whole connection.
      return;
    }
    const subscriptionId = extractSubscriptionId(params);
    if (subscriptionId === null) return;
    const queue = this.subscriptions.get(subscriptionId);
    if (queue) {
      queue.push({kind: 'closed', params});
      queue.close();
      this.subscriptions.delete(subscriptionId);
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      entry.reject(new TransportError('the WebSocket connection closed'));
    }
    this.pending.clear();
    for (const queue of this.subscriptions.values()) {
      queue.close();
    }
    this.subscriptions.clear();
  }
}
