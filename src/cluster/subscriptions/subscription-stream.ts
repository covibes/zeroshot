import type {ConnectionMultiplexer, SubscriptionDelivery} from '../transport/multiplexer.js';

/**
 * Base class for every subscription-based method (`watch`, `logs`, `agent/attach`): an
 * `AsyncIterable` of typed events plus idempotent cancellation. `.cancel()` and the async
 * iterator's `return()` (invoked by `for await...of`'s `break`/`return`/`throw`, or by calling it
 * directly) both route through the same guard, so concurrent double-cancellation sends
 * `subscription/cancel` exactly once and settles the stream exactly once -- the wire contract's
 * documented "at most one post-cancel event may still arrive" race is tolerated, not fought.
 */
export abstract class SubscriptionStream<TEvent> implements AsyncIterable<TEvent> {
  public readonly subscriptionId: string;
  protected readonly transport: ConnectionMultiplexer;
  private readonly deliveryIterator: AsyncIterator<SubscriptionDelivery>;
  private cancelPromise: Promise<void> | null = null;
  private closeReason: string | null = null;

  protected constructor(
    subscriptionId: string,
    transport: ConnectionMultiplexer,
    deliveries: AsyncIterable<SubscriptionDelivery>
  ) {
    this.subscriptionId = subscriptionId;
    this.transport = transport;
    this.deliveryIterator = deliveries[Symbol.asyncIterator]();
  }

  /** Parses one `event` notification's params, or returns `null` to skip an unrecognized shape. */
  protected abstract parseEvent(params: unknown): TEvent | null;

  /** Parses one `subscription/closed` notification's `reason`, or `null` if unrecognized. */
  protected abstract parseClosedReason(params: unknown): string | null;

  /** The `subscription/closed` reason last observed, if this stream has ended. */
  public get lastCloseReason(): string | null {
    return this.closeReason;
  }

  /** Cancels the subscription: sends `subscription/cancel` and ends local delivery. Idempotent. */
  public cancel(): Promise<void> {
    if (!this.cancelPromise) {
      this.cancelPromise = this.performCancel();
    }
    return this.cancelPromise;
  }

  private performCancel(): Promise<void> {
    this.transport.cancelSubscription(this.subscriptionId);
    this.transport.forgetSubscription(this.subscriptionId);
    return Promise.resolve();
  }

  public [Symbol.asyncIterator](): AsyncIterator<TEvent> {
    return {
      next: () => this.pull(),
      return: () => this.cancel().then(() => ({value: undefined, done: true}) as const),
    };
  }

  private async pull(): Promise<IteratorResult<TEvent>> {
    for (;;) {
      const next = await this.deliveryIterator.next();
      if (next.done) {
        return {value: undefined, done: true};
      }
      const delivery = next.value;
      if (delivery.kind === 'closed') {
        this.closeReason = this.parseClosedReason(delivery.params) ?? 'unknown';
        return {value: undefined, done: true};
      }
      const event = this.parseEvent(delivery.params);
      if (event === null) continue;
      return {value: event, done: false};
    }
  }
}
