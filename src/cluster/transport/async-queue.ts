/**
 * A minimal unbounded FIFO async queue: `push` never blocks, `next`/the async iterator await until
 * an item is available or the queue is closed. Backs each subscription's local event delivery so
 * the WebSocket message handler never awaits a slow consumer.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  public push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({value: item, done: false});
      return;
    }
    this.buffered.push(item);
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      waiter?.({value: undefined, done: true});
    }
  }

  public next(): Promise<IteratorResult<T>> {
    const value = this.buffered.shift();
    if (value !== undefined) {
      return Promise.resolve({value, done: false});
    }
    if (this.closed) {
      return Promise.resolve({value: undefined, done: true});
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {next: () => this.next()};
  }
}
