import type {WebSocket as WsWebSocket} from 'ws';
import type {WebSocketLike} from './websocket-like.js';

/** Dials a WebSocket connection and resolves once the socket is constructed (not yet open). */
export type WebSocketFactory = (
  url: string,
  protocols?: readonly string[]
) => WebSocketLike | Promise<WebSocketLike>;

type GlobalWebSocketConstructor = new (url: string, protocols?: readonly string[]) => WebSocketLike;

function isWebSocketConstructor(value: unknown): value is GlobalWebSocketConstructor {
  return typeof value === 'function';
}

/**
 * Narrows an already `type`-discriminated listener (one arm of {@link WebSocketLike}'s overloaded
 * `addEventListener`/`removeEventListener`) back to its branch-specific signature. The union is
 * exhaustively discriminated by the caller's `if (type === ...)` before this is reached; this
 * helper only re-states that as a type, it does not itself perform any runtime check.
 */
function asListener<T>(listener: unknown): T {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- see doc comment above.
  return listener as T;
}

/**
 * Adapts a `ws` package socket (Node has no global `WebSocket` on the `>=18` floor this package
 * supports) to {@link WebSocketLike}. Built on `ws`'s `EventEmitter` API (`.on`/`.off`), which is
 * precisely typed by `@types/ws`, rather than its generic DOM-style `addEventListener`.
 */
function adaptNodeWebSocket(socket: WsWebSocket): WebSocketLike {
  const openListeners = new Map<() => void, () => void>();
  const closeListeners = new Map<
    (event: {code: number; reason: string}) => void,
    (code: number, reason: Buffer) => void
  >();
  const messageListeners = new Map<
    (event: {data: unknown}) => void,
    (data: unknown, isBinary: boolean) => void
  >();
  const errorListeners = new Map<(event: unknown) => void, (error: Error) => void>();

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
    addEventListener(
      type: 'open' | 'close' | 'message' | 'error',
      listener:
        | (() => void)
        | ((event: {code: number; reason: string}) => void)
        | ((event: {data: unknown}) => void)
        | ((event: unknown) => void)
    ): void {
      if (type === 'open') {
        const typed = asListener<() => void>(listener);
        const wrapped = (): void => typed();
        openListeners.set(typed, wrapped);
        socket.on('open', wrapped);
        return;
      }
      if (type === 'close') {
        const typed = asListener<(event: {code: number; reason: string}) => void>(listener);
        const wrapped = (code: number, reason: Buffer): void =>
          typed({code, reason: reason.toString('utf8')});
        closeListeners.set(typed, wrapped);
        socket.on('close', wrapped);
        return;
      }
      if (type === 'message') {
        const typed = asListener<(event: {data: unknown}) => void>(listener);
        const wrapped = (data: unknown, isBinary: boolean): void => {
          typed({data: isBinary ? data : dataToUtf8(data)});
        };
        messageListeners.set(typed, wrapped);
        socket.on('message', wrapped);
        return;
      }
      const typed = asListener<(event: unknown) => void>(listener);
      const wrapped = (error: Error): void => typed(error);
      errorListeners.set(typed, wrapped);
      socket.on('error', wrapped);
    },
    removeEventListener(
      type: 'open' | 'close' | 'message' | 'error',
      listener:
        | (() => void)
        | ((event: {code: number; reason: string}) => void)
        | ((event: {data: unknown}) => void)
        | ((event: unknown) => void)
    ): void {
      if (type === 'open') {
        const wrapped = openListeners.get(asListener<() => void>(listener));
        if (wrapped) socket.off('open', wrapped);
        return;
      }
      if (type === 'close') {
        const wrapped = closeListeners.get(
          asListener<(event: {code: number; reason: string}) => void>(listener)
        );
        if (wrapped) socket.off('close', wrapped);
        return;
      }
      if (type === 'message') {
        const wrapped = messageListeners.get(asListener<(event: {data: unknown}) => void>(listener));
        if (wrapped) socket.off('message', wrapped);
        return;
      }
      const wrapped = errorListeners.get(asListener<(event: unknown) => void>(listener));
      if (wrapped) socket.off('error', wrapped);
    },
  };
}

function dataToUtf8(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data) && data.every((chunk) => Buffer.isBuffer(chunk))) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  throw new TypeError('received a WebSocket message frame in an unsupported shape');
}

/**
 * Resolves a working `WebSocketFactory` for the current runtime: the global `WebSocket` when one
 * is defined (browsers, and Node >=22), otherwise a lazy `import('ws')` so bundlers targeting a
 * browser-only build can tree-shake the `ws` dependency out entirely.
 */
export const defaultWebSocketFactory: WebSocketFactory = async (
  url,
  protocols
): Promise<WebSocketLike> => {
  const globalCandidate: unknown = (globalThis as Record<string, unknown>)['WebSocket'];
  if (isWebSocketConstructor(globalCandidate)) {
    return protocols === undefined
      ? new globalCandidate(url)
      : new globalCandidate(url, protocols);
  }
  const {WebSocket: NodeWebSocket} = await import('ws');
  const socket =
    protocols === undefined ? new NodeWebSocket(url) : new NodeWebSocket(url, [...protocols]);
  return adaptNodeWebSocket(socket);
};
