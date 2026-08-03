import { JSON_RPC_VERSION, MAX_FRAME_BYTES, SUBSCRIPTION_METHODS, UNARY_METHODS } from './generated/protocol.js';
import type {
  ClusterMethod, ClusterMethodParams, ClusterMethodResults, DomainErrorData,
  SubscriptionMethod, UnaryClusterMethod,
} from './generated/protocol.js';
import {
  ClusterConfigError, ClusterInternalError, ClusterProtocolError, ClusterRpcError,
  ClusterStateError, ClusterTimeoutError, ClusterTransportError, requestAbortError,
} from './errors.js';
import { boundedFrameText, isRecord } from './frames.js';
import type { FrameRecord } from './frames.js';
import { BoundedQueue } from './queue.js';
import { addSocketListener } from './socket.js';
import type { WebSocketLike } from './socket.js';
import { assertDefinition, assertMethodResult } from './validators.js';
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
export const CLOSE_REASON_MAX_BYTES = 123;
const CLOSE_REASON_ENCODER = new TextEncoder();
function boundedCloseReason(reason: string): string {
  const retained: string[] = [];
  const scratch = new Uint8Array(4);
  let bytes = 0;
  for (const codePoint of reason) {
    const { written } = CLOSE_REASON_ENCODER.encodeInto(codePoint, scratch);
    if (bytes + written > CLOSE_REASON_MAX_BYTES) break;
    retained.push(codePoint);
    bytes += written;
  }
  return retained.join('');
}
export interface CallOptions { readonly signal?: AbortSignal; readonly requestTimeoutMs?: number; }

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve; reject = onReject;
  });
  return { promise, resolve, reject };
}
export type SubscriptionKind = 'watch' | 'logs' | 'agent/attach';
export type SubscriptionRegistration = {
  readonly id: string;
  readonly kind: SubscriptionKind;
  readonly queue: BoundedQueue<FrameRecord>;
  overflowed: boolean;
  cancelSent: boolean;
  abortHandler?: () => void;
  abortSignal?: AbortSignal;
};
export type EstablishedSubscription<R> = {
  readonly result: R;
  readonly registration: SubscriptionRegistration;
};
type PendingEntry = {
  readonly id: string; readonly method: ClusterMethod; readonly expectedId: string;
  readonly resolve: (value: unknown) => void; readonly reject: (reason: unknown) => void;
  readonly subscriptionKind?: SubscriptionKind; settled: boolean;
  abortHandler?: () => void; signal?: AbortSignal; timeout?: ReturnType<typeof setTimeout>;
};

export class Connection {
  #state: ConnectionState = 'OPEN'; #sequence = 1;
  readonly #pending = new Map<string, PendingEntry>();
  readonly #subscriptions = new Map<string, SubscriptionRegistration>();
  readonly #lateSubscriptionReapers = new Set<string>();
  readonly #removeSocketListeners: Array<() => void> = [];
  readonly #ownedSubscriptions = new WeakSet<SubscriptionRegistration>();
  #closePromise?: Promise<void>;
  #closeCode: number | undefined;
  #closeReason: string | undefined;
  readonly closeDiagnostics: unknown[] = [];
  readonly protocolDiagnostics: ClusterProtocolError[] = [];

