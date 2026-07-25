export * from './wire-types.generated.js';
export * from './envelope.js';
export * from './errors.js';
export * from './multiplexed-transport.js';
export * from './subscription-stream.js';
export * from './websocket-transport.js';
export * from './cluster-client.js';
export * from './watch-subscription.js';
export * from './durable-watch.js';
export * from './logs-subscription.js';
export * from './agent-attach-subscription.js';

import { ClusterClient } from './cluster-client.js';
import { WebSocketTransport, type WebSocketTransportOptions } from './websocket-transport.js';

/**
 * Convenience entrypoint: dials `url`, waits for the connection to open, and returns a
 * `ClusterClient` ready for unary calls plus the underlying `WebSocketTransport` (needed to build a
 * `WatchSubscriptionClient`/`LogsSubscriptionClient`/`AgentAttachSubscriptionClient`/`DurableWatchClient`
 * sharing the same connection).
 */
export async function connectCluster(
  url: string,
  options?: WebSocketTransportOptions
): Promise<{ client: ClusterClient; transport: WebSocketTransport }> {
  const transport = await WebSocketTransport.connect(url, options);
  return { client: new ClusterClient(transport), transport };
}
