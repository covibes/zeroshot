import { SUBSCRIPTION_QUEUE_CAPACITY } from './generated/protocol.js';
import { ClusterInternalError } from './errors.js';

export const SUBSCRIPTION_QUEUE_MAX_BYTES = 8 * 1024 * 1024;

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

export type QueueValue<T> =
  | { readonly done: false; readonly value: T }
  | { readonly done: true };

export class BoundedQueue<T> {
  readonly #items: Array<{ readonly value: T; readonly bytes: number }> = [];
  readonly #waiters: Array<Deferred<QueueValue<T>>> = [];
  #bytes = 0;
  #producerClosed = false;

  get retainedCount(): number { return this.#items.length; }

  push(value: T, bytes: number): 'buffered' | 'delivered' | 'overflow' | 'closed' {
    if (this.#producerClosed) return 'closed';
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      this.#assertInvariant();
      return 'delivered';
    }
    if (
      this.#items.length >= SUBSCRIPTION_QUEUE_CAPACITY ||
      this.#bytes + bytes > SUBSCRIPTION_QUEUE_MAX_BYTES
    ) return 'overflow';
    this.#items.push({ value, bytes });
    this.#bytes += bytes;
    this.#assertInvariant();
    return 'buffered';
  }

  recv(): Promise<QueueValue<T>> {
    const item = this.#items.shift();
    if (item) {
      this.#bytes -= item.bytes;
      this.#assertInvariant();
      return Promise.resolve({ done: false, value: item.value });
    }
    if (this.#producerClosed) return Promise.resolve({ done: true });
    const waiter = deferred<QueueValue<T>>();
    this.#waiters.push(waiter);
    this.#assertInvariant();
    return waiter.promise;
  }

  endRetainingBuffer(): void {
    if (this.#producerClosed) return;
    this.#producerClosed = true;
    while (this.#waiters.length > 0) this.#waiters.shift()!.resolve({ done: true });
    this.#assertInvariant();
  }

  closeAndDiscard(): void {
    this.#producerClosed = true;
    this.#items.length = 0;
    this.#bytes = 0;
    while (this.#waiters.length > 0) this.#waiters.shift()!.resolve({ done: true });
    this.#assertInvariant();
  }

  #assertInvariant(): void {
    if (this.#items.length > 0 && this.#waiters.length > 0) {
      throw new ClusterInternalError(
        'queue contains both buffered items and waiters',
        'QUEUE_INVARIANT',
      );
    }
  }
}
