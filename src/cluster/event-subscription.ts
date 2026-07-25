/**
 * Shared {@link SubscriptionTransport}-generic "one unary response, then live `event`/
 * `subscription/closed` notifications with no dedup or reconnect" client machinery, mirroring
 * `impl_ndjson_event_subscription!` (crates/openengine-cluster-client/src/ndjson_subscription.rs)
 * for the two capabilities that use it in this package: `logs` ({@link ./logs-subscription.js})
 * and `agent/attach` ({@link ./agent-attach-subscription.js}). `watch` has different (dedup +
 * reconnect) semantics and is implemented separately in {@link ./watch-subscription.js}.
 */

import { ClusterInvalidResponseError, toClusterClientError } from './errors.js';
import { parseJsonRpcResponse } from './cluster-client.js';
import { isRecord } from './json-guards.js';
import type { SubscriptionCloseReason } from './generated/wire-types.js';
import {
  JSON_RPC_VERSION,
  type JsonRpcRequestEnvelope,
  type PumpedSubscription,
  type SubscriptionTransport,
} from './transport.js';

/** One item observed by an {@link EventSubscriptionStream}: a live event, or a terminal close. */
export type EventOrClosed<TEvent> =
  | { readonly kind: 'event'; readonly event: TEvent }
  | { readonly kind: 'closed'; readonly reason: SubscriptionCloseReason };

export interface EventSubscriptionStream<TEvent>
  extends AsyncIterator<EventOrClosed<TEvent>, undefined, undefined>,
    AsyncIterable<EventOrClosed<TEvent>> {
  /** Sends `subscription/cancel` for this subscription. Idempotent: guarded so it sends exactly
   * once even under concurrent double-cancel, and a no-op after the async iterator's
   * `.return()` has already run. */
  cancel(): Promise<void>;
}

function parseNotificationLine<TEvent>(line: string, eventField: 'record' | 'event'): EventOrClosed<TEvent> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new ClusterInvalidResponseError(error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(value)) {
    throw new ClusterInvalidResponseError('subscription notification must be a JSON object');
  }
  const params = isRecord(value.params) ? value.params : undefined;

  if (value.method === 'event') {
    if (!params || !(eventField in params)) {
      throw new ClusterInvalidResponseError(`event notification missing "${eventField}"`);
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- deserialization trust boundary, matching Rust's `serde_json::from_value`.
    return { kind: 'event', event: params[eventField] as TEvent };
  }
  if (value.method === 'subscription/closed') {
    const reason = params?.reason;
    if (reason !== 'done' && reason !== 'SLOW_CONSUMER') {
      throw new ClusterInvalidResponseError('subscription/closed notification missing a valid "reason"');
    }
    return { kind: 'closed', reason };
  }
  throw new ClusterInvalidResponseError(
    `unexpected subscription notification method ${JSON.stringify(value.method)}`
  );
}

class EventSubscriptionStreamImpl<TEvent> implements EventSubscriptionStream<TEvent> {
  private cancelled = false;

  constructor(
    private readonly transport: SubscriptionTransport,
    private readonly subscriptionId: string,
    private readonly eventField: 'record' | 'event',
    private readonly channel: { recv(): Promise<{ done: true } | { done: false; value: string }> },
    private readonly overflowed: { value: boolean }
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<EventOrClosed<TEvent>, undefined, undefined> {
    return this;
  }

  async next(): Promise<IteratorResult<EventOrClosed<TEvent>, undefined>> {
    const item = await this.channel.recv();
    if (item.done) {
      if (this.overflowed.value) {
        this.overflowed.value = false;
        return { done: false, value: { kind: 'closed', reason: 'SLOW_CONSUMER' } };
      }
      return { done: true, value: undefined };
    }
    return { done: false, value: parseNotificationLine<TEvent>(item.value, this.eventField) };
  }

  async return(): Promise<IteratorResult<EventOrClosed<TEvent>, undefined>> {
    await this.cancel();
    return { done: true, value: undefined };
  }

  async cancel(): Promise<void> {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    try {
      await this.transport.cancelSubscription(this.subscriptionId);
    } catch {
      // Fire-and-forget: mirrors `SubscriptionTransport::cancel_subscription`'s contract -- the
      // server silently drops an unknown subscription id.
    }
  }
}

/**
 * Establishes a subscription for a capability with no dedup/reconnect semantics (`logs`,
 * `agent/attach`) and returns its establishment result plus a live event stream. Mirrors the body
 * of `impl_ndjson_event_subscription!`'s generated `$method_fn`.
 */
export async function createEventSubscription<TMethod extends string, TParams, TResult extends { subscriptionId: string }, TEvent>(
  transport: SubscriptionTransport,
  method: TMethod,
  params: TParams,
  eventField: 'record' | 'event'
): Promise<{ result: TResult; stream: EventSubscriptionStream<TEvent> }> {
  const id = transport.nextWatchRequestId();
  const request: JsonRpcRequestEnvelope<TMethod, TParams> = {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method,
    params,
  };

  let established: { line: string; subscription?: PumpedSubscription };
  try {
    established = await transport.openSubscription(JSON.stringify(request), id);
  } catch (error) {
    throw toClusterClientError(error);
  }

  const result = parseJsonRpcResponse<TResult>(established.line, id);
  if (!established.subscription) {
    throw new ClusterInvalidResponseError(`a successful ${method} response must carry a subscriptionId`);
  }

  const stream = new EventSubscriptionStreamImpl<TEvent>(
    transport,
    result.subscriptionId,
    eventField,
    established.subscription.channel,
    established.subscription.overflowed
  );
  return { result, stream };
}
