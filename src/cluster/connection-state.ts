if (!Object.prototype.hasOwnProperty.call(Symbol, 'asyncDispose')) {
  Object.defineProperty(Symbol, 'asyncDispose', {
    configurable: false, enumerable: false,
    value: Symbol.for('Symbol.asyncDispose'), writable: false,
  });
}

export type ConnectionState = 'OPEN' | 'CLOSING' | 'CLOSED';
export const CONNECTION_TRANSITIONS: Readonly<Record<ConnectionState, readonly ConnectionState[]>> = Object.freeze({
  OPEN: Object.freeze(['CLOSING'] as const),
  CLOSING: Object.freeze(['CLOSED'] as const),
  CLOSED: Object.freeze([] as const),
});
export const PROTOCOL_DIAGNOSTIC_CAPACITY = 128;
export interface ConnectionCloseSnapshot {
  readonly code: number | null;
  readonly reason: null;
}

export type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
};
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
