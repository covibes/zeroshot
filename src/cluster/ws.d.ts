declare module 'ws' {
  const WebSocket: new (
    url: string,
    protocols?: string | readonly string[],
  ) => import('./index.js').WebSocketLike;
  export default WebSocket;
}
