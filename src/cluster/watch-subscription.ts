/**
 * Typed `watch` subscription client with client-side `(runId, cursor)` dedup and reconnect.
 * Bespoke rather than built on {@link ./event-subscription.js} -- matching Rust's separate
 * `watch.rs`/`ndjson_watch.rs` rather than the `impl_ndjson_event_subscription!` macro `logs`/
 * `agent/attach` share -- because `watch` alone durably dedups and reconnects.
 *
 * `reconnect()` deliberately differs from `WatchSubscriptionEventStream::reconnect` in
 * crates/openengine-cluster-client/src/ndjson_watch.rs, which simply re-issues `watch` on the
 * *same, still-open* connection. A WebSocket reconnect in this package means the previous
 * connection is gone and a fresh one has been dialed, so `reconnect()` first calls
 * {@link ClusterClient.get} for a coherent snapshot at the last delivered cursor before
 * re-subscribing from it -- avoiding a silent gap for whatever happened while disconnected. The
 * dedup set still carries forward across the boundary, so a duplicate delivered before and after
 * reconnect is still suppressed exactly once.
 */

import type { ClusterClient } from './cluster-client.js';
import { parseJsonRpcResponse } from './cluster-client.js';
import { ClusterInvalidResponseError, toClusterClientError } from './errors.js';
import { isRecord } from './json-guards.js';
import type { SubscriptionCloseReason, WatchEvent, WatchParams, WatchResult } from './generated/wire-types.js';
import {
  JSON_RPC_VERSION,
  type BoundedChannel,
  type JsonRpcRequestEnvelope,
  type OverflowFlag,
  type SubscriptionTransport,
} from './transport.js';

/** One item observed by a {@link WatchSubscriptionStream}: a durable public event not yet seen by
 * this stream, or a terminal close. Mirrors `EventOrClosed` (crates/openengine-cluster-client/
 * src/watch.rs), flattening `PublicEventRecord` into the event variant. */
export type WatchEventOrClosed =
  | { readonly kind: 'event'; readonly runId: string; readonly cursor: string; readonly event: WatchEvent }
  | {
      readonly kind: 'closed';
      readonly reason: SubscriptionCloseReason;
      readonly lastDeliveredCursor: string | null;
    };

export interface WatchSubscriptionStream
  extends AsyncIterator<WatchEventOrClosed, undefined, undefined>,
    AsyncIterable<WatchEventOrClosed> {
  cancel(): Promise<void>;
  lastDeliveredCursor(): string | null;
  /** Re-establishes a subscription from this stream's last delivered cursor, after a coherent
   * `get()` snapshot. See the module doc comment for why this differs from Rust's `reconnect`. */
  reconnect(clusterClient: ClusterClient): Promise<{ result: WatchResult; stream: WatchSubscriptionStream }>;
}

function parseWatchNotificationLine(line: string): WatchEventOrClosed {
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
    const runId = params?.runId;
    const cursor = params?.cursor;
    const event = params?.event;
    if (typeof runId !== 'string' || typeof cursor !== 'string' || event === undefined) {
      throw new ClusterInvalidResponseError('event notification missing runId/cursor/event');
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- deserialization trust boundary, matching Rust's `serde_json::from_value`.
    return { kind: 'event', runId, cursor, event: event as WatchEvent };
  }
  if (value.method === 'subscription/closed') {
    const reason = params?.reason;
    if (reason !== 'done' && reason !== 'SLOW_CONSUMER') {
      throw new ClusterInvalidResponseError('subscription/closed notification missing a valid "reason"');
    }
    const lastDeliveredCursor = params?.lastDeliveredCursor;
    return {
      kind: 'closed',
      reason,
      lastDeliveredCursor: typeof lastDeliveredCursor === 'string' ? lastDeliveredCursor : null,
    };
  }
  throw new ClusterInvalidResponseError(
    `unexpected subscription notification method ${JSON.stringify(value.method)}`
  );
}

interface WatchSubscriptionStreamInit {
  transport: SubscriptionTransport;
  subscriptionId: string;
  channel: BoundedChannel<string>;
  overflowed: OverflowFlag;
  seen: Set<string>;
  lastDelivered: string | null;
  runId: string | null;
}

