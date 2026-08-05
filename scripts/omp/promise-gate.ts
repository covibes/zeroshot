export interface PromiseGate<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

interface PromiseConstructorWithResolvers extends PromiseConstructor {
  withResolvers<T>(): PromiseGate<T>;
}

export function promiseGate<T>(): PromiseGate<T> {
  return (Promise as PromiseConstructorWithResolvers).withResolvers<T>();
}
