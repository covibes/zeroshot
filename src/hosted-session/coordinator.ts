import {
  ClusterConfigError,
  ClusterUpgradeError,
  connectInitialized,
  type ServerCapabilities,
  type GraphProfile,
  type WatchSubscription,
  type WatchSubscriptionItem,
} from '../cluster/index.js';
import type {
  HostedAccess,
  HostedSessionInit,
  HostedWatch,
  HostedWatchOptions,
  InitializedSession,
} from './types.js';

export class HostedAuthenticationError extends Error {
  constructor() {
    super('Hosted target authentication failed');
    this.name = 'HostedAuthenticationError';
  }
}

export class HostedAuthorizationError extends Error {
  constructor() {
    super('Hosted target authorization was revoked');
    this.name = 'HostedAuthorizationError';
  }
}

export class HostedTransportUncertainError extends Error {
  readonly executionRetryAuthorized = false;
  constructor() {
    super('Hosted session transport closed with uncertain execution state');
    this.name = 'HostedTransportUncertainError';
  }
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const defined = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (defined.length === 0) return undefined;
  if (defined.length === 1) return defined[0];
  return AbortSignal.any(defined);
}

function normalizedAuthority(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ClusterConfigError(
      'targetAuthority must be an HTTPS origin',
      'INVALID_TARGET_AUTHORITY'
    );
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new ClusterConfigError(
      'targetAuthority must be an HTTPS origin',
      'INVALID_TARGET_AUTHORITY'
    );
  }
  return url.origin;
}

class ReconnectingHostedWatch implements HostedWatch {
  readonly #coordinator: HostedSessionCoordinator;
  readonly #signal: AbortSignal | undefined;
  #session: InitializedSession;
  #subscription: WatchSubscription;
  #reconnected = false;
  #cancelled = false;

