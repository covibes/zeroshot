import { ClusterClient } from './cluster-client.js';
import { iterateUntilClosed } from './subscription-stream.js';
import {
  WatchSubscriptionClient,
  type WatchEventOrClosed,
  type WatchSubscriptionEventStream,
} from './watch-subscription.js';
import { WebSocketTransport, type WebSocketFactory } from './websocket-transport.js';
import type { WatchParams } from './wire-types.generated.js';

export interface DurableWatchOptions {
  readonly webSocketFactory?: WebSocketFactory;
  readonly subscriptionQueueCapacity?: number;
}

/**
 * Full-socket durable watch: on connection loss, dials a brand-new WebSocket, builds a fresh
 * transport and `ClusterClient` on it, calls `get()` for a coherent snapshot, then re-establishes
 * `watch({ runId, fromCursor: lastDelivered })` — exclusively on that fresh transport, never the
 * dead one. The `(runId, cursor)` dedup set is carried across every reconnect, in-process (this has
 * no direct Rust reference implementation: Rust's own `reconnect` is subscription-level over one
 * still-live transport; the socket-level reconnect this class performs is TypeScript-specific).
 */
export class DurableWatchClient {
  private readonly url: string;
  private readonly options: DurableWatchOptions;
  private transport: WebSocketTransport;
  private stream: WatchSubscriptionEventStream;
  private closing = false;

  private constructor(
    url: string,
    options: DurableWatchOptions,
    transport: WebSocketTransport,
    stream: WatchSubscriptionEventStream
  ) {
    this.url = url;
    this.options = options;
    this.transport = transport;
    this.stream = stream;
  }

  static async connect(
    url: string,
    params: WatchParams,
    options: DurableWatchOptions = {}
  ): Promise<DurableWatchClient> {
    const transport = await WebSocketTransport.connect(url, options);
    const { stream } = await new WatchSubscriptionClient(transport).watch(params);
    return new DurableWatchClient(url, options, transport, stream);
  }

  /**
   * Returns the next logically new event or terminal close. Returns `null` only after an explicit
   * local {@link close}; a mid-stream connection loss triggers exactly one reconnect attempt and
   * transparently resumes instead of surfacing `null`. Reconnect failure propagates as a rejection.
   */
  async next(): Promise<WatchEventOrClosed | null> {
    for (;;) {
      const outcome = await this.stream.next();
      if (outcome !== null) return outcome;
      if (this.closing) return null;
      await this.reconnectFullSocket();
    }
  }

  private async reconnectFullSocket(): Promise<void> {
    const runId = this.stream.currentRunId();
    const fromCursor = this.stream.lastDeliveredCursor();
    const dedup = this.stream.dedupSet();

    const freshTransport = await WebSocketTransport.connect(this.url, this.options);
    await new ClusterClient(freshTransport).get({});
    const { stream } = await new WatchSubscriptionClient(freshTransport).watchWithDedup(
      { runId, fromCursor },
      dedup
    );

    this.transport.close();
    this.transport = freshTransport;
    this.stream = stream;
  }

  /** Cancels the live subscription and closes the connection. Idempotent. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.stream.cancel();
    this.transport.close();
  }

  /** Makes this client directly usable with `for await` — see {@link iterateUntilClosed}. */
  [Symbol.asyncIterator](): AsyncGenerator<WatchEventOrClosed, void, void> {
    return iterateUntilClosed(() => this.next(), () => this.close());
  }
}