class WatchSubscriptionStreamImpl implements WatchSubscriptionStream {
  private cancelled = false;
  private readonly transport: SubscriptionTransport;
  private readonly subscriptionId: string;
  private readonly channel: BoundedChannel<string>;
  private readonly overflowed: OverflowFlag;
  private readonly seen: Set<string>;
  private lastDelivered: string | null;
  private runId: string | null;

  constructor(init: WatchSubscriptionStreamInit) {
    this.transport = init.transport;
    this.subscriptionId = init.subscriptionId;
    this.channel = init.channel;
    this.overflowed = init.overflowed;
    this.seen = init.seen;
    this.lastDelivered = init.lastDelivered;
    this.runId = init.runId;
  }

  [Symbol.asyncIterator](): AsyncIterator<WatchEventOrClosed, undefined, undefined> {
    return this;
  }

  async next(): Promise<IteratorResult<WatchEventOrClosed, undefined>> {
    for (;;) {
      const item = await this.channel.recv();
      if (item.done) {
        if (this.overflowed.value) {
          this.overflowed.value = false;
          return {
            done: false,
            value: { kind: 'closed', reason: 'SLOW_CONSUMER', lastDeliveredCursor: this.lastDelivered },
          };
        }
        return { done: true, value: undefined };
      }

      const parsed = parseWatchNotificationLine(item.value);
      if (parsed.kind === 'closed') {
        if (parsed.lastDeliveredCursor !== null) {
          this.lastDelivered = parsed.lastDeliveredCursor;
        }
        return { done: false, value: parsed };
      }

      this.runId = this.runId ?? parsed.runId;
      const key = `${parsed.runId}:${parsed.cursor}`;
      if (this.seen.has(key)) {
        continue; // legal at-least-once physical duplicate redelivery; drop and keep reading.
      }
      this.seen.add(key);
      this.lastDelivered = parsed.cursor;
      return { done: false, value: parsed };
    }
  }

  async return(): Promise<IteratorResult<WatchEventOrClosed, undefined>> {
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
      // Fire-and-forget: the server silently drops an unknown subscription id.
    }
  }

  lastDeliveredCursor(): string | null {
    return this.lastDelivered;
  }

  async reconnect(
    clusterClient: ClusterClient
  ): Promise<{ result: WatchResult; stream: WatchSubscriptionStream }> {
    const snapshot = await clusterClient.get({ atCursor: this.lastDelivered });
    const params: WatchParams = {
      runId: this.runId,
      fromCursor: snapshot.atCursor ?? this.lastDelivered,
    };
    return establishWatch(this.transport, params, this.seen);
  }
}

async function establishWatch(
  transport: SubscriptionTransport,
  params: WatchParams,
  initialSeen: Set<string>
): Promise<{ result: WatchResult; stream: WatchSubscriptionStream }> {
  const id = transport.nextWatchRequestId();
  const request: JsonRpcRequestEnvelope<'watch', WatchParams> = {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method: 'watch',
    params,
  };

  let established;
  try {
    established = await transport.openSubscription(JSON.stringify(request), id);
  } catch (error) {
    throw toClusterClientError(error);
  }

  const result = parseJsonRpcResponse<WatchResult>(established.line, id);
  if (!established.subscription) {
    throw new ClusterInvalidResponseError('a successful watch response must carry a subscriptionId');
  }

  const stream = new WatchSubscriptionStreamImpl({
    transport,
    subscriptionId: result.subscriptionId,
    channel: established.subscription.channel,
    overflowed: established.subscription.overflowed,
    seen: initialSeen,
    lastDelivered: params.fromCursor ?? null,
    runId: result.runId ?? null,
  });
  return { result, stream };
}

/** Establishes a `watch` subscription. Mirrors `WatchSubscriptionClient::watch`. */
export function watch(
  transport: SubscriptionTransport,
  params: WatchParams = {}
): Promise<{ result: WatchResult; stream: WatchSubscriptionStream }> {
  return establishWatch(transport, params, new Set());
}
