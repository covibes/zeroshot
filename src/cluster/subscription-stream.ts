import { JSON_RPC_VERSION, parseUnaryResponseLine, type JsonRpcRequest, type RequestId } from './envelope.js';
import { InvalidResponseError } from './errors.js';
import { getRecord, getString, isRecord, parseJson } from './json-guards.js';
import type { PumpedResponse } from './multiplexed-transport.js';
import type { SubscriptionCloseReason } from './wire-types.generated.js';

/**
 * What `watch` (via `watch-subscription.ts`) and the cursorless capabilities (`logs`, `agent/attach`,
 * via this module's {@link establishEventSubscription}) need from a transport. Defined here rather
 * than in `watch-subscription.ts` so that module can depend on this one (for
 * {@link iterateUntilClosed}) without a type-level import cycle back the other way.
 */
export interface ClusterSubscriptionTransport {
  sendRequest(serialized: string, id: RequestId): Promise<PumpedResponse>;
  nextWatchRequestId(): RequestId;
  cancelSubscription(subscriptionId: string): Promise<void>;
}

/**
 * Shared "one establishing unary response, then live `event`/`subscription/closed` notifications
 * with no dedup or reconnect" subscription machinery for cursorless capabilities (`logs`,
 * `agent/attach`). Generated once via {@link establishEventSubscription} rather than hand-copied per
 * capability, mirroring crates/openengine-cluster-client/src/ndjson_subscription.rs's
 * `impl_ndjson_event_subscription!` macro. `watch` has different (dedup + reconnect) semantics and
 * is not built on this — see watch-subscription.ts.
 */
export type EventOrClosed<Event> =
  | { readonly type: 'event'; readonly event: Event }
  | { readonly type: 'closed'; readonly reason: SubscriptionCloseReason };

interface EventQueue {
  recv(): Promise<string | null>;
  overflowed: boolean;
}

function parseCursorlessNotification<Event>(
  line: string,
  extractEvent: (params: Record<string, unknown>) => Event
): EventOrClosed<Event> {
  const value: unknown = parseJson(line);
  if (!isRecord(value)) throw new InvalidResponseError('subscription notification is not a JSON object');
  const params = getRecord(value, 'params');
  if (!params) throw new InvalidResponseError('subscription notification missing params');

  if (value.method === 'event') {
    return { type: 'event', event: extractEvent(params) };
  }
  if (value.method === 'subscription/closed') {
    const reason = getString(params, 'reason');
    if (reason !== 'done' && reason !== 'SLOW_CONSUMER') {
      throw new InvalidResponseError(`unexpected subscription close reason: ${String(reason)}`);
    }
    return { type: 'closed', reason };
  }
  throw new InvalidResponseError(`unexpected subscription notification method: ${String(value.method)}`);
}

/**
 * Cancel-once guard shared by every subscription stream (`CursorlessEventStream`,
 * `WatchSubscriptionEventStream`): the first call sends `subscription/cancel`; every later call —
 * including the implicit one from iterator `return()` — is a no-op.
 */
export function createCancelOnce(
  transport: Pick<ClusterSubscriptionTransport, 'cancelSubscription'>,
  subscriptionId: string
): () => Promise<void> {
  let cancelled = false;
  return async () => {
    if (cancelled) return;
    cancelled = true;
    await transport.cancelSubscription(subscriptionId);
  };
}

/**
 * Shared `for await` adapter: wraps a `next()`/`cancel()` pair — as independently implemented by
 * {@link CursorlessEventStream}, `WatchSubscriptionEventStream`, and `DurableWatchClient` — into an
 * `AsyncGenerator`. Breaking out of a `for await` loop (or calling `.return()` on the generator
 * manually) resumes this `finally` block, so leaving the loop early calls `cancel` exactly once;
 * each caller's own `cancel`/`close` is already idempotent, so this works whether cancellation is
 * triggered by the loop or by an explicit call.
 */
export async function* iterateUntilClosed<Outcome extends { readonly type: 'event' | 'closed' }>(
  next: () => Promise<Outcome | null>,
  cancel: () => Promise<void>
): AsyncGenerator<Outcome, void, void> {
  try {
    for (;;) {
      const outcome = await next();
      if (outcome === null) return;
      yield outcome;
      if (outcome.type === 'closed') return;
    }
  } finally {
    await cancel();
  }
}

/** Cursorless event stream: no dedup, no reconnect — `logs`/`agent/attach` have no cursor to resume from. */
export class CursorlessEventStream<Event> {
  private readonly queue: EventQueue;
  private readonly extractEvent: (params: Record<string, unknown>) => Event;
  private readonly cancelOnce: () => Promise<void>;

  constructor(
    transport: ClusterSubscriptionTransport,
    queue: EventQueue,
    subscriptionId: string,
    extractEvent: (params: Record<string, unknown>) => Event
  ) {
    this.queue = queue;
    this.extractEvent = extractEvent;
    this.cancelOnce = createCancelOnce(transport, subscriptionId);
  }

  /** Returns the next live event, a terminal close, or `null` once the channel ends. */
  async next(): Promise<EventOrClosed<Event> | null> {
    const line = await this.queue.recv();
    if (line === null) {
      if (this.queue.overflowed) {
        this.queue.overflowed = false;
        return { type: 'closed', reason: 'SLOW_CONSUMER' };
      }
      return null;
    }
    return parseCursorlessNotification(line, this.extractEvent);
  }

  /** Sends `subscription/cancel`. Idempotent: a second call (or a second `return()`) is a no-op. */
  cancel(): Promise<void> {
    return this.cancelOnce();
  }

  /** Makes this stream directly usable with `for await` — see {@link iterateUntilClosed}. */
  [Symbol.asyncIterator](): AsyncGenerator<EventOrClosed<Event>, void, void> {
    return iterateUntilClosed(() => this.next(), () => this.cancel());
  }
}

export async function establishEventSubscription<Params, Result extends { subscriptionId: string }, Event>(
  transport: ClusterSubscriptionTransport,
  method: string,
  params: Params,
  extractEvent: (params: Record<string, unknown>) => Event
): Promise<{ result: Result; stream: CursorlessEventStream<Event> }> {
  const id = transport.nextWatchRequestId();
  const request: JsonRpcRequest<Params> = { jsonrpc: JSON_RPC_VERSION, id, method, params };
  const response = await transport.sendRequest(JSON.stringify(request), id);
  const result = parseUnaryResponseLine<Result>(response.line, id);
  if (!response.queue) {
    throw new InvalidResponseError(`a successful ${method} response must carry a subscriptionId`);
  }
  const stream = new CursorlessEventStream<Event>(transport, response.queue, result.subscriptionId, extractEvent);
  return { result, stream };
}
