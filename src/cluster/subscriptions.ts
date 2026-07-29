import type { AgentAttachEvent, LogRecord, SubscriptionCloseReason, WatchEvent, WatchParams, WatchResult } from './generated/protocol.js';
import { ClusterProtocolError, ClusterStateError } from './errors.js';
import { Connection } from './connection.js';
import type { SubscriptionRegistration } from './connection.js';
import { isRecord } from './frames.js';
import type { FrameRecord } from './frames.js';
import { assertDefinition } from './validators.js';

export type SubscriptionClosedItem = {
  readonly type: 'closed';
  readonly reason: SubscriptionCloseReason;
};
export type WatchSubscriptionClosedItem = SubscriptionClosedItem & {
  readonly lastDeliveredCursor?: string | null;
};
export type SubscriptionItem<T> = { readonly type: 'event'; readonly event: T } | SubscriptionClosedItem;
export type WatchSubscriptionItem =
  | { readonly type: 'event'; readonly runId: string; readonly cursor: string; readonly event: WatchEvent }
  | WatchSubscriptionClosedItem;
export interface Subscription<T> extends AsyncIterator<SubscriptionItem<T>>, AsyncIterable<SubscriptionItem<T>> {
  readonly subscriptionId: string;
  readonly retainedCount: number;
  cancel(): Promise<void>;
}

