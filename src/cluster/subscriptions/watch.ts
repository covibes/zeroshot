import {isEventNotificationParams, isSubscriptionClosedParams} from '../json-guards.js';
import type {WatchEvent, WatchParams} from '../generated/wire-types.js';
import type {ClusterClient} from '../client.js';
import type {ConnectionMultiplexer, SubscriptionDelivery} from '../transport/multiplexer.js';
import {SubscriptionStream} from './subscription-stream.js';

/** One durably delivered `watch` event, admitted past `(runId, cursor)` de-duplication. */
export interface WatchDeliveredEvent {
  readonly runId: string;
  readonly cursor: string;
  readonly event: WatchEvent;
}

interface WatchStreamInit {
  readonly runId: string | null;
  readonly atCursor: string | null;
  readonly seen: Set<string> | undefined;
}

/**
 * A `watch` subscription: a live, de-duplicated stream of {@link WatchDeliveredEvent}s, with
 * reconnect-from-last-delivered-cursor. Mirrors the Rust `ReconnectingEventStream`
 * (`crates/openengine-cluster-client/src/watch.rs`) `(runId, cursor)` admission set, keyed
 * `${runId}:${cursor}` here since JS has no tuple map key.
 */
export class WatchSubscriptionStream extends SubscriptionStream<WatchDeliveredEvent> {
  private runId: string | null;
  private readonly establishedAtCursor: string | null;
  private readonly seen: Set<string>;
  private lastDelivered: string | null = null;

  public constructor(
    subscriptionId: string,
    transport: ConnectionMultiplexer,
    deliveries: AsyncIterable<SubscriptionDelivery>,
    init: WatchStreamInit
  ) {
    super(subscriptionId, transport, deliveries);
    this.runId = init.runId;
    this.establishedAtCursor = init.atCursor;
    this.seen = init.seen ? new Set(init.seen) : new Set();
  }

  /** The run this subscription is (or, if still parked, will be) attached to. */
  public get currentRunId(): string | null {
    return this.runId;
  }

  /** The cursor of the last event this stream actually admitted (yielded), if any. */
  public get lastDeliveredCursor(): string | null {
    return this.lastDelivered;
  }

  protected override parseEvent(params: unknown): WatchDeliveredEvent | null {
    if (!isEventNotificationParams(params)) return null;
    const key = `${params.runId}:${params.cursor}`;
    if (this.seen.has(key)) return null; // at-least-once physical redelivery; already admitted
    this.seen.add(key);
    this.runId = params.runId;
    this.lastDelivered = params.cursor;
    return {runId: params.runId, cursor: params.cursor, event: params.event};
  }

  protected override parseClosedReason(params: unknown): string | null {
    if (!isSubscriptionClosedParams(params)) return null;
    if (params.lastDeliveredCursor) this.lastDelivered = params.lastDeliveredCursor;
    return params.reason;
  }

  /**
   * Re-establishes this watch through `freshClient`'s OWN transport -- never this stream's transport,
   * which is presumed closed/dead. This is the direct fix for the PR#799 finding: the prior
   * implementation called `establishWatch(this.transport, ...)`, replaying through the stale
   * connection instead of the fresh one.
   *
   * Replays from the last event this stream actually admitted (`lastDeliveredCursor`), or, if this
   * stream never admitted one, from the coherent tail cursor `atCursor` captured at ITS OWN
   * establishment (`watch.md`: "`atCursor` is the coherent tail cursor captured at subscription
   * establishment") -- never re-parks at "now", which would silently skip everything emitted while
   * disconnected. `watch({runId, fromCursor})`'s server-side snapshot-tail handoff is by itself
   * gap-free per `watch.md`, so no separate `get()` call is needed first. The `(runId, cursor)`
   * dedup set carries over, so a boundary event redelivered by the replay is suppressed once, not
   * yielded twice.
   */
  public reconnect(freshClient: ClusterClient): Promise<WatchSubscriptionStream> {
    const freshTransport = freshClient.getTransport();
    const fromCursor = this.lastDelivered ?? this.establishedAtCursor;
    return establishWatch(freshTransport, {runId: this.runId, fromCursor}, this.seen);
  }
}

/** Establishes a new `watch` subscription and wraps it as a {@link WatchSubscriptionStream}. */
export async function establishWatch(
  transport: ConnectionMultiplexer,
  params: WatchParams,
  seen?: Set<string>,
  signal?: AbortSignal
): Promise<WatchSubscriptionStream> {
  const opened = await transport.openSubscription('watch', params, signal);
  return new WatchSubscriptionStream(opened.subscriptionId, transport, opened.deliveries, {
    runId: opened.result.runId ?? params.runId ?? null,
    atCursor: opened.result.atCursor ?? params.fromCursor ?? null,
    seen,
  });
}
