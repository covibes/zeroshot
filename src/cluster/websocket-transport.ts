import WS from 'ws';

import type { RequestId } from './envelope.js';
import { ClusterTransportError } from './errors.js';
import { isRecord } from './json-guards.js';
import {
  MultiplexedTransport,
  type FrameSink,
  type PumpedResponse,
} from './multiplexed-transport.js';

const READY_STATE_OPEN = 1;

/**
 * Minimal browser-`WebSocket`-compatible surface this transport depends on. Node's `ws` package
 * satisfies this at runtime (it implements the same `addEventListener`/`send`/`close`/`readyState`
 * contract as the browser standard), and any injected browser `WebSocket` constructor does too —
 * this repo's tsconfig has no DOM lib, so this interface (not the global `WebSocket` type) is the
 * only contract callers need to satisfy.
 */
export interface ClusterWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

export type WebSocketFactory = (url: string) => ClusterWebSocketLike;

function wrapNodeWebSocket(socket: WS): ClusterWebSocketLike {
  return {
    get readyState(): number {
      return socket.readyState;
    },
    send(data: string): void {
      socket.send(data);
    },
    close(code?: number, reason?: string): void {
      socket.close(code, reason);
    },
    addEventListener(type: string, listener: (event: unknown) => void): void {
      switch (type) {
        case 'open':
          socket.on('open', () => listener(undefined));
          break;
        case 'close':
          socket.on('close', (code, reason) => listener({ code, reason: reason.toString() }));
          break;
        case 'error':
          socket.on('error', (error) => listener({ message: error.message }));
          break;
        case 'message':
          socket.on('message', (data) => listener({ data: data.toString() }));
          break;
        default:
          throw new ClusterTransportError(`unsupported WebSocket event type: ${type}`);
      }
    },
  };
}

function defaultNodeWebSocketFactory(url: string): ClusterWebSocketLike {
  return wrapNodeWebSocket(new WS(url));
}

function resolveDefaultFactory(): WebSocketFactory {
  const globalCtor = (globalThis as { WebSocket?: new (url: string) => ClusterWebSocketLike })
    .WebSocket;
  if (typeof globalCtor === 'function') {
    return (url: string) => new globalCtor(url);
  }
  return defaultNodeWebSocketFactory;
}

function describeSocketEvent(event: unknown): string {
  if (isRecord(event) && typeof event.message === 'string') return event.message;
  if (isRecord(event) && typeof event.code === 'number') {
    return `connection closed (code ${event.code})`;
  }
  return 'WebSocket connection failed';
}

function extractMessageText(event: unknown): string | null {
  if (!isRecord(event)) return null;
  const data = event.data;
  return typeof data === 'string' ? data : null;
}

export interface WebSocketTransportOptions {
  readonly webSocketFactory?: WebSocketFactory;
  readonly subscriptionQueueCapacity?: number | undefined;
}

/**
 * Production WebSocket binding of {@link MultiplexedTransport}: demultiplexes unary request/response
 * traffic and generic `watch`/`logs`/`agent/attach` subscription notifications sharing one WebSocket
 * connection. Mirrors crates/openengine-cluster-client/src/websocket.rs.
 */
export class WebSocketTransport {
  private readonly socket: ClusterWebSocketLike;
  private readonly multiplexed: MultiplexedTransport;
  private closed = false;
  private readonly closeListeners = new Set<() => void>();

  private constructor(socket: ClusterWebSocketLike, multiplexed: MultiplexedTransport) {
    this.socket = socket;
    this.multiplexed = multiplexed;
  }

  static async connect(
    url: string,
    options?: WebSocketTransportOptions
  ): Promise<WebSocketTransport> {
    const factory = options?.webSocketFactory ?? resolveDefaultFactory();
    const socket = factory(url);
    const sink: FrameSink = {
      sendFrame(frame: string): Promise<void> {
        if (socket.readyState !== READY_STATE_OPEN) {
          return Promise.reject(new ClusterTransportError('WebSocket is not open'));
        }
        socket.send(frame);
        return Promise.resolve();
      },
    };
    const multiplexed = new MultiplexedTransport(sink, {
      subscriptionQueueCapacity: options?.subscriptionQueueCapacity,
    });
    const transport = new WebSocketTransport(socket, multiplexed);

    await WebSocketTransport.waitForOpen(socket);

    socket.addEventListener('message', (event: unknown) => {
      const text = extractMessageText(event);
      if (text !== null) transport.multiplexed.routeIncoming(text);
    });
    socket.addEventListener('close', () => transport.handleClose());

    return transport;
  }

  private static async waitForOpen(socket: ClusterWebSocketLike): Promise<void> {
    if (socket.readyState === READY_STATE_OPEN) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      socket.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      const onFailure = (event: unknown): void => {
        if (settled) return;
        settled = true;
        reject(new ClusterTransportError(describeSocketEvent(event)));
      };
      socket.addEventListener('error', onFailure);
      socket.addEventListener('close', onFailure);
    });
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.multiplexed.finish();
    for (const listener of this.closeListeners) listener();
  }

  /** Registers a listener invoked exactly once when the underlying connection closes. */
  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.socket.close();
  }

  sendRequest(serialized: string, id: RequestId): Promise<PumpedResponse> {
    return this.multiplexed.sendRequest(serialized, id);
  }

  cancelSubscription(subscriptionId: string): Promise<void> {
    return this.multiplexed.cancelSubscription(subscriptionId);
  }

  cancelRequest(id: RequestId): Promise<void> {
    return this.multiplexed.cancelRequest(id);
  }

  /** @returns an integer request id, shared across every caller of this transport. */
  nextRequestId(): RequestId {
    return this.multiplexed.nextRequestId();
  }

  /** @returns a `watch-<n>` string request id, shared across every caller of this transport. */
  nextWatchRequestId(): RequestId {
    return this.multiplexed.nextWatchRequestId();
  }
}
