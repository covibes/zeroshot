/// <reference path="./ws.d.ts" />
import { PROTOCOL_VERSION } from './generated/protocol.js';
import type {
  AgentAttachParams, AgentAttachResult, ApplyParams, ApplyResult, DeleteParams, DeleteResult,
  GetParams, GetResult, InitializeParams, InitializeResult, LogsParams, LogsResult,
  PlanParams, PlanResult, ResubmitParams, ResubmitResult, RetryParams, RetryResult,
  StopParams, StopResult, UpdateParams, UpdateResult, WatchParams,
} from './generated/protocol.js';
import { Connection } from './connection.js';
import type { CallOptions } from './connection.js';
import { addSocketEmitterListener, addSocketListener } from './socket.js';
import type { WebSocketLike } from './socket.js';
import { ClusterConfigError, ClusterProtocolError, ClusterTransportError, ClusterUpgradeError } from './errors.js';
import {
  AgentAttachSubscriptionStream,
  LogsSubscriptionStream,
  WatchSubscriptionStream,
} from './subscriptions.js';
import type { WatchSubscription } from './subscriptions.js';
export type { WatchSubscription } from './subscriptions.js';

export interface WebSocketFactoryOptions {
  readonly headers?: Readonly<Record<string, string>>;
}
export interface ConnectOptions {
  readonly protocols?: string | readonly string[];
  readonly webSocketFactory?: (url: string, protocols?: string | readonly string[], options?: WebSocketFactoryOptions) => WebSocketLike | Promise<WebSocketLike>;
  readonly signal?: AbortSignal;
  readonly initialize?: InitializeParams;
  readonly headers?: Readonly<Record<string, string>>;
}
export interface LogsSubscription { readonly result: LogsResult; readonly stream: LogsSubscriptionStream; }
export interface AgentAttachSubscription { readonly result: AgentAttachResult; readonly stream: AgentAttachSubscriptionStream; }
export interface CoherentWatchSubscription extends WatchSubscription { readonly snapshot: GetResult; }
export interface ConnectInitializedResult {
  readonly connection: Connection;
  readonly client: ClusterClient;
  readonly initializeResult: InitializeResult;
}

export class ClusterClient {
  constructor(readonly connection: Connection) {}
  async initialize(
    params: InitializeParams = { protocolVersion: PROTOCOL_VERSION },
    options?: CallOptions,
  ): Promise<InitializeResult> {
    const result = await this.connection.call('initialize', params, options);
    if (result.protocolVersion !== params.protocolVersion || result.protocolVersion !== PROTOCOL_VERSION) {
      throw new ClusterProtocolError(
        `protocol version mismatch: requested ${params.protocolVersion}, received ${result.protocolVersion}`,
        'UNSUPPORTED_PROTOCOL_VERSION',
      );
    }
    return result;
  }
  plan(params: PlanParams, options?: CallOptions): Promise<PlanResult> {
    return this.connection.call('plan', params, options);
  }
  apply(params: ApplyParams, options?: CallOptions): Promise<ApplyResult> {
    return this.connection.call('apply', params, options);
  }
  update(params: UpdateParams, options?: CallOptions): Promise<UpdateResult> {
    return this.connection.call('update', params, options);
  }
  stop(params: StopParams, options?: CallOptions): Promise<StopResult> {
    return this.connection.call('stop', params, options);
  }
  retry(params: RetryParams, options?: CallOptions): Promise<RetryResult> {
    return this.connection.call('retry', params, options);
  }
  resubmit(params: ResubmitParams, options?: CallOptions): Promise<ResubmitResult> {
    return this.connection.call('resubmit', params, options);
  }
  delete(params: DeleteParams, options?: CallOptions): Promise<DeleteResult> {
    return this.connection.call('delete', params, options);
  }
  get(params: GetParams = {}, options?: CallOptions): Promise<GetResult> {
    return this.connection.call('get', params, options);
  }
  async watch(
    params: WatchParams = {},
    options?: CallOptions,
  ): Promise<WatchSubscription> {
    const established = await this.connection.openSubscription('watch', params, options);
    return {
      result: established.result,
      stream: new WatchSubscriptionStream({
        connection: this.connection,
        registration: established.registration,
        result: established.result,
        params,
      }),
    };
  }
  async watchColdStart(
    params: Omit<WatchParams, 'fromCursor'> = {},
    options?: CallOptions,
  ): Promise<CoherentWatchSubscription> {
    const snapshot = await this.get({}, options);
    const watch = await this.watch({
      ...params,
      ...(snapshot.atCursor === undefined ? {} : { fromCursor: snapshot.atCursor }),
    }, options);
    return { snapshot, ...watch };
  }
  async logs(params: LogsParams = {}, options?: CallOptions): Promise<LogsSubscription> {
    const established = await this.connection.openSubscription('logs', params, options);
    return {
      result: established.result,
      stream: new LogsSubscriptionStream(this.connection, established.registration),
    };
  }
  async agentAttach(
    params: AgentAttachParams,
    options?: CallOptions,
  ): Promise<AgentAttachSubscription> {
    const established = await this.connection.openSubscription('agent/attach', params, options);
    return {
      result: established.result,
      stream: new AgentAttachSubscriptionStream(this.connection, established.registration),
    };
  }
}

