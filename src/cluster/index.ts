/** Public entrypoint for the `@the-open-engine/zeroshot/cluster` subpath. */

export { ClusterClient, PROTOCOL_VERSION, type ClusterCallOptions } from './cluster-client.js';

export {
  createWebSocketTransport,
  type ClusterWebSocketTransport,
  type CreateWebSocketTransportOptions,
  type WebSocketConstructorLike,
  type WebSocketConstructorOptions,
  type WebSocketLike,
} from './websocket-transport.js';

export type { JsonRpcTransport, RequestId, SubscriptionTransport } from './transport.js';

export { watch, type WatchEventOrClosed, type WatchSubscriptionStream } from './watch-subscription.js';
export { logs, type LogEventStream } from './logs-subscription.js';
export { agentAttach, type AgentAttachEventStream } from './agent-attach-subscription.js';
export type { EventOrClosed, EventSubscriptionStream } from './event-subscription.js';

export {
  ClusterAbortError,
  ClusterClientError,
  ClusterInvalidResponseError,
  ClusterRpcError,
  ClusterTransportError,
} from './errors.js';

export type { ClusterMethodMap, ClusterMethodName } from './generated/methods.js';
export * from './generated/wire-types.js';
