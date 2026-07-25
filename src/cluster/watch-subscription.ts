import { JSON_RPC_VERSION, parseUnaryResponseLine, type JsonRpcRequest, type RequestId } from './envelope.js';
import { InvalidResponseError } from './errors.js';
import { getRecord, getString, isRecord, parseJson } from './json-guards.js';
import { iterateUntilClosed, type ClusterSubscriptionTransport } from './subscription-stream.js';
import type { SubscriptionCloseReason, WatchEvent, WatchParams, WatchResult } from './wire-types.generated.js';

export type WatchEventOrClosed =
  | { readonly type: 'event'; readonly runId: string; readonly cursor: string; readonly event: WatchEvent }
  | {
      readonly type: 'closed';
      readonly reason: SubscriptionCloseReason;
      readonly lastDeliveredCursor: string | null;
    };

/** Deduplicates durable events by `(runId, cursor)`, mirroring `HashSet<(RunId, Cursor)>` in Rust. */
export class RunCursorDedupSet {
  private readonly seenCursorsByRunId = new Map<string, Set<string>>();

  /** Returns `true` the first time this pair is seen, `false` for a legal redelivery to drop. */
  admit(runId: string, cursor: string): boolean {
    let cursors = this.seenCursorsByRunId.get(runId);
    if (!cursors) {
      cursors = new Set();
      this.seenCursorsByRunId.set(runId, cursors);
    }
    if (cursors.has(cursor)) return false;
    cursors.add(cursor);
    return true;
  }
}

function parseWatchResponse(line: string, expectedId: RequestId): WatchResult {
  return parseUnaryResponseLine<WatchResult>(line, expectedId);
}

function parseWatchNotification(line: string): WatchEventOrClosed {
  const value: unknown = parseJson(line);
  if (!isRecord(value)) throw new InvalidResponseError('subscription notification is not a JSON object');
  const method = value.method;
  const params = getRecord(value, 'params');
  if (!params) throw new InvalidResponseError('subscription notification missing params');

  if (method === 'event') {
    const runId = getString(params, 'runId');
    const cursor = getString(params, 'cursor');
    const event = params.event;
    if (runId === null || cursor === null || !isRecord(event)) {
      throw new InvalidResponseError('event notification missing runId/cursor/event');
    }
    // Trust the wire boundary for the event's variant shape, same as every other generated wire
    // type at this transport layer — see envelope.ts's parseUnaryResponseLine.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return { type: 'event', runId, cursor, event: event as unknown as WatchEvent };
  }
  if (method === 'subscription/closed') {
    const reason = getString(params, 'reason');
    if (reason !== 'done' && reason !== 'SLOW_CONSUMER') {
      throw new InvalidResponseError(`unexpected subscription close reason: ${String(reason)}`);
    }
    return { type: 'closed', reason, lastDeliveredCursor: getString(params, 'lastDeliveredCursor') };
  }
  throw new InvalidResponseError(`unexpected subscription notification method: ${String(method)}`);
}

interface WatchStreamQueue {
  recv(): Promise<string | null>;
  overflowed: boolean;
}

interface WatchSubscriptionEventStreamInit {
  readonly transport: ClusterSubscriptionTransport;
  readonly queue: WatchStreamQueue;
  readonly subscriptionId: string;
  readonly dedup: RunCursorDedupSet;
  readonly lastDelivered: string | null;
  readonly runId: string | null;
}

/**
 * Deduplicates durable events by `(runId, cursor)` across legal at-least-once physical redelivery
 * and across subscription-level reconnect (a fresh `watch` over the same live transport). Mirrors
 * crates/openengine-cluster-client/src/ndjson_watch.rs's `WatchSubscriptionEventStream`.
 */
export class WatchSubscriptionEventStream {
  private readonly transport: ClusterSubscriptionTransport;
  private readonly queue: WatchStreamQueue;
  private readonly subscriptionId: string;
  private readonly dedup: RunCursorDedupSet;
  private lastDelivered: string | null;
  private runId: string | null;
  private cancelled = false;

  constructor(init: WatchSubscriptionEventStreamInit) {
    this.transport = init.transport;
    this.queue = init.queue;
    this.subscriptionId = init.subscriptionId;
    this.dedup = init.dedup;
    this.lastDelivered = init.lastDelivered;
    this.runId = init.runId;
  }

