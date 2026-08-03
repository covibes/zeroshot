declare module 'ws' {
  const WebSocket: new (
    url: string,
    protocols?: string | readonly string[],
    options?: { readonly headers?: Readonly<Record<string, string>> },
  ) => import('./index.js').WebSocketLike;
  export default WebSocket;
}
