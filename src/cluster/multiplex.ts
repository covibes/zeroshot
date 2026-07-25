/**
 * Shared request/subscription demultiplexing machinery, mirroring
 * crates/openengine-cluster-client/src/{multiplex.rs,ndjson_pump.rs}. A single
 * {@link MultiplexedTransport} is driven by exactly one wire binding
 * ({@link ../cluster/websocket-transport.js}) in this package, but is itself written generically
 * against a {@link FrameSink} plus fed frames so an alternate binding could reuse it unchanged.
 */

import type { RequestId } from './generated/wire-types.js';
import { getString, isRecord } from './json-guards.js';
import {
  BoundedChannel,
  extractRequestId,
  JSON_RPC_VERSION,
  TransportError,
  type JsonRpcNotificationEnvelope,
  type OverflowFlag,
  type PumpedSubscription,
  type SubscriptionTransport,
} from './transport.js';

/** Bounded per-subscription local buffer of raw notification lines awaiting delivery, matching
 * the server's `serve_ndjson`/`serve_websocket` bound in crates/openengine-cluster-client/src/
 * lib.rs (`SUBSCRIPTION_QUEUE_CAPACITY`). */
export const SUBSCRIPTION_QUEUE_CAPACITY = 1024;

/** Abstraction over "write one already-serialized JSON-RPC frame to the peer" -- implemented
 * once per wire transport (only {@link ../cluster/websocket-transport.js WebSocketFrameSink} in
 * this package) so the demultiplexing logic below is implemented exactly once regardless of
 * frame shape. Mirrors `multiplex::FrameSink`. */
export interface FrameSink {
  sendFrame(frame: string): Promise<void>;
}

interface Deferred<T> {
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): { promise: Promise<T> } & Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface PumpedResponse {
  line: string;
  subscription?: PumpedSubscription;
}

interface SubscriptionRegistration {
  channel: BoundedChannel<string>;
  overflowed: OverflowFlag;
}

type PendingMap = Map<RequestId, Deferred<PumpedResponse>>;
type SubscriptionMap = Map<string, SubscriptionRegistration>;

/** Best-effort coercion of an unknown `id` field into a {@link RequestId}, mirroring
 * `RequestId::from_json_value`: only a string or a finite number counts as a resolvable id;
 * anything else (missing, `null`, object, array) yields `undefined` so the caller drops the
 * frame instead of throwing on peer-controlled input. */
// eslint-disable-next-line sonarjs/function-return-type -- RequestId is `string | number` by design (mirrors Rust's `enum RequestId`).
function coerceResponseId(id: unknown): RequestId | undefined {
  if (typeof id === 'string') {
    return id;
  }
  if (typeof id === 'number' && Number.isFinite(id)) {
    return id;
  }
  return undefined;
}

/** Forwards one `event`/`subscription/closed` notification without waiting on a consumer.
 * Returns the subscription id when the local channel is full and the server must be cancelled.
 * Mirrors `ndjson_pump::forward_notification`. */
function forwardNotification(
  value: Record<string, unknown>,
  line: string,
  subscriptions: SubscriptionMap
): string | undefined {
  const params = isRecord(value.params) ? value.params : undefined;
  const subscriptionId = params ? getString(params, 'subscriptionId') : undefined;
  if (subscriptionId === undefined) {
    return undefined;
  }
  const terminal = value.method === 'subscription/closed';
  const registration = subscriptions.get(subscriptionId);
  if (!registration) {
    return undefined;
  }
  if (registration.channel.trySend(line)) {
    if (terminal) {
      subscriptions.delete(subscriptionId);
    }
    return undefined;
  }
  registration.overflowed.value = true;
  subscriptions.delete(subscriptionId);
  return terminal ? undefined : subscriptionId;
}

/** Decodes and routes one pumped frame: a notification is forwarded live (see
 * {@link forwardNotification}); a unary response resolves its pending deferred, registering a
 * freshly minted subscription's channel first when the response is a successful
 * subscription-establishing result carrying `result.subscriptionId` -- so no `event` racing the
 * response can be missed. Malformed JSON, a notification/response with no resolvable identity, or
 * an unknown/already-resolved request id are silently dropped. Mirrors
 * `ndjson_pump::route_pumped_message`. */
function routePumpedMessage(
  line: string,
  pending: PendingMap,
  subscriptions: SubscriptionMap
): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.method === 'string') {
    return forwardNotification(value, line, subscriptions);
  }
  const id = coerceResponseId(value.id);
  if (id === undefined) {
    return undefined;
  }
  const deferred = pending.get(id);
  if (!deferred) {
    return undefined;
  }
  pending.delete(id);

  const result = isRecord(value.result) ? value.result : undefined;
  const resultSubscriptionId = result ? getString(result, 'subscriptionId') : undefined;
  let subscription: PumpedSubscription | undefined;
  if (resultSubscriptionId !== undefined) {
    const channel = new BoundedChannel<string>(SUBSCRIPTION_QUEUE_CAPACITY);
    const overflowed: OverflowFlag = { value: false };
    subscriptions.set(resultSubscriptionId, { channel, overflowed });
    subscription = { channel, overflowed };
  }
  deferred.resolve(subscription === undefined ? { line } : { line, subscription });
  return undefined;
}