type FrameParser<T> = (frame: FrameRecord) => SubscriptionItem<T>;
class SubscriptionStream<T> implements Subscription<T> {
  #done = false;
  constructor(
    protected readonly connection: Connection,
    protected readonly registration: SubscriptionRegistration,
    private readonly parse: FrameParser<T>,
  ) {}
  get subscriptionId(): string { return this.registration.id; }
  get retainedCount(): number { return this.registration.queue.retainedCount; }
  [Symbol.asyncIterator](): this { return this; }
  async next(): Promise<IteratorResult<SubscriptionItem<T>>> {
    if (this.#done) return { done: true, value: undefined };
    const queued = await this.registration.queue.recv();
    if (queued.done) {
      if (this.registration.overflowed) {
        this.registration.overflowed = false; this.#done = true;
        return { done: false, value: { type: 'closed', reason: 'SLOW_CONSUMER' } };
      }
      this.#done = true; return { done: true, value: undefined };
    }
    try {
      const value = this.parse(queued.value);
      if (value.type === 'closed') this.#finishWithoutCancel();
      return { done: false, value };
    } catch (cause) { await this.#terminate(true); throw cause; }
  }
  async return(): Promise<IteratorResult<SubscriptionItem<T>>> {
    await this.#terminate(true); return { done: true, value: undefined };
  }
  async throw(error?: unknown): Promise<IteratorResult<SubscriptionItem<T>>> {
    await this.#terminate(true); throw error;
  }
  cancel(): Promise<void> { return this.#terminate(true); }
  async #terminate(sendCancel: boolean): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    this.connection.unregisterSubscription(this.registration.id, this.registration);
    this.registration.queue.closeAndDiscard();
    if (sendCancel) {
      try { await this.connection.cancelSubscription(this.registration); }
      catch (error) { this.connection.recordDiagnostic(error); }
    }
  }
  #finishWithoutCancel(): void {
    if (this.#done) return;
    this.#done = true;
    this.connection.unregisterSubscription(this.registration.id, this.registration);
    this.registration.queue.closeAndDiscard();
  }
}

function parseCursorlessClosed(params: FrameRecord, definition: string): SubscriptionClosedItem {
  assertDefinition(definition, params);
  return { type: 'closed', reason: params.reason as SubscriptionCloseReason };
}
function parseWatchClosed(params: FrameRecord): WatchSubscriptionClosedItem {
  assertDefinition('SubscriptionClosedNotification', params);
  const cursor = params.lastDeliveredCursor as string | null | undefined;
  return {
    type: 'closed',
    reason: params.reason as SubscriptionCloseReason,
    ...(cursor === undefined ? {} : { lastDeliveredCursor: cursor }),
  };
}
function subscriptionParser<T>(
  field: string,
  eventDefinition: string,
  closedDefinition: string,
): FrameParser<T> {
  return (frame) => {
    if (!isRecord(frame.params)) {
      throw new ClusterProtocolError('notification params are missing', 'INVALID_SUBSCRIPTION_EVENT');
    }
    if (frame.method === 'subscription/closed') {
      return parseCursorlessClosed(frame.params, closedDefinition);
    }
    if (frame.method !== 'event') {
      throw new ClusterProtocolError('malformed subscription event', 'INVALID_SUBSCRIPTION_EVENT');
    }
    assertDefinition(eventDefinition, frame.params);
    return { type: 'event', event: frame.params[field] as T };
  };
}

export class LogsSubscriptionStream extends SubscriptionStream<LogRecord> {
  constructor(connection: Connection, registration: SubscriptionRegistration) {
    super(connection, registration, subscriptionParser('record', 'LogEventNotification', 'LogsClosedNotification'));
  }
}
export class AgentAttachSubscriptionStream extends SubscriptionStream<AgentAttachEvent> {
  constructor(connection: Connection, registration: SubscriptionRegistration) {
    super(connection, registration, subscriptionParser('event', 'AgentAttachEventNotification', 'AgentAttachClosedNotification'));
  }
}

type WatchStreamInit = {
  readonly connection: Connection;
  readonly registration: SubscriptionRegistration;
  readonly result: WatchResult;
  readonly params: WatchParams;
  readonly lastSeenRunId?: string;
  readonly lastSeenCursor?: string;
};
export class WatchSubscriptionStream implements AsyncIterator<WatchSubscriptionItem>, AsyncIterable<WatchSubscriptionItem> {
  readonly #connection: Connection;
  readonly #registration: SubscriptionRegistration;
  #lastSeenRunId: string | undefined;
  #lastSeenCursor: string | undefined;
  #lastDelivered: string | null | undefined;
  #runId: string | null | undefined;
  #done = false;
  #reconnectConsumed = false;
  #readBarrier: Promise<void> = Promise.resolve();
  constructor(init: WatchStreamInit) {
    this.#connection = init.connection;
    this.#registration = init.registration;
    this.#lastSeenRunId = init.lastSeenRunId;
    this.#lastSeenCursor = init.lastSeenCursor;
    this.#lastDelivered = init.params.fromCursor;
    this.#runId = init.result.runId ?? init.params.runId;
  }
  get subscriptionId(): string { return this.#registration.id; }
  get retainedCount(): number { return this.#registration.queue.retainedCount; }
  get lastDeliveredCursor(): string | null | undefined { return this.#lastDelivered; }
  [Symbol.asyncIterator](): this { return this; }
  next(): Promise<IteratorResult<WatchSubscriptionItem>> {
    const read = this.#readBarrier.then(() => this.#nextLogical());
    this.#readBarrier = read.then(() => undefined, () => undefined);
    return read;
  }
  async #nextLogical(): Promise<IteratorResult<WatchSubscriptionItem>> {
    while (!this.#done) {
      const queued = await this.#registration.queue.recv();
      if (queued.done) return this.#finishQueue();
      const item = await this.#decode(queued.value);
      if (item) return { done: false, value: item };
    }
    return { done: true, value: undefined };
  }
  #finishQueue(): IteratorResult<WatchSubscriptionItem> {
    this.#done = true;
    if (!this.#registration.overflowed) return { done: true, value: undefined };
    this.#registration.overflowed = false;
    const cursor = this.#lastDelivered;
    return {
      done: false,
      value: { type: 'closed', reason: 'SLOW_CONSUMER', ...(cursor === undefined ? {} : { lastDeliveredCursor: cursor }) },
    };
  }
  async #decode(frame: FrameRecord): Promise<WatchSubscriptionItem | undefined> {
    if (!isRecord(frame.params)) return this.#invalid('notification params are missing');
    if (frame.method === 'subscription/closed') {
      const closed = parseWatchClosed(frame.params);
      if (closed.lastDeliveredCursor !== undefined) this.#lastDelivered = closed.lastDeliveredCursor;
      this.#finishWithoutCancel(); return closed;
    }
    if (frame.method !== 'event') return this.#invalid('malformed watch event');
    try { assertDefinition('EventNotification', frame.params); }
    catch { return this.#invalid('malformed watch event'); }
    const { runId, cursor, event } = frame.params as {
      readonly runId: string; readonly cursor: string; readonly event: WatchEvent;
    };
    if (this.#lastSeenRunId === runId && this.#lastSeenCursor === cursor) return undefined;
    this.#lastSeenRunId = runId; this.#lastSeenCursor = cursor;
    this.#runId = runId; this.#lastDelivered = cursor;
    return { type: 'event', runId, cursor, event };
  }
  async return(): Promise<IteratorResult<WatchSubscriptionItem>> {
    await this.#terminate(true); return { done: true, value: undefined };
  }
  async throw(error?: unknown): Promise<IteratorResult<WatchSubscriptionItem>> {
    await this.#terminate(true); throw error;
  }
  cancel(): Promise<void> { return this.#terminate(true); }
  reconnect(freshConnection: Connection): Promise<import('./client.js').WatchSubscription> {
    if (this.#reconnectConsumed) {
      throw new ClusterStateError('watch stream reconnect is one-shot', 'RECONNECT_CONSUMED');
    }
    this.#reconnectConsumed = true; return this.#reconnectOn(freshConnection);
  }
  async #reconnectOn(freshConnection: Connection): Promise<import('./client.js').WatchSubscription> {
    await this.#terminate(true);
    try {
      const runId = this.#runId; const fromCursor = this.#lastDelivered;
      const params: WatchParams = {
        ...(runId === undefined ? {} : { runId }),
        ...(fromCursor === undefined ? {} : { fromCursor }),
      };
      const established = await freshConnection.openSubscription('watch', params);
      return {
        result: established.result,
        stream: new WatchSubscriptionStream({
          connection: freshConnection,
          registration: established.registration,
          result: established.result,
          params,
          ...(this.#lastSeenRunId === undefined ? {} : { lastSeenRunId: this.#lastSeenRunId }),
          ...(this.#lastSeenCursor === undefined ? {} : { lastSeenCursor: this.#lastSeenCursor }),
        }),
      };
    } catch (error) { await freshConnection.close(); throw error; }
  }
  async #terminate(sendCancel: boolean): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    this.#connection.unregisterSubscription(this.#registration.id, this.#registration);
    this.#registration.queue.closeAndDiscard();
    if (sendCancel) {
      try { await this.#connection.cancelSubscription(this.#registration); }
      catch (error) { this.#connection.recordDiagnostic(error); }
    }
  }
  #finishWithoutCancel(): void {
    if (this.#done) return;
    this.#done = true;
    this.#connection.unregisterSubscription(this.#registration.id, this.#registration);
    this.#registration.queue.closeAndDiscard();
  }
  async #invalid(message: string): Promise<never> {
    await this.#terminate(true);
    throw new ClusterProtocolError(message, 'INVALID_SUBSCRIPTION_EVENT');
  }
}

Object.defineProperty(SubscriptionStream.prototype, Symbol.asyncDispose, {
  configurable: true, value: SubscriptionStream.prototype.cancel,
});
Object.defineProperty(WatchSubscriptionStream.prototype, Symbol.asyncDispose, {
  configurable: true, value: WatchSubscriptionStream.prototype.cancel,
});
