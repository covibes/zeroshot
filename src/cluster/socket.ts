import { ClusterConfigError } from './errors.js';

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string, callback?: (error?: Error) => void): void | Promise<void>;
  close(code?: number, reason?: string): void | Promise<void>;
  terminate?(): void;
  addEventListener?(type: string, listener: (...args: unknown[]) => void): void;
  removeEventListener?(type: string, listener: (...args: unknown[]) => void): void;
  on?(type: string, listener: (...args: unknown[]) => void): void;
  off?(type: string, listener: (...args: unknown[]) => void): void;
  removeListener?(type: string, listener: (...args: unknown[]) => void): void;
}

export function addSocketListener(
  socket: WebSocketLike,
  type: string,
  listener: (...args: unknown[]) => void,
): () => void {
  if (socket.addEventListener) {
    socket.addEventListener(type, listener);
    return () => socket.removeEventListener?.(type, listener);
  }
  if (socket.on) {
    socket.on(type, listener);
    return () => (socket.off ?? socket.removeListener)?.call(socket, type, listener);
  }
  throw new ClusterConfigError(
    'WebSocket implementation must support event listeners',
    'INVALID_WEBSOCKET',
  );
}

export function addSocketEmitterListener(
  socket: WebSocketLike,
  type: string,
  listener: (...args: unknown[]) => void,
): () => void {
  if (socket.on) {
    socket.on(type, listener);
    return () => (socket.off ?? socket.removeListener)?.call(socket, type, listener);
  }
  return addSocketListener(socket, type, listener);
}