async function defaultWebSocketFactory(
  url: string,
  protocols?: string | readonly string[],
  options?: WebSocketFactoryOptions,
): Promise<WebSocketLike> {
  const globalWebSocket = (globalThis as {
    readonly WebSocket?: new (
      url: string,
      protocols?: string | readonly string[],
    ) => WebSocketLike;
  }).WebSocket;
  if (globalWebSocket && (!options?.headers || Object.keys(options.headers).length === 0)) {
    return new globalWebSocket(url, protocols);
  }
  try {
    const imported: unknown = await import('ws');
    const candidate = imported !== null && typeof imported === 'object' && 'default' in imported
      ? imported.default
      : imported;
    if (typeof candidate !== 'function') {
      throw new TypeError("The installed 'ws' module does not export a WebSocket constructor");
    }
    const Constructor = candidate as new (
      url: string,
      protocols?: string | readonly string[],
      options?: { readonly headers?: Readonly<Record<string, string>> },
    ) => WebSocketLike;
    return options?.headers ? new Constructor(url, protocols, { headers: options.headers }) : new Constructor(url, protocols);
  } catch (cause) {
    throw new ClusterConfigError(
      "No WebSocket runtime is available; install 'ws' or pass webSocketFactory",
      'WEBSOCKET_UNAVAILABLE',
      { cause },
    );
  }
}

async function waitForOpen(socket: WebSocketLike, signal?: AbortSignal): Promise<void> {
  if (socket.readyState === 1) return;
  if (socket.readyState !== 0) {
    throw new ClusterTransportError('WebSocket is already closing or closed', 'OPEN_FAILED');
  }
  if (signal?.aborted) throw new DOMException(
    'connect aborted locally; the server may still have committed this request',
    'AbortError',
  );
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const removers: Array<() => void> = [];
    let upgradeFailure: ClusterUpgradeError | ClusterTransportError | undefined;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      for (const remove of removers) remove();
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => settle(() => reject(new DOMException(
      'connect aborted locally; the server may still have committed this request',
      'AbortError',
    )));
    const onUnexpectedResponse = (...args: unknown[]) => {
      const response = args.find(
        (value) => value !== null && typeof value === 'object' && 'statusCode' in value,
      ) as { statusCode?: unknown; resume?: () => void } | undefined;
      const status = response?.statusCode;
      upgradeFailure = typeof status === 'number'
        ? new ClusterUpgradeError(status)
        : new ClusterTransportError('WebSocket upgrade rejected', 'UPGRADE_REJECTED');
      response?.resume?.();
      if (socket.terminate) {
        socket.terminate();
      } else {
        settle(() => reject(upgradeFailure));
      }
    };
    removers.push(
      addSocketListener(socket, 'open', () => settle(resolve)),
      addSocketListener(socket, 'error', (error) => settle(() => reject(
        upgradeFailure ??
          new ClusterTransportError('WebSocket failed to open', 'OPEN_FAILED', { cause: error }),
      ))),
      addSocketListener(socket, 'close', () => settle(() => reject(
        upgradeFailure ??
          new ClusterTransportError('WebSocket closed before opening', 'OPEN_FAILED'),
      ))),
      addSocketEmitterListener(socket, 'unexpected-response', onUnexpectedResponse),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function disposeFailedSocket(socket: WebSocketLike): Promise<void> {
  if (socket.readyState === 0 && socket.terminate) {
    socket.terminate();
  } else {
    await socket.close();
  }
}

export async function connect(url: string, options: ConnectOptions = {}): Promise<Connection> {
  const factory = options.webSocketFactory ?? defaultWebSocketFactory;
  let socket: WebSocketLike | undefined;
  try {
    socket = await factory(url, options.protocols, options.headers ? { headers: options.headers } : undefined);
    await waitForOpen(socket, options.signal);
    const connection = new Connection(socket);
    await new ClusterClient(connection).initialize(
      options.initialize,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    return connection;
  } catch (error) {
    if (socket) {
      try { await disposeFailedSocket(socket); }
      catch { /* preserve the construction error */ }
    }
    throw error;
  }
}

export async function connectInitialized(url: string, options: ConnectOptions = {}): Promise<ConnectInitializedResult> {
  const factory = options.webSocketFactory ?? defaultWebSocketFactory;
  let socket: WebSocketLike | undefined;
  try {
    socket = await factory(url, options.protocols, options.headers ? { headers: options.headers } : undefined);
    await waitForOpen(socket, options.signal);
    const connection = new Connection(socket);
    const client = new ClusterClient(connection);
    const initializeResult = await client.initialize(
      options.initialize,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    return { connection, client, initializeResult };
  } catch (error) {
    if (socket) {
      try { await disposeFailedSocket(socket); }
      catch { /* preserve the construction error */ }
    }
    throw error;
  }
}
