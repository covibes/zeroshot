import { JSON_RPC_VERSION, requestIdKey, type JsonRpcNotification, type RequestId } from './envelope.js';
import { ClusterTransportError } from './errors.js';
import { getRecord, getString, isRecord, parseJson } from './json-guards.js';

/** Matches the Rust client/server's `SUBSCRIPTION_QUEUE_CAPACITY` (crates/openengine-cluster-client/src/lib.rs). */
export const SUBSCRIPTION_QUEUE_CAPACITY = 1024;

/** Abstraction over "write one already-serialized JSON-RPC frame to the peer". */
export interface FrameSink {
  sendFrame(frame: string): Promise<void>;
}

/**
 * Bounded per-subscription local buffer of raw notification lines, shared by watch/logs/agent-attach
 * subscription clients. Delivery is non-blocking (`tryPush`) so one abandoned subscription cannot
 * stall the connection's sole response pump — mirrors `tokio::sync::mpsc::channel(1024)` plus the
 * `overflowed: Arc<AtomicBool>` flag read once the channel drains, from
 * crates/openengine-cluster-client/src/ndjson_pump.rs.
 */
export class BoundedSubscriptionQueue {
  private readonly capacity: number;
  private readonly buffer: string[] = [];
  private resolveWaiting: ((line: string | null) => void) | null = null;
  private closed = false;
  overflowed = false;

  constructor(capacity: number = SUBSCRIPTION_QUEUE_CAPACITY) {
    this.capacity = capacity;
  }

  /** Non-blocking; mirrors `mpsc::Sender::try_send`. */
  tryPush(line: string): 'ok' | 'full' | 'closed' {
    if (this.closed) return 'closed';
    if (this.resolveWaiting) {
      const resolve = this.resolveWaiting;
      this.resolveWaiting = null;
      resolve(line);
      return 'ok';
    }
    if (this.buffer.length >= this.capacity) return 'full';
    this.buffer.push(line);
    return 'ok';
  }

  /** Marks local overflow and closes the queue, mirroring the Rust pump's full-channel handling. */
  markOverflowed(): void {
    this.overflowed = true;
    this.end();
  }

  /** Mirrors `mpsc::Receiver::recv() -> Option<String>`: resolves `null` once the channel ends. */
  recv(): Promise<string | null> {
    if (this.buffer.length > 0) return Promise.resolve(this.buffer.shift() ?? null);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.resolveWaiting = resolve;
    });
  }

  /** Ends the channel without marking overflow — mirrors dropping the sender (pump end, cancel). */
  end(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.resolveWaiting) {
      const resolve = this.resolveWaiting;
      this.resolveWaiting = null;
      resolve(null);
    }
  }
}

export interface PumpedResponse {
  readonly line: string;
  readonly queue: BoundedSubscriptionQueue | null;
}

interface PendingEntry {
  resolve(response: PumpedResponse): void;
  reject(error: Error): void;
}

/** @returns the decoded id, or `null` if `value` is not a valid JSON-RPC id shape. */
function extractResponseId(value: unknown): RequestId | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  return null;
}

/**
 * Owns one connection's demultiplexing state: the write sink, the shared pending-unary-response map,
 * the shared subscription-notification map, and the SOLE request-id/watch-id allocators for every
 * caller sharing this transport. Two `ClusterClient`s (or a `ClusterClient` and a subscription
 * client) backed by the same `MultiplexedTransport` therefore can never allocate colliding request
 * ids, unlike a per-client counter — see crates/openengine-cluster-client/src/multiplex.rs, whose
 * demux design this mirrors.
 */
export class MultiplexedTransport {
  private readonly sink: FrameSink;
  private readonly subscriptionQueueCapacity: number;
  private readonly pending = new Map<string, PendingEntry>();
  private readonly subscriptions = new Map<string, BoundedSubscriptionQueue>();
  private requestIdCounter = 1;
  private watchIdCounter = 1;

  constructor(sink: FrameSink, options?: { subscriptionQueueCapacity?: number | undefined }) {
    this.sink = sink;
    this.subscriptionQueueCapacity = options?.subscriptionQueueCapacity ?? SUBSCRIPTION_QUEUE_CAPACITY;
  }

  /**
   * Mints the next unary JSON-RPC request id, shared across every caller of this transport.
   * @returns an integer request id.
   */
  nextRequestId(): RequestId {
    const id = this.requestIdCounter;
    this.requestIdCounter += 1;
    return id;
  }

