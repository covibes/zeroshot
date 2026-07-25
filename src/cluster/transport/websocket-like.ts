/**
 * The minimal surface this client needs from a WebSocket implementation. Satisfied by both the
 * browser/global `WebSocket` and the `ws` package's `WebSocket` class, so the transport never
 * imports either directly.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'close', listener: (event: {code: number; reason: string}) => void): void;
  addEventListener(type: 'message', listener: (event: {data: unknown}) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  removeEventListener(type: 'open', listener: () => void): void;
  removeEventListener(
    type: 'close',
    listener: (event: {code: number; reason: string}) => void
  ): void;
  removeEventListener(type: 'message', listener: (event: {data: unknown}) => void): void;
  removeEventListener(type: 'error', listener: (event: unknown) => void): void;
}

/** `WebSocketLike.readyState` values, shared by the browser `WebSocket` and `ws`. */
export const WEBSOCKET_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;
