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
  private reconnecting: Promise<void> | null = null;

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
      await this.sharedReconnect();
      if (this.closing) return null;
    }
  }

  /**
   * Ensures concurrent `next()` callers observing a disconnected stream share exactly one in-flight
   * reconnect attempt rather than each dialing their own fresh socket.
   */
  private sharedReconnect(): Promise<void> {
    if (!this.reconnecting) {
      this.reconnecting = this.reconnectFullSocket().finally(() => {
        this.reconnecting = null;
      });
    }
    return this.reconnecting;
  }

  /**
   * Dials a fresh socket, fetches a coherent snapshot, and re-establishes the watch — entirely on
   * the fresh transport. `close()` racing any phase of this (post-connect, post-get,
   * post-watch-establish) wins: the fresh transport (and any subscription already established on it)
   * is closed/cancelled and never installed as the live transport/stream.
   */
  private async reconnectFullSocket(): Promise<void> {
    const runId = this.stream.currentRunId();
    const fromCursor = this.stream.lastDeliveredCursor();
    const dedup = this.stream.dedupSet();

    let freshTransport: WebSocketTransport | null = null;
    try {
      freshTransport = await WebSocketTransport.connect(this.url, this.options);
      if (this.closing) return;

      await new ClusterClient(freshTransport).get({});
      if (this.closing) return;

      const { stream } = await new WatchSubscriptionClient(freshTransport).watchWithDedup(
        { runId, fromCursor },
        dedup
      );
      if (this.closing) {
        await stream.cancel();
        return;
      }

      this.transport.close();
      this.transport = freshTransport;
      this.stream = stream;
      freshTransport = null;
    } finally {
      freshTransport?.close();
    }
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
