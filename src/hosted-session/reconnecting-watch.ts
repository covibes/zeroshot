import type {
  WatchSubscription,
  WatchSubscriptionItem,
} from '../cluster/index.js';
import {
  HostedAuthorizationError,
  HostedTransportUncertainError,
} from './errors.js';
import type { HostedWatch, InitializedSession } from './types.js';

type ReplaceSession = (signal: AbortSignal) => Promise<InitializedSession>;

export class ReconnectingHostedWatch implements HostedWatch {
  readonly #replace: ReplaceSession;
  readonly #ownedController = new AbortController();
  readonly #signal: AbortSignal;
  #session: InitializedSession;
  #subscription: WatchSubscription;
  #tail: Promise<void> = Promise.resolve();
  #replacementPromise: Promise<InitializedSession> | undefined;
  #cancelPromise: Promise<void> | undefined;
  #reconnected = false;
  #cancelled = false;

  constructor(
    replace: ReplaceSession,
    session: InitializedSession,
    subscription: WatchSubscription,
    signal?: AbortSignal,
  ) {
    this.#replace = replace;
    this.#session = session;
    this.#subscription = subscription;
    this.#signal = signal === undefined
      ? this.#ownedController.signal
      : AbortSignal.any([signal, this.#ownedController.signal]);
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  next(): Promise<IteratorResult<WatchSubscriptionItem>> {
    const result = this.#tail.then(() => this.#readNext());
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #readNext(): Promise<IteratorResult<WatchSubscriptionItem>> {
    while (!this.#cancelled) {
      const item = await this.#subscription.stream.next();
      if (this.#cancelled) return { done: true, value: undefined };
      if (!item.done) return item;
      return this.#handleClosed(item);
    }
    return { done: true, value: undefined };
  }

  async #handleClosed(
    item: IteratorResult<WatchSubscriptionItem>,
  ): Promise<IteratorResult<WatchSubscriptionItem>> {
    if (this.#session.connection.state === 'OPEN') {
      await this.#session.connection.close();
      return item;
    }
    const { code } = await this.#session.connection.closed;
    if (code === 4401) return this.#reconnect();
    if (code === 4403) throw new HostedAuthorizationError();
    if (code === 1000) return item;
    throw new HostedTransportUncertainError();
  }

  async #reconnect(): Promise<IteratorResult<WatchSubscriptionItem>> {
    if (this.#reconnected) throw new HostedTransportUncertainError();
    this.#reconnected = true;
    const replacementPromise = this.#replace(this.#signal);
    this.#replacementPromise = replacementPromise;
    let replacement: InitializedSession;
    try {
      replacement = await replacementPromise;
    } catch (error) {
      if (this.#cancelled) return { done: true, value: undefined };
      throw error;
    } finally {
      if (this.#replacementPromise === replacementPromise) {
        this.#replacementPromise = undefined;
      }
    }
    return this.#installReplacement(replacement);
  }

  async #installReplacement(
    replacement: InitializedSession,
  ): Promise<IteratorResult<WatchSubscriptionItem>> {
    if (this.#cancelled) {
      await replacement.connection.close();
      return { done: true, value: undefined };
    }
    try {
      const subscription = await this.#subscription.stream.reconnect(replacement.connection);
      if (this.#cancelled) {
        await subscription.stream.cancel();
        await replacement.connection.close();
        return { done: true, value: undefined };
      }
      this.#subscription = subscription;
      this.#session = replacement;
      return this.#readNext();
    } catch (error) {
      await replacement.connection.close();
      if (this.#cancelled) return { done: true, value: undefined };
      throw error;
    }
  }

  async return(): Promise<IteratorResult<WatchSubscriptionItem>> {
    await this.cancel();
    return { done: true, value: undefined };
  }

  async throw(error?: unknown): Promise<IteratorResult<WatchSubscriptionItem>> {
    await this.cancel();
    throw error;
  }

  cancel(): Promise<void> {
    this.#cancelPromise ??= this.#cancelOwned();
    return this.#cancelPromise;
  }

  async #cancelOwned(): Promise<void> {
    this.#cancelled = true;
    this.#ownedController.abort(new DOMException('hosted watch cancelled', 'AbortError'));
    const replacement = this.#replacementPromise;
    const outcomes = await Promise.allSettled([
      this.#subscription.stream.cancel(),
      this.#session.connection.close(),
      ...(replacement === undefined
        ? []
        : [replacement.then(() => undefined, () => undefined)]),
    ]);
    await this.#tail;
    const failure = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    if (failure !== undefined) throw failure.reason;
  }
}