  constructor(
    coordinator: HostedSessionCoordinator,
    session: InitializedSession,
    subscription: WatchSubscription,
    signal?: AbortSignal
  ) {
    this.#coordinator = coordinator;
    this.#session = session;
    this.#subscription = subscription;
    this.#signal = signal;
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  async next(): Promise<IteratorResult<WatchSubscriptionItem>> {
    if (this.#cancelled) return { done: true, value: undefined };
    const item = await this.#subscription.stream.next();
    if (!item.done) return item;
    if (this.#session.connection.state === 'OPEN') {
      await this.#session.connection.close();
      return item;
    }
    const closed = await this.#session.connection.closed;
    if (closed.code === 4401 && !this.#reconnected) {
      this.#reconnected = true;
      const replacement = await this.#coordinator.replace(this.#signal);
      this.#subscription = await this.#subscription.stream.reconnect(replacement.connection);
      this.#session = replacement;
      return this.next();
    }
    if (closed.code === 4403) throw new HostedAuthorizationError();
    if (closed.code === 1000) return item;
    throw new HostedTransportUncertainError();
  }

  async return(): Promise<IteratorResult<WatchSubscriptionItem>> {
    await this.cancel();
    return { done: true, value: undefined };
  }

  async throw(error?: unknown): Promise<IteratorResult<WatchSubscriptionItem>> {
    await this.cancel();
    throw error;
  }

  async cancel(): Promise<void> {
    if (this.#cancelled) return;
    this.#cancelled = true;
    await this.#subscription.stream.cancel();
    await this.#session.connection.close();
  }
}

export class HostedSessionCoordinator {
  readonly #init: HostedSessionInit;
  readonly #targetAuthority: string;
  readonly #clock: { now(): number };
  readonly #closeController = new AbortController();
  readonly #sessions = new Set<InitializedSession>();
  #referenceCapabilities: ServerCapabilities | undefined;
  #closed = false;

  constructor(init: HostedSessionInit) {
    if (init.capsuleId.length === 0)
      throw new ClusterConfigError('capsuleId must not be empty', 'INVALID_CAPSULE_ID');
    this.#init = init;
    this.#targetAuthority = normalizedAuthority(init.targetAuthority);
    this.#clock = init.clock ?? Date;
  }

  async open(signal?: AbortSignal): Promise<InitializedSession> {
    this.#requireNotClosed();
    const session = await this.#createSession(signal);
    this.#referenceCapabilities = session.initializeResult.capabilities;
    return session;
  }

  async replace(signal?: AbortSignal): Promise<InitializedSession> {
    this.#requireNotClosed();
    const session = await this.#createSession(signal);
    try {
      if (this.#referenceCapabilities !== undefined) {
        this.#verifyCapabilities(
          this.#referenceCapabilities,
          session.initializeResult.capabilities
        );
      }
      return session;
    } catch (error) {
      await session.connection.close();
      throw error;
    }
  }

  async watch(options: HostedWatchOptions): Promise<HostedWatch> {
    const session = await this.open(options.signal);
    try {
      const subscription = await session.client.watch(
        options.params,
        options.signal === undefined ? {} : { signal: options.signal }
      );
      const hosted = new ReconnectingHostedWatch(this, session, subscription, options.signal);
      options.signal?.addEventListener(
        'abort',
        () => {
          void hosted.cancel();
        },
        { once: true }
      );
      return hosted;
    } catch (error) {
      await session.connection.close();
      throw error;
    }
  }

  renewalDeadline(access: HostedAccess, receivedAt: number): number {
    const expiresAt = Date.parse(access.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= receivedAt) {
      throw new ClusterConfigError(
        'access expiry must be a future RFC 3339 timestamp',
        'INVALID_ACCESS_EXPIRY'
      );
    }
    const lifetime = expiresAt - receivedAt;
    const lead = Math.max(5_000, Math.min(60_000, Math.floor(lifetime * 0.1)));
    return Math.max(receivedAt, expiresAt - lead);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeController.abort(new DOMException('coordinator closed', 'AbortError'));
    const sessions = [...this.#sessions];
    await Promise.all(sessions.map((session) => session.connection.close()));
    this.#sessions.clear();
  }

  async #createSession(signal?: AbortSignal): Promise<InitializedSession> {
    const combined = combineSignals([signal, this.#closeController.signal]);
    const access = await this.#init.adapter.access(this.#init.capsuleId, combined);
    this.#validateAccess(access);
    const receivedAt = this.#clock.now();
    this.renewalDeadline(access, receivedAt);
    try {
      const session = await connectInitialized(access.websocketUrl, {
        ...this.#init.connectOptions,
        headers: { Authorization: `Bearer ${access.accessToken}` },
        ...(combined === undefined ? {} : { signal: combined }),
      });
      this.#sessions.add(session);
      void session.connection.closed.then(() => this.#sessions.delete(session));
      return session;
    } catch (error) {
      if (error instanceof ClusterUpgradeError && error.status === 401)
        throw new HostedAuthenticationError();
      throw error;
    }
  }

  #validateAccess(access: HostedAccess): void {
    let endpoint: URL;
    try {
      endpoint = new URL(access.websocketUrl);
    } catch {
      throw new ClusterConfigError(
        'access endpoint must be an absolute WSS URL',
        'INVALID_ACCESS_ENDPOINT'
      );
    }
    const endpointAuthority = `https://${endpoint.host}`;
    if (
      endpoint.protocol !== 'wss:' ||
      endpointAuthority !== this.#targetAuthority ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw new ClusterConfigError(
        'access endpoint must remain on the target WSS authority',
        'INVALID_ACCESS_ENDPOINT'
      );
    }
    if (
      access.protocol !== 'openengine.cluster/v1' ||
      access.tokenType !== 'Bearer' ||
      access.accessToken.length === 0
    ) {
      throw new ClusterConfigError(
        'access grant does not match the hosted session contract',
        'INVALID_ACCESS_GRANT'
      );
    }
  }

  #verifyCapabilities(reference: ServerCapabilities, incoming: ServerCapabilities): void {
    const referenceProfiles = new Set<GraphProfile>(reference.graphProfiles);
    const incomingProfiles = new Set<GraphProfile>(incoming.graphProfiles);
    if (
      (reference.logs && !incoming.logs) ||
      (reference.agentAttach && !incoming.agentAttach) ||
      [...referenceProfiles].some((profile) => !incomingProfiles.has(profile))
    ) {
      throw new ClusterConfigError(
        'replacement connection removed required server capabilities',
        'CAPABILITY_REGRESSION'
      );
    }
  }

  #requireNotClosed(): void {
    if (this.#closed) throw new ClusterConfigError('coordinator is closed', 'COORDINATOR_CLOSED');
  }
}