/** Fails every still-pending request and ends every open subscription channel once the pump's
 * read half ends -- mirrors `multiplex::finish_pump`. */
function finishPump(pending: PendingMap, subscriptions: SubscriptionMap): void {
  for (const deferred of pending.values()) {
    deferred.reject(new TransportError('server closed the connection before responding'));
  }
  pending.clear();
  for (const registration of subscriptions.values()) {
    registration.channel.close();
  }
  subscriptions.clear();
}

/** Registers `id` as pending, writes `request`, and awaits its demultiplexed response. Mirrors
 * `multiplex::send_request`. */
async function sendRequest(
  sink: FrameSink,
  pending: PendingMap,
  request: string,
  id: RequestId
): Promise<PumpedResponse> {
  if (pending.has(id)) {
    throw new TransportError(`request id is already pending: ${JSON.stringify(id)}`);
  }
  const deferred = createDeferred<PumpedResponse>();
  pending.set(id, deferred);
  try {
    await sink.sendFrame(request);
  } catch (error) {
    pending.delete(id);
    throw error instanceof TransportError ? error : new TransportError(String(error), { cause: error });
  }
  return deferred.promise;
}

async function cancelSubscriptionFrame(sink: FrameSink, subscriptionId: string): Promise<void> {
  const notification: JsonRpcNotificationEnvelope<'subscription/cancel', { subscriptionId: string }> = {
    jsonrpc: JSON_RPC_VERSION,
    method: 'subscription/cancel',
    params: { subscriptionId },
  };
  await sink.sendFrame(JSON.stringify(notification));
}

async function cancelRequestFrame(sink: FrameSink, id: RequestId): Promise<void> {
  const notification: JsonRpcNotificationEnvelope<'$/cancelRequest', { id: RequestId }> = {
    jsonrpc: JSON_RPC_VERSION,
    method: '$/cancelRequest',
    params: { id },
  };
  await sink.sendFrame(JSON.stringify(notification));
}

/** Routes one decoded frame and, if it named a subscription whose local channel has overflowed,
 * best-effort sends its cancellation. Mirrors `multiplex::route_and_maybe_cancel`. */
async function routeAndMaybeCancel(
  line: string,
  pending: PendingMap,
  subscriptions: SubscriptionMap,
  sink: FrameSink
): Promise<void> {
  const subscriptionId = routePumpedMessage(line, pending, subscriptions);
  if (subscriptionId !== undefined) {
    try {
      await cancelSubscriptionFrame(sink, subscriptionId);
    } catch {
      // Best-effort: mirrors `let _ = cancel_subscription(...).await` in multiplex.rs.
    }
  }
}

/**
 * Owns one connection's demultiplexing state -- write sink, pending-request map, subscription
 * registry, and per-connection watch-id counter -- and implements
 * {@link SubscriptionTransport} against it exactly once. A wire binding constructs one of these
 * from its {@link FrameSink} and feeds it every inbound frame via {@link routeIncomingFrame},
 * calling {@link endStream} once when its read half ends. Mirrors `multiplex::
 * MultiplexedTransport`, folded together with the pump-loop wiring `NdjsonTransport`/
 * `WebSocketTransport` each did by hand in Rust, since this package has only one wire binding.
 */
export class MultiplexedTransport implements SubscriptionTransport {
  private readonly sink: FrameSink;
  private readonly pending: PendingMap = new Map();
  private readonly subscriptions: SubscriptionMap = new Map();
  private nextWatchId = 1;

  constructor(sink: FrameSink) {
    this.sink = sink;
  }

  async request(request: string): Promise<string> {
    const id = extractRequestId(request);
    const response = await sendRequest(this.sink, this.pending, request, id);
    return response.line;
  }

  openSubscription(
    request: string,
    id: RequestId
  ): Promise<{ line: string; subscription?: PumpedSubscription }> {
    return sendRequest(this.sink, this.pending, request, id);
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    await cancelSubscriptionFrame(this.sink, subscriptionId);
  }

  async cancelRequest(id: RequestId): Promise<void> {
    await cancelRequestFrame(this.sink, id);
  }

  // eslint-disable-next-line sonarjs/function-return-type -- RequestId is `string | number` by design (mirrors Rust's `enum RequestId`).
  nextWatchRequestId(): RequestId {
    return `watch-${this.nextWatchId++}`;
  }

  /** Feeds one inbound frame (a WebSocket text message) to the demultiplexer. Fire-and-forget
   * from the caller's perspective, matching the pump loop's `await` on
   * `route_and_maybe_cancel` in Rust -- ordering across frames is still preserved because this
   * package's WebSocket binding awaits each call before processing the next `message` event. */
  async routeIncomingFrame(line: string): Promise<void> {
    await routeAndMaybeCancel(line, this.pending, this.subscriptions, this.sink);
  }

  /** Ends the pump: fails every pending request and closes every open subscription channel.
   * Mirrors `multiplex::finish_pump`, called once the WebSocket connection closes. */
  endStream(): void {
    finishPump(this.pending, this.subscriptions);
  }
}