  /** @internal exposes the dedup set so `DurableWatchClient` can carry it across a full-socket reconnect. */
  dedupSet(): RunCursorDedupSet {
    return this.dedup;
  }

  lastDeliveredCursor(): string | null {
    return this.lastDelivered;
  }

  currentRunId(): string | null {
    return this.runId;
  }

  /** Returns the next logically new event, dropping legal duplicates, or a terminal close/`null`. */
  async next(): Promise<WatchEventOrClosed | null> {
    for (;;) {
      const line = await this.queue.recv();
      if (line === null) {
        if (this.queue.overflowed) {
          this.queue.overflowed = false;
          return { type: 'closed', reason: 'SLOW_CONSUMER', lastDeliveredCursor: this.lastDelivered };
        }
        return null;
      }
      const parsed = parseWatchNotification(line);
      if (parsed.type === 'closed') {
        if (parsed.lastDeliveredCursor !== null) this.lastDelivered = parsed.lastDeliveredCursor;
        return parsed;
      }
      this.runId ??= parsed.runId;
      if (!this.dedup.admit(parsed.runId, parsed.cursor)) continue;
      this.lastDelivered = parsed.cursor;
      return parsed;
    }
  }

  /** Sends `subscription/cancel`. Idempotent: a second call is a no-op. */
  async cancel(): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    await this.transport.cancelSubscription(this.subscriptionId);
  }

  /** Makes this stream directly usable with `for await` — see {@link iterateUntilClosed}. */
  [Symbol.asyncIterator](): AsyncGenerator<WatchEventOrClosed, void, void> {
    return iterateUntilClosed(() => this.next(), () => this.cancel());
  }

  /**
   * Re-establishes a subscription from this stream's last delivered cursor on the same run, over the
   * SAME live transport (subscription-level reconnect — distinct from `DurableWatchClient`'s
   * full-socket reconnect). The dedup set survives, so a duplicate delivered before and after
   * reconnect is still suppressed once.
   */
  reconnect(): Promise<{ result: WatchResult; stream: WatchSubscriptionEventStream }> {
    return establishWatch(this.transport, { runId: this.runId, fromCursor: this.lastDelivered }, this.dedup);
  }
}

/**
 * Establishes one `watch` subscription and wraps its response/queue into a
 * {@link WatchSubscriptionEventStream} carrying `dedup`. Shared by `WatchSubscriptionClient.watch`/
 * `watchWithDedup` and `WatchSubscriptionEventStream.reconnect` so the latter never needs to
 * reference the `WatchSubscriptionClient` class itself.
 */
async function establishWatch(
  transport: ClusterSubscriptionTransport,
  params: WatchParams,
  dedup: RunCursorDedupSet
): Promise<{ result: WatchResult; stream: WatchSubscriptionEventStream }> {
  const id = transport.nextWatchRequestId();
  const request: JsonRpcRequest<WatchParams> = {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method: 'watch',
    params,
  };
  const response = await transport.sendRequest(JSON.stringify(request), id);
  const result = parseWatchResponse(response.line, id);
  if (!response.queue) {
    throw new InvalidResponseError('a successful watch response must carry a subscriptionId');
  }
  const stream = new WatchSubscriptionEventStream({
    transport,
    queue: response.queue,
    subscriptionId: result.subscriptionId,
    dedup,
    lastDelivered: params.fromCursor ?? null,
    runId: result.runId ?? null,
  });
  return { result, stream };
}

/**
 * Typed watch subscription client. Mirrors
 * crates/openengine-cluster-client/src/ndjson_watch.rs's `WatchSubscriptionClient`: request ids come
 * from the shared transport (`transport.nextWatchRequestId()`), never a client-local counter.
 */
export class WatchSubscriptionClient {
  private readonly transport: ClusterSubscriptionTransport;

  constructor(transport: ClusterSubscriptionTransport) {
    this.transport = transport;
  }

  watch(params: WatchParams): Promise<{ result: WatchResult; stream: WatchSubscriptionEventStream }> {
    return establishWatch(this.transport, params, new RunCursorDedupSet());
  }

  /** Re-establishes a watch carrying an existing dedup set — used by {@link WatchSubscriptionEventStream.reconnect}. */
  watchWithDedup(
    params: WatchParams,
    dedup: RunCursorDedupSet
  ): Promise<{ result: WatchResult; stream: WatchSubscriptionEventStream }> {
    return establishWatch(this.transport, params, dedup);
  }
}
