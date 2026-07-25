/**
 * Production WebSocket transport for the typed Cluster Protocol client, mirroring
 * `openengine_cluster_client::websocket::WebSocketTransport`
 * (crates/openengine-cluster-client/src/websocket.rs): demultiplexes unary request/response
 * traffic and generic `watch`/`logs`/`agent/attach` subscription notifications sharing one
 * WebSocket connection via {@link MultiplexedTransport}. The concrete WebSocket implementation is
 * injectable so this module works unmodified in Node (the bundled `ws` package, the default) and
 * in a browser (pass `window.WebSocket`).
 */

import { MultiplexedTransport, type FrameSink } from './multiplex.js';
import { TransportError, type SubscriptionTransport } from './transport.js';

/** Structural subset of both `ws`'s `WebSocket` and the browser's native `WebSocket` that this
 * module needs. Deliberately loose (no dependency on `@types/ws` or the DOM lib in this
 * strict-typed package) so either implementation satisfies it without an adapter. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'open', listener: () => void): void;
  removeEventListener(type: 'close', listener: () => void): void;
  removeEventListener(type: 'error', listener: (event: unknown) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export interface WebSocketConstructorOptions {
  headers?: Record<string, string>;
}

export interface WebSocketConstructorLike {
  new (url: string, protocols: string | string[] | undefined, options?: WebSocketConstructorOptions): WebSocketLike;
  readonly OPEN: number;
}

export interface CreateWebSocketTransportOptions {
  /** WebSocket constructor to use. Defaults to the `ws` package's `WebSocket`, which this
   * package depends on for Node >=18 (no global `WebSocket` may exist). Pass `window.WebSocket`
   * (or any spec-compatible implementation) to run in a browser. */
  WebSocketImpl?: WebSocketConstructorLike;
  /** Extra HTTP headers for the opening handshake. Only meaningful for implementations that
   * support it (the `ws` package does; browsers never do -- the Fetch/WebSocket standards give
   * pages no way to set arbitrary handshake headers). */
  headers?: Record<string, string>;
}

let defaultWebSocketImpl: WebSocketConstructorLike | undefined;

async function loadDefaultWebSocketImpl(): Promise<WebSocketConstructorLike> {
  if (!defaultWebSocketImpl) {
    const wsModule = await import('ws');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- `ws`'s WebSocket is a structural superset of WebSocketConstructorLike.
    defaultWebSocketImpl = wsModule.WebSocket as unknown as WebSocketConstructorLike;
  }
  return defaultWebSocketImpl;
}

class WebSocketFrameSink implements FrameSink {
  constructor(private readonly ws: WebSocketLike) {}

  // Unlike Rust's awaited `write_all` + `flush`, neither the browser nor the `ws` package exposes
  // a portable delivery-confirmation contract for `send()`: browsers make it entirely
  // fire-and-forget, and relying on `ws`'s Node-only callback would silently hang forever against
  // an injected browser implementation. A `send()` failure after this call returns surfaces via
  // the socket's `error`/`close` events instead, which end the pump and reject every pending
  // request/subscription exactly like a dropped connection.
  sendFrame(frame: string): Promise<void> {
    try {
      this.ws.send(frame);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? new TransportError(error.message, { cause: error })
          : new TransportError(String(error))
      );
    }
  }
}

export interface ClusterWebSocketTransport extends SubscriptionTransport {
  /** Closes the underlying WebSocket connection. Idempotent. */
  close(code?: number, reason?: string): void;
}

/**
 * Opens a WebSocket connection to `url` and resolves once it is ready to use, wiring inbound
 * frames into a {@link MultiplexedTransport}. Mirrors `WebSocketTransport::new`, plus the
 * connection-establishment `tokio_tungstenite::connect_async` callers do separately in Rust --
 * folded in here since this package's only entrypoint is a URL, not a pre-connected socket.
 */
export async function createWebSocketTransport(
  url: string,
  options: CreateWebSocketTransportOptions = {}
): Promise<ClusterWebSocketTransport> {
  const WebSocketImpl = options.WebSocketImpl ?? (await loadDefaultWebSocketImpl());
  const ws =
    options.headers !== undefined
      ? new WebSocketImpl(url, undefined, { headers: options.headers })
      : new WebSocketImpl(url, undefined);

  await new Promise<void>((resolve, reject) => {
    if (ws.readyState === WebSocketImpl.OPEN) {
      resolve();
      return;
    }
    function onError(event: unknown): void {
      ws.removeEventListener('open', onOpen);
      const message = event instanceof Error ? event.message : 'WebSocket connection failed';
      reject(new TransportError(message, { cause: event }));
    }
    function onOpen(): void {
      ws.removeEventListener('error', onError);
      resolve();
    }
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
  });

  const sink = new WebSocketFrameSink(ws);
  const inner = new MultiplexedTransport(sink);

  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      // Fire-and-forget from the socket event's perspective, but `routeIncomingFrame` awaits
      // the (synchronous, in-memory) demux + best-effort-cancel work before resolving, so frames
      // are still routed one at a time in arrival order.
      void inner.routeIncomingFrame(event.data);
    }
    // Non-text frames have no analog on this wire protocol (the server only ever sends
    // `Message::Text`); anything else is ignored, mirroring `websocket.rs`'s
    // `Message::Binary(_) | Ping(_) | Pong(_) | Frame(_) => continue`.
  });
  ws.addEventListener('close', () => inner.endStream());
  ws.addEventListener('error', () => inner.endStream());

  return {
    request: (request) => inner.request(request),
    openSubscription: (request, id) => inner.openSubscription(request, id),
    cancelSubscription: (subscriptionId) => inner.cancelSubscription(subscriptionId),
    cancelRequest: (id) => inner.cancelRequest(id),
    nextWatchRequestId: () => inner.nextWatchRequestId(),
    close: (code, reason) => ws.close(code, reason),
  };
}
