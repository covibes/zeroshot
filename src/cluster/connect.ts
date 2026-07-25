import {ClusterClient} from './client.js';
import {TransportError} from './errors.js';
import type {AgentAttachParams, WatchParams} from './generated/wire-types.js';
import {AgentAttachSubscriptionStream} from './subscriptions/agent-attach.js';
import {LogsSubscriptionStream} from './subscriptions/logs.js';
import {establishWatch, type WatchSubscriptionStream} from './subscriptions/watch.js';
import {ConnectionMultiplexer} from './transport/multiplexer.js';
import {defaultWebSocketFactory, type WebSocketFactory} from './transport/websocket-factory.js';
import {WEBSOCKET_READY_STATE, type WebSocketLike} from './transport/websocket-like.js';

export interface ConnectClusterOptions {
  readonly webSocketFactory?: WebSocketFactory;
  readonly protocols?: readonly string[];
}

/**
 * One dialed connection: a {@link ClusterClient} for the nine unary methods plus factories for the
 * three subscription methods, all sharing the single underlying transport/id-space (see
 * {@link ConnectionMultiplexer}). `close()` closes the WebSocket; every in-flight call rejects and
 * every open subscription ends.
 */
export interface ClusterConnection {
  readonly client: ClusterClient;
  watch(params?: WatchParams, signal?: AbortSignal): Promise<WatchSubscriptionStream>;
  logs(signal?: AbortSignal): Promise<LogsSubscriptionStream>;
  attach(params: AgentAttachParams, signal?: AbortSignal): Promise<AgentAttachSubscriptionStream>;
  close(): void;
}

function waitForOpen(socket: WebSocketLike): Promise<void> {
  if (socket.readyState === WEBSOCKET_READY_STATE.OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    function cleanup(): void {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
    }
    function onOpen(): void {
      cleanup();
      resolve();
    }
    function onError(event: unknown): void {
      cleanup();
      reject(new TransportError('WebSocket failed to connect', {cause: event}));
    }
    function onClose(event: {code: number; reason: string}): void {
      cleanup();
      reject(new TransportError(`WebSocket closed before opening (code ${event.code})`));
    }
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
  });
}

async function openLogs(
  transport: ConnectionMultiplexer,
  signal?: AbortSignal
): Promise<LogsSubscriptionStream> {
  const opened = await transport.openSubscription('logs', {}, signal);
  return new LogsSubscriptionStream(opened.subscriptionId, transport, opened.deliveries);
}

async function openAttach(
  transport: ConnectionMultiplexer,
  params: AgentAttachParams,
  signal?: AbortSignal
): Promise<AgentAttachSubscriptionStream> {
  const opened = await transport.openSubscription('agent/attach', params, signal);
  return new AgentAttachSubscriptionStream(opened.subscriptionId, transport, opened.deliveries);
}

/**
 * Dials one WebSocket connection to a Cluster Protocol v1 server, wraps it in a single
 * {@link ConnectionMultiplexer}, and returns a {@link ClusterClient} plus subscription factories
 * that all share that one transport -- so ids minted for any of them can never collide (the fix
 * for the PR#799 finding; see {@link ConnectionMultiplexer}).
 */
export async function connectCluster(
  url: string,
  options?: ConnectClusterOptions
): Promise<ClusterConnection> {
  const factory = options?.webSocketFactory ?? defaultWebSocketFactory;
  const socket = await factory(url, options?.protocols);
  await waitForOpen(socket);

  const transport = new ConnectionMultiplexer(socket);
  const client = new ClusterClient(transport);

  return {
    client,
    watch: (params: WatchParams = {}, signal?: AbortSignal): Promise<WatchSubscriptionStream> =>
      establishWatch(transport, params, undefined, signal),
    logs: (signal?: AbortSignal): Promise<LogsSubscriptionStream> => openLogs(transport, signal),
    attach: (
      params: AgentAttachParams,
      signal?: AbortSignal
    ): Promise<AgentAttachSubscriptionStream> => openAttach(transport, params, signal),
    close: (): void => transport.close(),
  };
}