  /**
   * Mints the next subscription-establishing request id, in the `watch-<n>` shape Rust uses.
   * @returns a `watch-<n>` string request id.
   */
  nextWatchRequestId(): RequestId {
    const id = `watch-${this.watchIdCounter}`;
    this.watchIdCounter += 1;
    return id;
  }

  /**
   * Registers `id` as pending, writes `serialized`, and awaits its demultiplexed response. Shared
   * by unary calls and subscription-establishing calls alike (the caller decides whether to expect
   * `PumpedResponse.queue`). On a `sendFrame` failure the pending entry is synchronously removed
   * before the error propagates, so a closed-transport send never leaks a pending entry.
   */
  async sendRequest(serialized: string, id: RequestId): Promise<PumpedResponse> {
    const key = requestIdKey(id);
    if (this.pending.has(key)) {
      throw new ClusterTransportError(`request id is already pending: ${key}`);
    }
    const responsePromise = new Promise<PumpedResponse>((resolve, reject) => {
      this.pending.set(key, { resolve, reject });
    });
    try {
      await this.sink.sendFrame(serialized);
    } catch (error) {
      this.pending.delete(key);
      throw error instanceof Error ? error : new ClusterTransportError(String(error));
    }
    return responsePromise;
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    const notification: JsonRpcNotification<{ subscriptionId: string }> = {
      jsonrpc: JSON_RPC_VERSION,
      method: 'subscription/cancel',
      params: { subscriptionId },
    };
    await this.sink.sendFrame(JSON.stringify(notification));
  }

  async cancelRequest(id: RequestId): Promise<void> {
    const notification: JsonRpcNotification<{ id: RequestId }> = {
      jsonrpc: JSON_RPC_VERSION,
      method: '$/cancelRequest',
      params: { id },
    };
    await this.sink.sendFrame(JSON.stringify(notification));
  }

  /** Decodes and routes one pumped line. Malformed/unroutable frames are silently dropped. */
  routeIncoming(line: string): void {
    let value: unknown;
    try {
      value = parseJson(line);
    } catch {
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.method === 'string') {
      this.routeNotification(value, line);
      return;
    }
    this.routeResponse(value, line);
  }

  private routeResponse(value: Record<string, unknown>, line: string): void {
    const id = extractResponseId(value.id);
    if (id === null) return;
    const key = requestIdKey(id);
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);

    let queue: BoundedSubscriptionQueue | null = null;
    const result = getRecord(value, 'result');
    const subscriptionId = result ? getString(result, 'subscriptionId') : null;
    if (subscriptionId !== null) {
      queue = new BoundedSubscriptionQueue(this.subscriptionQueueCapacity);
      this.subscriptions.set(subscriptionId, queue);
    }
    pending.resolve({ line, queue });
  }

  /**
   * Forwards one `event`/`subscription/closed` notification without waiting on a consumer. A full
   * or abandoned local queue marks overflow, removes the registration, and — for a non-terminal
   * notification — best-effort cancels the server-side subscription, mirroring
   * crates/openengine-cluster-client/src/ndjson_pump.rs's `forward_notification`.
   */
  private routeNotification(value: Record<string, unknown>, line: string): void {
    const params = getRecord(value, 'params');
    const subscriptionId = params ? getString(params, 'subscriptionId') : null;
    if (subscriptionId === null) return;
    const terminal = value.method === 'subscription/closed';
    const queue = this.subscriptions.get(subscriptionId);
    if (!queue) return;

    const outcome = queue.tryPush(line);
    if (outcome === 'ok') {
      if (terminal) this.subscriptions.delete(subscriptionId);
      return;
    }
    if (outcome === 'full') queue.markOverflowed();
    this.subscriptions.delete(subscriptionId);
    if (!terminal) {
      this.cancelSubscription(subscriptionId).catch(() => {
        // Best-effort: the connection may already be gone.
      });
    }
  }

  /** Fails every still-pending request and ends every open subscription queue. */
  finish(): void {
    for (const entry of this.pending.values()) {
      entry.reject(new ClusterTransportError('connection closed before responding'));
    }
    this.pending.clear();
    for (const queue of this.subscriptions.values()) {
      queue.end();
    }
    this.subscriptions.clear();
  }

  /** Exposed for tests asserting AC4's "pending map is empty after a failed send" invariant. */
  get pendingSize(): number {
    return this.pending.size;
  }
}