  readonly #socket: WebSocketLike;
  constructor(socket: WebSocketLike) {
    if (socket.readyState !== 1) throw new ClusterStateError('Connection requires an already-open WebSocket', 'SOCKET_NOT_OPEN');
    this.#socket = socket;
    this.#removeSocketListeners.push(
      addSocketListener(socket, 'message', (event) => this.#onMessage(event)),
      addSocketListener(socket, 'error', () => { void this.#startClose(false); }),
      addSocketListener(socket, 'close', (...args: unknown[]) => { this.#captureCloseState(args); void this.#startClose(false); }),
    );
  }
  get state(): ConnectionState { return this.#state; }
  get pendingSize(): number { return this.#pending.size; }
  get subscriptionCount(): number { return this.#subscriptions.size; }
  get closeCode(): number | undefined { return this.#closeCode; }
  get closeReason(): string | undefined { return this.#closeReason; }
  call<M extends UnaryClusterMethod>(method: M, params: ClusterMethodParams[M], options: CallOptions = {}): Promise<ClusterMethodResults[M]> {
    if (!(UNARY_METHODS as readonly string[]).includes(method)) {
      throw new ClusterConfigError(`${method} is a subscription method`, 'INVALID_METHOD');
    }
    return this.#dispatch(method, params, options) as Promise<ClusterMethodResults[M]>;
  }
  cancelSubscription(registration: SubscriptionRegistration): Promise<void> {
    if (!this.#ownedSubscriptions.has(registration)) {
      return Promise.reject(new ClusterStateError('subscription is not owned by this connection', 'UNOWNED_SUBSCRIPTION'));
    }
    if (registration.cancelSent) return Promise.resolve();
    registration.cancelSent = true;
    return this.#sendNotification('subscription/cancel', { subscriptionId: registration.id });
  }
  openSubscription<M extends SubscriptionMethod>(method: M, params: ClusterMethodParams[M], options: CallOptions = {}): Promise<EstablishedSubscription<ClusterMethodResults[M]>> {
    if (!(SUBSCRIPTION_METHODS as readonly string[]).includes(method)) {
      throw new ClusterConfigError(`${method} is not a subscription method`, 'INVALID_METHOD');
    }
    return this.#dispatch(method, params, options, method) as Promise<EstablishedSubscription<ClusterMethodResults[M]>>;
  }
  unregisterSubscription(id: string, registration: SubscriptionRegistration): void {
    if (this.#subscriptions.get(id) !== registration) return;
    this.#subscriptions.delete(id);
    this.#disarmSubscriptionAbort(registration);
  }
  recordDiagnostic(error: unknown): void { this.closeDiagnostics.push(error); }
  close(): Promise<void> { return this.#startClose(true); }

  #dispatch(method: ClusterMethod, params: unknown, options: CallOptions, subscriptionKind?: SubscriptionKind): Promise<unknown> {
    this.#requireOpen();
    if (options.signal?.aborted) return Promise.reject(requestAbortError(method));
    if (options.requestTimeoutMs !== undefined && options.requestTimeoutMs < 0) return Promise.reject(new ClusterConfigError('requestTimeoutMs must be non-negative', 'INVALID_TIMEOUT'));
    const id = this.#allocateId();
    const result = deferred<unknown>();
    const entry: PendingEntry = { id, method, expectedId: id, resolve: result.resolve, reject: result.reject, settled: false, ...(subscriptionKind === undefined ? {} : { subscriptionKind }) };
    this.#pending.set(id, entry);
    if (options.signal) {
      const onAbort = () => {
        if (!this.#removeExact(id, entry)) return; this.#settleEntry(entry);
        if (entry.subscriptionKind) this.#lateSubscriptionReapers.add(id);
        entry.reject(requestAbortError(method));
        void this.#sendNotification('$/cancelRequest', { id }).catch((error: unknown) => this.recordDiagnostic(error));
      };
      entry.signal = options.signal; entry.abortHandler = onAbort; options.signal.addEventListener('abort', onAbort, { once: true });
    }
    if (options.requestTimeoutMs !== undefined) {
      entry.timeout = setTimeout(() => {
        if (!this.#removeExact(id, entry)) return; this.#settleEntry(entry);
        if (entry.subscriptionKind) this.#lateSubscriptionReapers.add(id);
        entry.reject(new ClusterTimeoutError(`${method} request timed out`, 'REQUEST_TIMEOUT'));
        void this.#sendNotification('$/cancelRequest', { id }).catch((error: unknown) => this.recordDiagnostic(error));
      }, options.requestTimeoutMs);
    }
    const request = { jsonrpc: JSON_RPC_VERSION, id, method, params };
    void this.#sendFrame(request).catch((cause: unknown) => {
      if (!this.#removeExact(id, entry)) return; this.#settleEntry(entry);
      entry.reject(new ClusterTransportError(`failed to send ${method}`, 'SEND_FAILED', { cause }));
    });
    return result.promise;
  }
  #allocateId(): string { return `z${this.#sequence++}`; }
  #removeExact(id: string, entry: PendingEntry): boolean { if (this.#pending.get(id) !== entry) return false; this.#pending.delete(id); return true; }
  #settleEntry(entry: PendingEntry): void {
    if (entry.settled) return; entry.settled = true;
    if (entry.timeout !== undefined) clearTimeout(entry.timeout);
    if (entry.signal && entry.abortHandler) entry.signal.removeEventListener('abort', entry.abortHandler);
  }
  #requireOpen(): void { if (this.#state !== 'OPEN') throw new ClusterStateError(`connection is ${this.#state.toLowerCase()}`, `CONNECTION_${this.#state}`); }
  async #sendFrame(value: unknown, allowClosing = false): Promise<void> {
    if (this.#state === 'CLOSED' || (!allowClosing && this.#state !== 'OPEN')) throw new ClusterStateError(`connection is ${this.#state.toLowerCase()}`, `CONNECTION_${this.#state}`);
    const payload = JSON.stringify(value);
    if (this.#socket.send.length >= 2) {
      await new Promise<void>((resolve, reject) => { try { this.#socket.send(payload, (error?: Error) => error ? reject(error) : resolve()); } catch (error) { reject(error); } });
      return;
    }
    const sent = this.#socket.send(payload); if (sent && typeof (sent as Promise<void>).then === 'function') await sent;
  }
  #sendNotification(method: '$/cancelRequest' | 'subscription/cancel', params: FrameRecord): Promise<void> {
    return this.#sendFrame({ jsonrpc: JSON_RPC_VERSION, method, params }, true);
  }
  #onMessage(event: unknown): void {
    if (this.#state !== 'OPEN') return;
    const inbound = boundedFrameText(event, MAX_FRAME_BYTES);
    if (inbound.kind === 'unsupported') { this.#recordProtocolError('WebSocket message is not text or bytes'); return; }
    if (inbound.kind === 'oversized') { this.#recordProtocolError(`frame exceeds ${MAX_FRAME_BYTES} bytes`); return; }
    const { text, bytes } = inbound;
    let frame: unknown; try { frame = JSON.parse(text); } catch (cause) { this.#recordProtocolError('invalid JSON frame', cause); return; }
    if (!isRecord(frame)) { this.#recordProtocolError('invalid JSON-RPC frame'); return; }
    if ('id' in frame) { this.#routeResponse(frame); return; }
    if (frame.jsonrpc !== JSON_RPC_VERSION) { this.#recordProtocolError('invalid JSON-RPC frame'); return; }
    if (typeof frame.method === 'string' && isRecord(frame.params)) { this.#routeNotification(frame.method, frame.params, frame, bytes); return; }
    this.#recordProtocolError('unrecognized JSON-RPC frame');
  }
  #routeResponse(frame: FrameRecord): void {
    if (typeof frame.id !== 'string') {
      this.#recordProtocolError('response id is not a string'); return;
    }
    const entry = this.#pending.get(frame.id);
    if (!entry) { this.#reapLateSubscription(frame.id, frame.result); return; }
    this.#removeExact(frame.id, entry); this.#settleEntry(entry);
    if (frame.id !== entry.expectedId || frame.jsonrpc !== JSON_RPC_VERSION) {
      entry.reject(new ClusterProtocolError('response identity mismatch', 'INVALID_RESPONSE_IDENTITY')); return;
    }
    if (isRecord(frame.error)) { this.#routeRpcError(entry, frame.error); return; }
    this.#routeSuccess(entry, frame);
  }
  #reapLateSubscription(id: string, result: unknown): void {
    if (!this.#lateSubscriptionReapers.delete(id) || !isRecord(result)) return;
    if (typeof result.subscriptionId !== 'string') return;
    void this.#sendNotification('subscription/cancel', { subscriptionId: result.subscriptionId })
      .catch((error: unknown) => this.recordDiagnostic(error));
  }
  #routeRpcError(entry: PendingEntry, error: FrameRecord): void {
    try { assertDefinition('JsonRpcError', error); }
    catch (cause) { entry.reject(cause); return; }
    const data = isRecord(error.data) ? error.data as DomainErrorData : undefined;
    entry.reject(new ClusterRpcError(error.code as number, error.message as string, data));
  }
  #routeSuccess(entry: PendingEntry, frame: FrameRecord): void {
    if (!('result' in frame)) {
      entry.reject(new ClusterProtocolError('response has neither result nor error', 'INVALID_RESPONSE')); return;
    }
    try { assertMethodResult(entry.method, frame.result); }
    catch (error) {
      if (entry.subscriptionKind && isRecord(frame.result) && typeof frame.result.subscriptionId === 'string') {
        void this.#sendNotification('subscription/cancel', { subscriptionId: frame.result.subscriptionId })
          .catch((cause: unknown) => this.recordDiagnostic(cause));
      }
      entry.reject(error); return;
    }
    if (!entry.subscriptionKind) { entry.resolve(frame.result); return; }
    const result = frame.result as ClusterMethodResults[SubscriptionMethod];
    const registration: SubscriptionRegistration = {
      id: result.subscriptionId, kind: entry.subscriptionKind,
      queue: new BoundedQueue<FrameRecord>(), overflowed: false, cancelSent: false,
    };
    if (this.#subscriptions.has(registration.id)) {
      entry.reject(new ClusterProtocolError('duplicate subscriptionId', 'DUPLICATE_SUBSCRIPTION')); return;
    }
    this.#ownedSubscriptions.add(registration);
    this.#subscriptions.set(registration.id, registration);
    this.#armSubscriptionAbort(registration, entry.signal);
    entry.resolve({ result, registration });
  }
  #armSubscriptionAbort(registration: SubscriptionRegistration, signal: AbortSignal | undefined): void {
    if (!signal) return;
    const onAbort = () => {
      if (this.#subscriptions.get(registration.id) !== registration) return;
      this.unregisterSubscription(registration.id, registration);
      registration.queue.closeAndDiscard();
      void this.cancelSubscription(registration).catch((error: unknown) => this.recordDiagnostic(error));
    };
    registration.abortSignal = signal;
    registration.abortHandler = onAbort;
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  }
  #disarmSubscriptionAbort(registration: SubscriptionRegistration): void {
    if (registration.abortSignal && registration.abortHandler) {
      registration.abortSignal.removeEventListener('abort', registration.abortHandler);
    }
    delete registration.abortSignal;
    delete registration.abortHandler;
  }
  #routeNotification(method: string, params: FrameRecord, frame: FrameRecord, bytes: number): void {
    const subscriptionId = params.subscriptionId;
    if (typeof subscriptionId !== 'string') { this.#recordProtocolError('subscription notification has no subscriptionId'); return; }
    const registration = this.#subscriptions.get(subscriptionId); if (!registration) return;
    const terminal = method === 'subscription/closed'; const outcome = registration.queue.push(frame, bytes);
    if (outcome === 'overflow') {
      registration.overflowed = true; this.unregisterSubscription(subscriptionId, registration); registration.queue.endRetainingBuffer();
      if (!terminal) void this.cancelSubscription(registration).catch((error: unknown) => this.recordDiagnostic(error));
      return;
    }
    if (terminal) { this.unregisterSubscription(subscriptionId, registration); registration.queue.endRetainingBuffer(); }
  }
  #recordProtocolError(message: string, cause?: unknown): void {
    if (this.protocolDiagnostics.length === PROTOCOL_DIAGNOSTIC_CAPACITY) this.protocolDiagnostics.shift();
    this.protocolDiagnostics.push(new ClusterProtocolError(message, 'INVALID_PEER_FRAME', cause === undefined ? undefined : { cause }));
  }
  #captureCloseState(args: unknown[]): void {
    if (args.length === 0) return;
    const first = args[0];
    if (typeof first === 'number') {
      this.#closeCode = first;
      const raw = args.length > 1 ? String(args[1]) : undefined;
      this.#closeReason = raw === undefined ? undefined : boundedCloseReason(raw);
    } else if (first !== null && typeof first === 'object') {
      const event = first as { code?: unknown; reason?: unknown };
      if (typeof event.code === 'number') this.#closeCode = event.code;
      if (typeof event.reason === 'string') this.#closeReason = boundedCloseReason(event.reason);
    }
  }
  #startClose(sendCancels: boolean): Promise<void> {
    if (this.#closePromise) return this.#closePromise; if (this.#state === 'CLOSED') return Promise.resolve();
    this.#transition('CLOSING'); this.#closePromise = Promise.resolve().then(() => this.#finishClose(sendCancels)); return this.#closePromise;
  }
  async #finishClose(sendCancels: boolean): Promise<void> {
    const subscriptions = [...this.#subscriptions.values()]; this.#subscriptions.clear();
    for (const subscription of subscriptions) {
      this.#disarmSubscriptionAbort(subscription);
      subscription.queue.closeAndDiscard();
    }
    const pending = [...this.#pending.values()]; this.#pending.clear();
    for (const entry of pending) { this.#settleEntry(entry); entry.reject(new ClusterTransportError('connection closed', 'CONNECTION_CLOSED')); }
    this.#lateSubscriptionReapers.clear();
    if (sendCancels) for (const subscription of subscriptions) {
      try { await this.cancelSubscription(subscription); }
      catch (error) { this.recordDiagnostic(error); }
    }
    try { await this.#socket.close(); } catch (error) { this.recordDiagnostic(error); }
    for (const remove of this.#removeSocketListeners.splice(0)) {
      try { remove(); } catch (error) { this.recordDiagnostic(error); }
    }
    this.#transition('CLOSED');
  }
  #transition(to: ConnectionState): void {
    if (!CONNECTION_TRANSITIONS[this.#state].includes(to)) throw new ClusterInternalError(`illegal connection transition ${this.#state} -> ${to}`, 'ILLEGAL_STATE_TRANSITION');
    this.#state = to;
  }
}

Object.defineProperty(Connection.prototype, Symbol.asyncDispose, {
  configurable: true, value: Connection.prototype.close,
});
